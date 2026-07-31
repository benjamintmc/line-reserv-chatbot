# ADR-004: 資料層由 SQLite 移植至 Neon Postgres、運算改 Cloud Run（serverless）

- 狀態：已採納（設計待 D-007 APPROVED 後由 T-012 實作落地）
- 日期：2026-07-31
- 決策者：architect（審查：architect-reviewer；風險 R2）
- 相關：CLAUDE.md §0（部署目標／「無持久磁碟平台可切換 PostgreSQL」）、`docs/deployment.md` §5（目標架構草案，本 ADR 之設計來源）、ADR-002（防超賣併發策略）、ADR-003（better-sqlite3 版本 pin）、設計文件 D-007（移植與 serverless 部署設計）。

## 背景與動機

MVP 以 SQLite（better-sqlite3）+ 常駐機為資料與運算模型（D-001、ADR-002）。`docs/deployment.md` §1 已證實：**訊息量不是瓶頸**（bot 只用 reply，不吃 LINE 200 則 push 額度），真正的成本是「一台能持久存 SQLite 檔的主機」。Fly.io + Volume 雖零程式改動，但已無真免費（約 US$2–5/月）。

使用者於 M5 選定 **$0/月** 部署目標：**Cloud Run（每月 2M requests 免費 + CPU/記憶體免費額度）+ Neon（免費 serverless Postgres，0.5GB + autosuspend + 內建連線 pooler）**。此組合在 MVP 量級（§1.2 估 ~7 萬 requests/月/百群）實質 $0，且無需持久磁碟、可水平擴縮。代價是一次性把資料層由 SQLite 移植到 Postgres，並把「回 200 後才處理」的常駐機時序改為 serverless 安全時序。

## 決策

1. **資料庫**：由 SQLite（better-sqlite3，本機檔 + 持久磁碟）移植至 **Neon Postgres**，以 **pooled 連線字串**存取，驅動採 `pg`（node-postgres，純 JS）。
2. **運算**：由常駐 Fastify 進程改為 **Cloud Run 容器**（`min-instances=0`，serverless）。
3. **併發防超賣**：由 SQLite `BEGIN IMMEDIATE` 全域序列化，改為 PG 交易內 **`SELECT … FROM events WHERE id=? FOR UPDATE`** 鎖住該活動列（只序列化同一場活動的併發報名，跨活動可平行 → 併發性更佳，正確性等義）。
4. **serverless 時序**：webhook 由「回 200 後才 `await` 處理 + `replyMessage`」改為「**先 `await` 完整處理（含 `replyMessage`）再回 200**」（Cloud Run 於回應送出後可能凍結／回收實例，舊時序會漏送回覆）。
5. **驅動移除**：prod 不再需要 better-sqlite3 native 相依（cold start 更快、無 native build）。

移植的完整可執行設計（改哪些檔、PG 方言差異、連線池、Dockerfile、部署步驟）見 **D-007**。本 ADR 只記錄決策與取捨。

## 理由與被放棄的替代方案

| 方案 | 優點 | 缺點 | 結果 |
|---|---|---|---|
| **Cloud Run + Neon(PG)** | $0/月（MVP 量級）、無持久磁碟、可擴縮、managed 備份、PG 純 JS 驅動冷啟快 | 一次性移植成本（repository 重寫、併發模型改、serverless 時序改） | **採納** |
| Fly.io + Volume（保留 SQLite） | 零程式改動、固定 HTTPS 網址、SQLite 對 MVP 足夠 | 已無真免費（~US$2–5/月）；單檔單寫入者不利多實例水平擴展 | 放棄（不符 $0 目標） |
| Oracle Cloud Always Free VM + SQLite | 真免費常駐、零程式改動 | 需自管 Linux／反向代理／TLS／備份；維運負擔與「週末迭代」尺度不符 | 放棄（維運過重） |
| Vercel + Neon(PG) | 已用 Vercel 生態者友善 | serverless function 對「webhook 需在回應前把事情做完」的控制力較 Cloud Run 差；仍要移植 PG | 放棄（Cloud Run 控制力較佳） |

**取捨核心**：以「一次性移植工程」換「長期 $0 + 可擴展 + managed 維運」。移植風險集中在**防超賣正確性**（IMMEDIATE → FOR UPDATE，且交易內查詢須同連線）與 **serverless 時序**（先處理再回 200），兩者皆屬 R2，於 D-007 以 Guardrails 與 Acceptance Checks 收斂。

## 影響

- **正面**：達成 $0/月；無持久磁碟依賴；PG 行鎖只序列化同場報名 → 併發性優於 SQLite 全域鎖；managed 備份／時間點還原／跨區；prod 移除 native addon → cold start 快、Dockerfile 精簡。
- **負面／風險**：
  - **repository 需重寫**為 PG（對外方法名／參數／回傳語意**不變**，但 better-sqlite3 同步 → `pg` 非同步，**全層 sync→async 機械傳播**至 domain 與測試——邏輯與 AC 期望值不變，僅加 `async`/`await`）。此範圍較 deployment.md §5.2「domain 零改」的樂觀措辭為大，D-007 已據實界定。
  - **併發正確性陷阱**：pool 模式下若交易內各查詢落在不同連線，`FOR UPDATE` 失效 → **靜默超賣**。D-007 以「交易內所有查詢綁同一 checked-out client」為 Guardrail 強制。
  - **serverless 時序**：未改為「先處理再回 200」會漏送回覆。
  - **連線爆炸**：多實例 × 每實例連線需以 Neon pooler + 小 pool（max ≤2）防治。

## 與既有 ADR 的關係

- **延伸 ADR-002（防超賣併發策略）**：ADR-002 的目標（報名寫入序列化、防超賣、取消觸發遞補同受交易保護）不變；**僅機制由 SQLite `BEGIN IMMEDIATE` 換為 PG 交易 + `SELECT … FOR UPDATE` 該 event 列**。D-001 §二 G2 早已預留「IMMEDIATE（SQLite）/ 列鎖 `FOR UPDATE`（PostgreSQL）」雙軌措辭；本 ADR 使 PG 軌成為 prod 的實際實作。G2 carve-out（主辦自動登記首列在 DEFERRED 交易內盲插）於 PG 對應 `BEGIN … COMMIT`（無 FOR UPDATE），其「event 提交前不存在、無並行 signup」的論證在 PG 同樣成立，carve-out 保留。
- **收斂 ADR-003（better-sqlite3 版本 pin）**：ADR-003 僅約束 SQLite 路徑的 native 二進位相容性。走本 ADR（PG-only prod）後，**better-sqlite3 不再適用於 production**；`pg` 為純 JS、無 native ABI 問題，其版本策略另議、不受 ADR-003 約束。若採 D-007 OP-1 的 dual-driver（本機/測試保留 SQLite），ADR-003 仍約束該本機路徑；若採 PG-only，ADR-003 對 prod 失效、僅為歷史紀錄。
