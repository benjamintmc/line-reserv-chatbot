# 部署指南與免費額度分析（Deployment）

> 擁有者：orchestrator / architect。本文件為部署決策與操作 SOP 的人讀視圖。
> 涉及「切換資料庫驅動（SQLite → Postgres）」屬重大技術決策，正式落實時須開 **ADR-004** 一事一檔（見文末）。
> 相關：CLAUDE.md §0（部署目標 / DB 可切換 PG）、ADR-002（SQLite 併發）、ADR-003（better-sqlite3 版本 pin）。

---

## 0. TL;DR（先看這裡）

| 面向 | 結論 |
|---|---|
| **訊息量限制** | 幾乎無上限。bot 只用 **reply**（回應使用者），LINE **reply 不計費、不扣免費 200 則額度**；200 則僅算 **push（主動推播）**，本專案目前零 push。 |
| **真正的成本** | 不是訊息費，是「一台能持久存 SQLite 的主機」。 |
| **MVP 最省力** | **Fly.io + Volume**（保留 SQLite、零程式改動、固定 HTTPS 網址）。約 US$2–5/月。 |
| **未來真免費** | **Cloud Run + Neon(PG)**（$0/月，Cloud Run 每月 2M requests 免費 + Neon 免費 PG），代價是一次性把資料層從 SQLite 移植到 Postgres。見 §5。 |
| **部署前必修 bug** | `tsc` 不複製 `migrations/*.sql` 到 `dist/`，生產 migrate 會失敗（見 §6）。 |

---

## 1. 免費額度下能服務多少訊息量/月

### 1.1 LINE 平台（計費層）—— 不是瓶頸

LINE 官方帳號免費（輕用量）方案：**每月 200 則**額度，但**只算「主動發送 push」**。

| 訊息類型 | 本專案用到? | 免費額度 |
|---|---|---|
| 接收 webhook（使用者發言） | ✅ 每則 | 免費、無上限 |
| **回覆訊息 reply**（bot 回話，含 @遞補通知） | ✅ 每則 | **免費、無上限（不扣 200）** |
| 主動推播 push / broadcast / multicast | ❌ 目前不用 | 200 則/月 |

> 本專案所有回覆都經 `replyMessage`（回應使用者指令），連遞補 @mention 都是 reply 追加訊息（D-003 §4 設計），**零 push** → **不受 200 則限制**。

**唯一未來會吃 push 額度的情境**：加「主動提醒」（如活動前一天自動推播）。屆時 200 則/月 ≈ 1 個群每月數次提醒，要更多需升級（中用量 NT$800/3000 則、高用量 NT$1200/6000 則）。

### 1.2 主機運算（compute 層）—— 遠超實際需求

每則訊息成本：驗簽 + JSON parse + regex parseCommand + 幾個 SQLite prepared statement（better-sqlite3 同步、單筆 <1ms）+ 1 個 reply API 呼叫 ≈ **5–15ms CPU、記憶體 KB 級**。

單一最小常駐機（256MB shared-CPU）保守估 **20 則/秒**：

```
20 則/秒 × 3600 × 24 × 30 ≈ 每月 5,000 萬則（理論滿載上限）
```

**對照真實使用量：**

| 情境 | 估算 | 佔單機容量 |
|---|---|---|
| 1 個 30 人球團，每月 3 場，每人每場 ~8 則 | ~700 則/月 | <0.01% |
| 100 個球團 | ~7 萬則/月 | <1% |
| 打滿單機 | 需 ~7 萬個活躍球團同時用 | 100%（不切實際） |

### 1.3 結論

> **只用 reply 的設計，讓你在 LINE 免費方案 + 一台最小常駐機下，訊息量實質為「每月數百萬則」等級，遠超任何真實球團需求。**

Sources：[LINE Biz 訊息計價](https://tw.linebiz.com/faq/oa-price/message-price-list/)、[2026 LINE OA 方案總整理](https://www.anyong.com.tw/37452)

---

## 2. 部署選項比較

| 平台 | 免費? | 能持久存 SQLite? | 改動成本 | 適用 |
|---|---|---|---|---|
| **Fly.io + Volume** | ⚠️ 已無真免費，小用量 ~US$2–5/月 | ✅ | **零**（保留 SQLite） | ⭐ MVP 首選 |
| Render 免費方案 | ✅ | ❌ 會休眠 + 無持久磁碟，資料會掉 | 零 | ❌ 不適合有狀態服務 |
| Render 付費 + Disk | ❌ 需付費方案 | ✅ | 零 | 想要 GitHub 自動部署 |
| Oracle Cloud Always Free VM | ✅ 真免費常駐 | ✅ | 零（但自管 Linux/反代/TLS） | 願意自管、要零成本 |
| **Cloud Run + Neon/Supabase(PG)** | ✅ $0/月（MVP 量級） | ✅（外部 PG） | **中**（移植資料層） | ⭐ 未來真免費 + 可擴展（見 §5） |
| Vercel + Neon/Supabase(PG) | ✅ | ✅（外部 PG） | 中 + serverless 限制 | 已用 Vercel 生態者 |

---

## 3. MVP 部署路徑：Fly.io + SQLite（最省力）

保留現有 SQLite，唯一改動是修 §6 的 migration 複製問題。

### 步驟
1. 修 §6（migrations 複製到 dist）。
2. 寫 `Dockerfile`（Node 20+、`npm ci`、`npm run build`、`CMD node dist/index.js`）。better-sqlite3 native build：多階段 build，或用官方 node image 內建 build tools。
3. `fly launch`（產生 `fly.toml`），設 `internal_port = 3000`、health check 指 `/health`。
4. `fly volumes create data --size 1`（1GB 綽綽有餘），掛載到容器內某路徑（如 `/data`）。
5. 設 secrets：`fly secrets set LINE_CHANNEL_SECRET=… LINE_CHANNEL_ACCESS_TOKEN=… ADMIN_USER_IDS=… DATABASE_PATH=/data/golf.db`（`DEBUG_WEBHOOK` 不設＝關）。
6. `fly deploy` → 取得固定網址 `https://<app>.fly.dev`。
7. LINE Console Webhook URL 設 `https://<app>.fly.dev/webhook`（一次設定、永久有效，**取代 cloudflared**）。

### 通用部署 checklist（任何平台）
- [ ] 環境變數：`LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `DATABASE_PATH`（指向持久磁碟）/ `ADMIN_USER_IDS`；`DEBUG_WEBHOOK` 留空。
- [ ] 持久磁碟已掛載、SQLite 檔在上面。
- [ ] 啟動時自動 migrate（程式已內建 `runMigrations`；先修 §6）。
- [ ] 平台 HTTPS 固定網址 → LINE Webhook URL。
- [ ] 健康檢查 → `/health`。

---

## 4. 何時該從 SQLite 升級到 Postgres？

觸發條件（任一）：
- 想要 **$0/月**（走 Cloud Run + Neon 免費組合）。
- 想用 **serverless / 自動擴縮**（無狀態、CPU 隨請求配置）。
- 需要**多實例水平擴展**（SQLite 單檔單寫入者，多實例共用一個 SQLite 檔不安全）。
- 需要 managed 備份、時間點還原、跨區。

在此之前，Fly.io + SQLite 對 MVP 完全夠用。

---

## 5. 未來遷移路徑：Cloud Run / Vercel + Supabase/Neon(PG)（**本文件定義的目標架構**）

### 5.1 推薦目標技術棧

| 元件 | 選擇 | 理由 |
|---|---|---|
| **運算** | **Cloud Run**（優先於 Vercel） | 容器化、對「webhook 需在回 200 前把事情做完」的模型控制力較好；`min-instances=0` 省成本；每月 **2M requests 免費** + CPU/記憶體免費額度，MVP 量級 = $0。 |
| **資料庫** | **Neon**（優先於 Supabase） | serverless Postgres、免費方案 0.5GB + autosuspend、內建連線 pooler；純 DB 需求下比 Supabase 精簡。若日後要 auth/storage 再考慮 Supabase。 |
| **PG 驅動** | `pg`（node-postgres）或 `postgres`（porsager） | 成熟、支援 pooler 連線字串。 |
| **Migration** | `node-pg-migrate` 或純 SQL 於部署時執行 | 取代現有 SQLite migration runner。 |

> Cloud Run 免費請求額度（2M/月）遠超本 bot 用量（§1.2 估 ~7 萬/月/百群），故此組合 MVP 量級**實質 $0/月**。

### 5.2 什麼會改、什麼不會（架構紅利）

D-001 刻意採 **repository pattern**，domain/handler/formatter **不直接下 SQL（Guardrail G10）**。因此移植 PG：

- ✅ **不動**：`src/domain/*`（registration-service / roster / list-formatter / 未來 event-service）、`src/webhook/handler.ts`、`src/commands/*`、所有商業邏輯與 AC 測試的斷言。
- 🔧 **要改**：只有「資料層驅動」——
  - `src/db/index.ts`（連線：better-sqlite3 → pg pool）
  - `src/db/repositories/*.ts`（實作改用 PG 查詢；**介面簽名不變**）
  - `src/db/migrations/*.sql`（SQLite dialect → PG dialect）
  - `src/db/migrate.ts`（migration runner）
  - `RegistrationRepository.runImmediate` 的併發語意（見 5.3）

> 因為 repository 介面不變、domain 零耦合，理想上 domain 測試可原樣重跑（改對 PG 測試庫），是這套分層的最大回報。

### 5.3 併發防超賣：SQLite `BEGIN IMMEDIATE` → PG 的等價做法（**移植最關鍵處**）

- 現況（ADR-002 / D-001 G2）：`runImmediate` 用 SQLite `BEGIN IMMEDIATE` 全域單寫入者序列化，`countConfirmed → 整批決策 → insertSlots` 原子化防超賣。
- **PG 等價（更好）**：在交易內對**該活動列上行鎖**——
  ```sql
  BEGIN;
  SELECT id FROM events WHERE id = $1 FOR UPDATE;   -- 鎖住這場活動
  -- 於鎖內：count confirmed → 整批決策 → insert slots / cancel / promote
  COMMIT;
  ```
  只序列化「同一場活動」的併發報名，不同活動可平行 → 比 SQLite 全域鎖**併發性更佳**。
- `runImmediate(fn)` 的抽象保留：PG 版改為「開交易 → `SELECT … FOR UPDATE` 該 event → 執行 fn → commit/rollback」。domain 呼叫端不變。
- 去重 `processed_events`：概念不變，PG 唯一鍵 + 交易內 `INSERT … ON CONFLICT DO NOTHING` 判斷是否重送。

### 5.4 Serverless 的三個陷阱（**必處理，否則上線出錯**）

1. **「回 200 後才做事」會被凍結** ⚠️ 最重要
   - 現況 `server.ts`：`reply.code(200).send()` 後才 `await handleEvent + replyMessage`。在 **常駐機（Fly）可行**；但 **Cloud Run 預設「CPU 僅於請求期間配置」**，回應送出後實例可能被凍結/回收 → 回覆可能**不會送出**。
   - **修法**：serverless 版改為**先把事情做完再回 200**——`await 處理(含 replyMessage)` → 然後 `reply.code(200)`。單則工作 ~5–15ms + 1 次 reply API（~200–500ms），遠在 LINE webhook timeout 內，安全。
   - （或 Cloud Run 設 `min-instances≥1` + CPU always allocated，但那就不是純 serverless / 省成本模型。）

2. **連線數爆炸 → 用 pooler**
   - serverless 會開很多實例 → 很多 PG 連線 → 撞 Postgres 連線上限。
   - **必用 Neon/Supabase 的 pooler 連線字串**（PgBouncer），每實例維持極小連線池（如 `max: 1–2`）。

3. **冷啟動 vs reply token 時效**
   - LINE reply token 有效期約 1 分鐘；Cloud Run 冷啟動通常 1–3s，安全。惟 native 相依若太重會拉長冷啟動——PG 驅動（純 JS 的 `pg`）比 better-sqlite3（native）**更適合 serverless**（無 native build、冷啟快）。

### 5.5 Migration dialect 差異（SQLite → PG）

| SQLite | PostgreSQL |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `GENERATED ALWAYS AS IDENTITY` / `BIGSERIAL` |
| 布林存 `0/1` | 原生 `BOOLEAN`（或維持 smallint 相容既有 schema 型別） |
| `datetime('now')` / TEXT 時間 | `timestamptz` + `now()`（或維持 TEXT ISO 相容 D-001「顯示文字」語意） |
| partial unique index（`WHERE …`） | PG 亦支援 partial index，語法近似；`ux_events_active_group` 可直接對應 |
| `INSERT … ON CONFLICT … DO UPDATE` | PG 同樣支援（語法相容） |

> 建議：移植時**盡量保持欄位語意不變**（D-001 的 snapshot / soft-delete / seq 語意照舊），只換型別與 runner，降低 domain 影響面。

### 5.6 分階段移植計畫（一次性工程，建議獨立里程碑 M6 或 M5 分支）

1. **抽象確認**：盤點 repository 介面（已具備），確保 domain 對 db 具體型別零依賴（現況符合 G10）。
2. **新增 PG 驅動層**：`src/db` 加 PG 連線（pooler）、`migrate`、PG dialect 的 migration SQL；以環境變數 `DATABASE_URL`（PG）vs `DATABASE_PATH`（SQLite）切換（config 併容——已列 D-003 Backlog）。
3. **重寫 repository 為 PG 版**（介面不變）；`runImmediate` → `SELECT … FOR UPDATE`（5.3）。
4. **測試**：domain/AC 測試改對 PG 測試庫重跑（Neon 分支 DB 或本機 docker postgres）；補併發測試（FOR UPDATE 序列化）。
5. **handler/server serverless 化**：改「先處理再回 200」（5.4-1）；容器化 `Dockerfile` for Cloud Run。
6. **部署**：Neon 建 DB + 取 pooled `DATABASE_URL`；Cloud Run 部署（`min-instances=0`）；LINE Webhook URL 指向 Cloud Run 網址。
7. **切換**：小量灰度 → 觀察 → 正式切；SQLite 資料如需保留可寫一次性匯出/匯入腳本。
8. **開 ADR-004** 記錄此決策與取捨。

### 5.7 成本（MVP 量級）

| 元件 | 免費額度 | 本 bot 是否夠 |
|---|---|---|
| Cloud Run | 2M requests/月 + CPU/記憶體免費額度 | ✅ 遠遠夠（~7 萬/月/百群） |
| Neon | 0.5GB 儲存 + autosuspend | ✅ 資料極小 |
| **合計** | **$0/月** | ✅ |

---

## 6. 部署前必修 bug（M5 Backlog）

`npm run build`（tsc）**不會**把 `src/db/migrations/*.sql` 複製到 `dist/`，故生產跑 `node dist` 時 `runMigrations` 找不到 SQL 檔而失敗（開發用 tsx/vitest 不受影響）。

**三選一**：
1. build 後加 copy script（`postbuild` 複製 `src/db/migrations` → `dist/db/migrations`）。
2. 生產改以 tsx 跑 migrate。
3. 將 `.sql` 內嵌為字串 import（TS 檔）。

> 走 §5 PG 路線時，此問題隨 migration runner 改寫一併處理。

---

## 7. ADR 待辦

- **ADR-004（未落實）**：「切換資料庫由 SQLite 至 Postgres + serverless 部署」。真正決定要走 §5 時，由 architect 開 ADR-004 記錄決策、取捨（併發模型改 FOR UPDATE、serverless 回 200 時序、pooler 連線）、與回滾方案。本文件 §5 為其設計草案來源。
