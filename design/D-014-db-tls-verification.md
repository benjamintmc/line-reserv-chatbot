# D-014: DB 連線 TLS 驗證顯式化（H1）

- 狀態：**APPROVED → 已實作（T-027，2026-08-23）**。AC-1~AC-5 由 `src/db/__tests__/pool-ssl.test.ts` 覆蓋並全綠；
  AC-6／AC-7 已於 PROD revision `00005-89q` 真機驗證（`/health` 200、cold start log 不再出現 SSL 別名警告）。
- 撰寫者：orchestrator（資安觀察 H1 衍生）
- 關聯：D-007 §5（連線工廠）／`src/db/index.ts`／任務 T-024／風險等級 **R1**

## 一、設計內容

### 根因（三層事實，皆已於本機對 pg 8.22.0 + pg-connection-string 2.14.0 實測）

1. **現行的 `ssl: { rejectUnauthorized: false }` 是死碼。** `pg/lib/connection-parameters.js:59-60`
   以 `Object.assign({}, config, parse(connectionString))` 讓**解析結果覆蓋顯式設定**；而
   `pg-connection-string/index.js:77-79` 只要連線字串含 `sslmode` 就強制 `config.ssl = {}`。
   ⇒ 有 `sslmode` 時我們傳什麼都被丟棄；無 `sslmode` 時 `requireSsl` 為 false、我們本來就傳 `undefined`。
   **兩種情形皆不可達 ⇒ 該設定在所有實際組態下從未生效。**
2. **PROD 目前其實是完整驗證的。** pg-connection-string 2.14.0 將 `require` 視為 `verify-full` 別名，
   `sslmode=require` → `ssl = {}` → Node TLS 預設（驗憑證鏈 + 驗 hostname）。
   ⇒ 原 H1 所述「線上正被 MITM 風險裸奔」**不成立**，實際暴露度由「高」降為「中（潛伏）」。
3. **但這是借來的安全，且已在倒數。** 該套件於每次 cold start 印出 deprecation warning：
   v3.0.0 / pg v9 將改採 libpq 語意，`require` = 加密但**不驗證**。屆時驗證會**靜默消失**，
   而我們自己那行 `rejectUnauthorized: false` 與「不驗 CA 鏈」的註解會讓當時的 reviewer
   誤以為那正是本意 ⇒ 無人攔截。

### 目標

把「驗證憑證」從**相依套件的偶然行為**變成**本專案顯式、且跨 pg 主版本穩定**的狀態。
`verify-full` 是唯一在 pg 2.x 現行語意與未來 libpq 語意下**意義完全相同**的值。

### 範圍內

- `src/db/index.ts`：刪除 `requireSsl` regex 與整個 `ssl` 選項，SSL 策略一律交由連線字串的
  `sslmode` 決定（pg 原生行為）；同步改寫該處誤導性註解。
- 連線字串 `sslmode=require` → `sslmode=verify-full`：PROD Cloud Run env var、本機 `.env`、
  `.env.example` 註解、`docs/deployment-runbook.md` 範例。**app runtime 與 migrate 直連字串皆改。**
- 新增 `src/db/__tests__/pool-ssl.test.ts`：釘住有效 SSL 組態，並設一條升級金絲雀（AC-3）。

### 範圍外

- 同輪資安觀察的 M2（Secret Manager）／M3（限流）／M4（`{}` 跳脫）／M7（`USER node`＋`.dockerignore`）
  ——各自獨立任務，本次不夾帶（避免審查包 diff 範圍失焦，見 LESSONS 同型項）。
- 本機 `docker-compose.yml` 測試 DB 維持無 TLS（連線字串無 `sslmode`，行為不變）。
- 不改 `package.json` 的 `pg` 版本範圍——升級攔截交給 AC-3 的金絲雀測試，而非版本 pin。

### 將改動的既有文件（預列 errata）

- `design/D-007-postgres-migration.md` §5 → 補 errata：原文「MVP 以 `rejectUnauthorized:false` 相容
  （不驗 CA 鏈，僅加密傳輸）」的**前提有誤**（該設定不可達、實際一直是 verify-full），已於 D-014 移除。
- `docs/deployment-runbook.md` §4（`--set-env-vars` 範例）與附錄「上線座標」→ `verify-full` + 本次 revision。
- `.env.example` DATABASE_URL 註解 → 標明必須 `sslmode=verify-full` 及原因。

### Conversation state 三件套

無——本設計不新增任何 conversation state。

### 部署時序（與 0004 migration 不同，**無單階段窗口風險**）

新舊程式碼 × 新舊連線字串四種組合，在 pg 2.14 下**全都**是 verify-full ⇒ 程式先部署或 env 先改皆安全，
可各自獨立回滾。這是選 `verify-full` 而非其他改法的附帶好處，請勿在實作時引入時序耦合。

## 二、Guardrails（Must NOT）

- **G1**：不得在 `createPool`（或任何連線路徑）傳入會關閉憑證驗證的選項——包含
  `rejectUnauthorized: false`、`checkServerIdentity: () => {}`、`sslmode=no-verify`，
  以及設定 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- **G2**：PROD／migrate 連線字串不得使用 `require`／`prefer`／`verify-ca`／`disable`——**僅** `verify-full`。
  （前三者語意將隨 pg 主版本改變；`verify-ca` 在本套件更會直接拋錯要求自帶 CA。）
- **G3**：不得將真實連線字串或其任何片段（host、帳密、專案代號）寫入版控、測試 fixture 或 log；
  測試一律使用合成 host（`*.example.invalid`）。
- **G4**：不得在本任務夾帶 `src/db/index.ts`＋上列文件以外的行為變更；特別是不得順手動
  `src/db/tx.ts`（凍結區）或任何 R2 模組。

## 三、Acceptance Checks

- [ ] **AC-1**：`createPool('postgres://u:p@h.example.invalid/db?sslmode=verify-full')` 建出的
      ConnectionParameters，其 `ssl` 為 truthy 且**不含** `rejectUnauthorized: false`、
      **不含** `checkServerIdentity` 覆寫。（執行：`npm test`）
- [ ] **AC-2**：`createPool('postgres://u:p@localhost:5433/db')`（無 `sslmode`，即本機 docker）→
      `ssl` 為 falsy（不啟用 TLS），與現行行為零回歸。（執行：`npm test`）
- [ ] **AC-3（升級金絲雀）**：測試斷言「`sslmode=require` 解析結果與 `sslmode=verify-full` 相同」。
      此條**現在必然通過**；其唯一用途是在未來 pg／pg-connection-string 主版本改變 `require` 語意時
      **轉紅**，成為升級當下的顯式攔截點。測試需附註解說明「此條轉紅＝預期中的語意變更，
      應確認 G2 仍被遵守後才可調整」。（執行：`npm test`）
- [ ] **AC-4**：`src/` 全樹不存在字串 `rejectUnauthorized`。（執行：`npm test` 內以 `readFileSync`
      掃描 `src/db/index.ts`；或人工 `grep -rn rejectUnauthorized src/`）
- [ ] **AC-5（回歸）**：`npm run lint`／`npm run build`／`npm test`（368 tests 基準）／
      `npm run harness:check -- --strict` 全綠。（執行：如指令）
- [ ] **AC-6（真機，無法以 npm test 執行）**：改 env + 部署新 revision 後，`/health` 回 200，
      且群組實測 `名單` 正常回覆（證明 verify-full 下 DB 連線成功）。
      記錄落點：`docs/deployment-runbook.md` 附錄「上線座標」新增一列（revision／日期／結果）。
- [ ] **AC-7（真機，觀測性）**：新 revision 的 cold start log **不再**出現 pg-connection-string 的
      `SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases`。
      （執行：人工 `gcloud run services logs read golf-reserv-chatbot --region asia-east1`；
      記錄落點同 AC-6。）

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-22 | 資安盤點提出 H1，初判「線上無憑證驗證＝高」 | 使用者指示「H1 先開始」 |
| 2026-08-22 | 實測推翻初判：設定不可達、PROD 實為 verify-full ⇒ 降為中（潛伏／靜默降級） | **排入 Backlog、暫不動工**（線上無破口、無使用者影響，非急件） |
| 2026-08-22 | 風險等級由初判 R2 修正為 **R1**（不涉授權／金流／migration／刪除，僅傳輸層 + 部署設定） | 採 R1（暫緩不影響此判定） |

> **恢復動工時**：本設計無須重寫，但請先重跑一次 §一 的實測——若屆時 `pg`／`pg-connection-string`
> 已跨大版本，AC-3 金絲雀的前提（`require` ≡ `verify-full`）可能已不成立，需據實調整該條的敘述，
> 但 G2「僅用 `verify-full`」與本設計的結論**不受影響**（那正是選它的理由）。
