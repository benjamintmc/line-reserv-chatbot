# 資安觀察盤點（2026-08-22）

> 擁有者：orchestrator。**全數暫緩**（使用者裁決 2026-08-22：排入 Backlog，非急件）。
> 對象為 PROD LIVE 的架構（Cloud Run `asia-east1` + Neon PG，image `:v3` / revision `00003-7lc`）。
> 本文件是 Backlog 的細節容器——task-board 只留一行指標（doc-budget ≤80 行）。
> 每項附**落點**與**動工前必讀**，供日後接手者直接開任務單，不必重跑一次盤點。

> **編號說明**：沿用 2026-08-22 對話中的原始標號以利對照。**沒有 M1**——當時高疑慮標為 `H1`，
> 中疑慮直接從 `M2` 起編。這是編號習慣不一致，**不是遺漏項目**，請勿再去尋找 M1。
> 全部項目共 12 條：H1、M2–M7、L1–L5。

## 動工前的通則

- 各項**彼此獨立、不得夾帶**（LESSONS「審查包 diff 範圍不全」已累計 2 次）。一項一任務一 PR。
- 碰 `src/domain/registration-service.ts`、`src/domain/event-service.ts`、`src/db/migrations/` 者一律 **R2**（CLAUDE.md §4.5）。
- 本盤點**未**涵蓋：相依套件 CVE 掃描、Neon 端的存取控管、GCP IAM 角色配置、LINE 官方帳號後台設定。

---

## H1（原判高 → **實測降為中，潛伏**）DB 連線 TLS 驗證未顯式化

- **落點**：[src/db/index.ts:24-31](../src/db/index.ts#L24-L31)
- **設計文件**：[design/D-014-db-tls-verification.md](../design/D-014-db-tls-verification.md)（DRAFT，已寫好待核可）／任務 **T-024**／R1
- **狀態**：**暫緩**。設計已完成，動工只差核可。

**修正紀錄（重要）**：初判為「線上無憑證驗證＝高風險」，**該判定不成立**。對 PROD 實際使用的
pg 8.22.0 + pg-connection-string 2.14.0 實測後確認：

1. `pg/lib/connection-parameters.js:59-60` 以 `Object.assign({}, config, parse(cs))` 讓連線字串的解析結果
   **覆蓋**呼叫端傳入的 `ssl` 物件；`pg-connection-string` 只要見到 `sslmode` 就強制 `config.ssl = {}`。
   ⇒ 我們那行 `rejectUnauthorized: false` **在所有實際組態下皆不可達**（有 sslmode 時被覆蓋；
   無 sslmode 時 `requireSsl` 為 false、本來就傳 `undefined`）。
2. 該套件現行把 `sslmode=require` 當 `verify-full` 的別名 ⇒ **PROD 一直是完整驗證**（憑證鏈 + hostname）。

**真正的風險**是靜默降級：套件已在每次 cold start 印 deprecation warning，v3 / pg v9 將改採 libpq 語意
（`require` = 加密但不驗證）。屆時驗證會無聲消失，而我們自己那行設定與「不驗 CA 鏈」的註解
會讓當時的 reviewer 誤判那正是本意。**核心價值在 D-014 的 AC-3「升級金絲雀」測試**——把定時炸彈換成警報器。

**動工前必讀**：`verify-full` 是唯一在現行與未來 libpq 語意下意義相同的值；且新舊程式碼 × 新舊連線字串
四種組合皆為 verify-full ⇒ **無部署時序風險**，可獨立回滾。

---

## M2 secret 以 `--set-env-vars` 明文帶進 Cloud Run

- **落點**：[docs/deployment-runbook.md:109](deployment-runbook.md#L109)、§4 與附錄「上線座標」
- **風險**：`LINE_CHANNEL_ACCESS_TOKEN` 是**冒充 bot 發訊的完整憑證**。明文 env var 會出現在
  Cloud Run console／`gcloud run services describe`（任何 `roles/viewer` 可讀）、部署者的 shell history、
  以及**所有歷史 revision 的設定**（改不掉，只能刪 revision）。
- **修法**：改 `--set-secrets` + Secret Manager；同時補一條**輪替程序**（目前完全沒有）。
- **注意**：runbook 自己已標「待收斂（post-MVP）」，task-board 開頭「目前階段」亦有記。此為**同一件事**，
  動工時三處要一起更新，勿各自留一份。

## M3 `/webhook` 無流量控管

- **落點**：[src/server.ts:104-153](../src/server.ts#L104)（endpoint）／runbook 的 `--allow-unauthenticated`
- **風險**：驗簽本身正確，但驗簽**之前**沒有任何節流。知道網址的人可持續灌 POST，每發都喚醒
  Cloud Run 做一次 HMAC ⇒ **帳單型 DoS** 與冷啟耗盡（`min-instances=0` / `concurrency=4`）。
  且驗簽失敗只回 401、**不計數也不告警** ⇒ 無從得知網址是否已被掃到。
- **修法**：Cloud Armor 或應用層 per-IP 限流；**至少**先對 401 率設一條告警（成本最低、資訊量最高）。

## M4 `textV2` 的 `{}` 佔位符未跳脫

- **落點**：[src/webhook/handler.ts:138-156](../src/webhook/handler.ts#L138-L156)（`toLineMessage`）
- **⚠️ 非新發現**：task-board Backlog 的 **T-006 reviewer nit-3** 早已記載，當時裁決
  「實務極少見，暫不處理」。本次為**第二次獨立提出**——依 LESSONS 門檻（同型問題累計 2 次）
  值得重新評估，但**不得**當成新問題重開一輪盤點。
- **機制**：`toLineMessage` 以 `{m0}`/`{m1}` 為 substitution key，而 `d.text` 含使用者可控的顯示名與
  代報名字；[normalize.ts:41](../src/commands/normalize.ts#L41) 的白名單正規化明確保留非白名單字元
  ⇒ `{`/`}` 原樣通過，`normalizeProxyName` 亦只折疊空白。故 `+1 {m0}` 會把 `{m0}` 種進名單文字。
- **兩種後果**：①偽造成 @ 別人（冒名）②LINE API 因佔位符不合法而 400 ⇒ **整則回覆漏送**。
  **後者未經實測**——動工第一步應先對 LINE API 驗證實際行為，再決定嚴重度。
- **修法**：組 `textV2` 前跳脫非本次 mention 產生的 `{`/`}`。

## M5 `DEBUG_WEBHOOK` 與錯誤日誌寫入 PII

- **落點**：[src/server.ts:123-133](../src/server.ts#L123-L133)（訊息全文 + groupId + userId）、
  [src/webhook/handler.ts:171-175](../src/webhook/handler.ts#L171-L175)（**無條件**帶 groupId/userId，平時就在跑）
- **風險**：`DEBUG_WEBHOOK=1` 會把**每則訊息全文**寫進 Cloud Logging；目前「生產請關閉」
  **只是 `.env.example` 的一句註解**，沒有任何機制阻止它在 prod 被設起來。
- **修法**：`NODE_ENV=production` 時強制關閉（程式層 fail-safe，非仰賴文件紀律）；
  常態錯誤日誌改記雜湊或截短後的識別碼。

## M6 開團全開 + 生命週期 host-only ⇒ 無回收路徑的鎖死

- **落點**：[src/domain/authz.ts:23-32](../src/domain/authz.ts#L23-L32)、`ux_events_active_group`（同群唯一）
- **風險**：群內任何人可開團，但 `關閉報名`/`取消活動` 僅 host ∪ super-admin。
  若 `ADMIN_USER_IDS` 為空（**目前是可選項，只在啟動時 warn**），一個亂開團的人就能讓整個群
  無法開下一團，**除了進 DB 動手術沒有救**。
- **注意**：這是 **D-006 的既有設計決議**，不是實作缺陷。修它等於改授權模型 ⇒ **R2**。
- **兩條低成本出路**：①把 `ADMIN_USER_IDS` 列為部署必填（改 runbook + 啟動時 fail-fast）
  ②Backlog 既有的「過期自動結算」讓它自然解鎖——**後者可能一併解決，動工前先確認是否重複**。

## M7 容器以 root 執行 + 無 `.dockerignore`

- **落點**：[Dockerfile](../Dockerfile)
- **風險**：runtime 階段沒有 `USER node`。另 build 階段 `COPY . .`，而專案根目錄**確實有 `.env`**
  （已被 git 正確忽略，但 docker build context 不看 `.gitignore`）。多階段建置讓它**不會進最終 image**，
  故非外洩；但只要有人 `--target build`、開 BuildKit cache export，或把 build 階段推上 registry 就會跟著走。
- **修法**：補 `.dockerignore`（`.env*`／`node_modules`／`dist`／`data`／`.git`）+ `USER node`。**兩行的事，CP 值最高。**

---

## 低疑慮（記錄備查，不建議單獨開任務）

- **L1** `我的ID` 把自己的 LINE userId 貼在群裡讓全群看見（[handler.ts:619](../src/webhook/handler.ts#L619)）。
  是取得 super-admin ID 的既定流程，但那是穩定識別碼——文案可提醒改用私訊。
- **L2** `processed_events` 只增不刪；`users`/`registrations` 的顯示名與 userId 永久保留，
  無保存期限、無刪除路徑（使用者要求刪除時無解）。**與 Backlog 既有的 conversation TTL（OP-6）同族**，宜合併處理。
- **L3** CI（[.github/workflows/ci.yml](../.github/workflows/ci.yml)）跑 lint/build/test/harness，
  但**無 `npm audit` 或 Dependabot** ⇒ 相依套件漏洞不會被擋下。**這條與 H1 的升級金絲雀互補**：
  金絲雀管「升級後行為變了」，audit 管「該升級卻沒升」。
- **L4** 特權操作（`取消活動`/`加開 N`/`關閉報名`）無獨立稽核軌跡，事後只能翻應用 log。
- **L5** host 可用 `-N 名字` 取消**任何人**的代報名額（[registration-service.ts:319-321](../src/domain/registration-service.ts#L319-L321)）。
  是刻意的 D-003 G4 設計（host = 版主），非授權缺陷；但配合 L4 就是「有權限、無紀錄」。

## 無疑慮（已實際查證，記錄以免日後重複盤點）

| 面向 | 查證結果 |
|---|---|
| LINE 驗簽 | 缺漏／不符一律 401；rawBody 在 `JSON.parse` **之前**由 content-type parser 保留（[server.ts:89-113](../src/server.ts#L89-L113)）——最常見的踩雷點，這裡是對的。SDK `validateSignature` 用 `crypto.timingSafeEqual`，無時序側通道 |
| SQL injection | 零。全部 repository 一律 `$1/$2` 參數化；僅有的字串插值在**錯誤訊息**（`user-repository.ts:33`、`conversation-repository.ts:54`），不進 SQL |
| 併發／重放 | `SELECT … FOR UPDATE` 綁定同一 `PoolClient`（`tx.ts` 路線 A，型別強制）+ `processed_events` 持久化去重；批次以 `messageId#index` 複合鍵。重送無副作用 |
| 跨群隔離 | migration 0004 把 `conversation_states` PK 改為 `(group_id, line_user_id)`，讓「讀到他群資料」從守衛修補升級為**結構上不可能**；所有 event 查詢以 groupId 為界 |
| secret 進版控 | 無。`git ls-files` 僅 `.env.example`；`.gitignore` 覆蓋 `.env*` |
| 訊息發送面 | 只用 reply、零 push；`replyToken` 來自已驗簽事件 ⇒ 無法誘使 bot 對任意對象發訊。攻擊面比帶 push 的設計小一個量級 |
| XSS／範本注入 | 輸出僅 LINE 純文字、不渲染 HTML；使用者輸入從不進 shell/eval（`{}` 佔位符另見 M4） |
| 錯誤外洩 | 例外只記 log，回使用者的一律是固定 formatter 文案，不吐 stack |
| migration | 單檔單交易、冪等、0004 有 `SET LOCAL lock_timeout`，凍結區規則清楚 |

## 建議處理順序（若日後恢復動工）

**M7（兩行）→ H1/T-024（設計已備妥）→ M5 → M2 → M3 → M4（先驗 LINE 行為）→ M6（R2，改授權模型）**
