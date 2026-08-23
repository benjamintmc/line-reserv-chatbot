# D-016: 資安加固批次（M2／M3／M4／M5）

- 狀態：**APPROVED（2026-08-23，使用者裁決「資安類 1-5 先全部修好」＝ H1＋M2–M5）**
- 撰寫者：orchestrator（`docs/security-review-2026-08-22.md` 衍生）
- 關聯：H1 另見 `design/D-014`（已有獨立設計）／任務 **T-027**／風險等級 **R1**
- M6 已由使用者裁決**不做**（改授權模型，R2）；M7 已於 T-025 完成。

## 一、設計內容

四條各自獨立、互不耦合，合併為一個任務是因為**全部落在「非商業邏輯」層**
（連線設定、部署設定、訊息組版、log），零 R2 模組改動，合併審查不會失焦。

### M4 `textV2` 的 `{}` 未跳脫（唯一有使用者可見後果者）

- **落點**：`src/webhook/handler.ts` `toLineMessage()`。
- **機制**：`textV2` 以 `{key}` 為 substitution 佔位符；顯示名與代報名字皆使用者可控，
  且 `normalize.ts` 明確保留非白名單字元 ⇒ `{`／`}` 原樣進入訊息文字。
- **兩種後果**：①`+1 {m0}` 可偽造成 @ 別人（冒名）②**未配對的單一 `{` 會被 LINE API 直接拒絕**
  （`Single '{' encountered at index N`）⇒ **整則回覆漏送**，且對使用者靜默（只在伺服器留 log）。
  官方跳脫語法為 `{{`／`}}`（本次動工前查證 LINE Developers 文件確認，**推翻**了 T-006 nit-3
  當時「實務極少見、暫不處理」的判斷——那次未考慮到 400 整則失敗這條路徑）。
- **修法**：新增 `escapeBraces()`，對**非本次 mention 產生**的文字片段（切片）跳脫；
  純 `text` 訊息不套用（不解析佔位符，跳脫反而多出括號）。

### M5 log 寫入 PII

- **落點**：`src/config.ts`（`debugWebhook`）、`src/webhook/handler.ts`（`logError` 帶 groupId/userId）。
- **修法（兩段）**：
  ①**fail-safe**：`NODE_ENV=production` 時 `debugWebhook` **無條件為 false**，即使 env var 設為 1。
  原防線只有 `.env.example` 一句註解——那是紀律不是機制。Dockerfile 已設 `NODE_ENV=production`。
  ②新增 `src/log-redact.ts` 的 `redactId()`：SHA-256 前 8 位。除錯需要的是「同一主體可比對」，
  不是原值；LINE 的 groupId／userId 是**永久且跨群穩定**的識別碼，不應長期留在 Cloud Logging。

### M2 secret 明文帶進 Cloud Run（部署設定，無程式碼改動）

- 三個憑證（`DATABASE_URL`／`LINE_CHANNEL_SECRET`／`LINE_CHANNEL_ACCESS_TOKEN`）改由
  **Secret Manager** 提供（`--set-secrets`）；`ADMIN_USER_IDS` 非憑證，維持明文 env var。
- 併入 **H1／D-014**：建立 `database-url` secret 時直接寫入 `sslmode=verify-full` 的字串
  ——兩者都要改同一個值，分兩次部署徒增窗口。
- runbook 補 **§4.2 憑證輪替程序**（原本完全沒有）。

### M3 `/webhook` 無流量控管（部署設定，無程式碼改動）

- 使用者裁決：**告警 + 帳單天花板**，不做主動阻擋（Cloud Armor 需先架 Load Balancer，$18+/月起）。
- `--max-instances` 20 → **3**：正常用量 1–2 個實例綽綽有餘，此值是被灌流量時的損失上限。
- Cloud Monitoring 政策「webhook 驗簽失敗異常（資安 M3）」：5 分鐘內 401 > 20 次 → email。
  正常情況 401 幾乎為 0（LINE 送來的請求必帶正確簽章）⇒ 訊噪比高。

### 範圍外

- **M6**（開團鎖死）：使用者裁決不做。
- **L1–L5**：低疑慮，記錄備查。
- 遞補通知的 mention 數量上限（Backlog T-026 nit ⑦）：另案，本次不夾帶。

### 將改動的既有文件（預列 errata）

- `design/D-007` §5 → `rejectUnauthorized:false` 的前提有誤（該設定不可達），已於 D-014 移除。
- `docs/deployment-runbook.md` §4 全段改寫 + 附錄「上線座標」補 revision。
- `.env.example`：`DATABASE_URL` 標明 `verify-full`；`DEBUG_WEBHOOK` 標明 production 強制關閉。
- `docs/security-review-2026-08-22.md`：H1／M2–M5 狀態改為已處理。

### Conversation state 三件套

無——本設計不新增任何 conversation state。

## 二、Guardrails（Must NOT）

- **G1**：不得為了讓跳脫通過而改動 `normalize.ts` 的字元白名單策略——跳脫是**輸出層**的事，
  在輸入層過濾會連帶影響指令解析與既有釘死字串。
- **G2**：`escapeBraces` 不得套用於 `type: 'text'` 分支（純文字不解析佔位符，跳脫會使使用者看到多餘括號）。
- **G3**：不得把任何 secret 值寫入版控、log、測試 fixture 或指令歷史；
  建立 secret 一律 `printf '%s' ... | gcloud secrets create --data-file=-`。
- **G4**：不得以「暫時除錯」為由在 PROD 繞過 M5 fail-safe（例如改用另一個 env var 名稱重新打開全文 log）。
- **G5**：不得在本任務夾帶任何 R2 模組（`registration-service.ts`／`event-service.ts`／`migrations/`）的行為變更。

## 三、Acceptance Checks

- [x] **AC-1（M4）**：代報名字含 `{m0}` 時，遞補通知的 `textV2.text` 含 `{{m0}}`，
      且文字中單括號佔位符數量 == `substitution` key 數量（無多餘、無遺漏）。（執行：`npm test`）
- [x] **AC-2（M4）**：無 mention 的回覆 `type` 仍為 `text`、不做跳脫。（執行：`npm test`）
- [x] **AC-3（M5）**：`redactId` 產出 8 位十六進位、同輸入同輸出、不等於原值、空值回 `undefined`。（執行：`npm test`）
- [x] **AC-4（M5）**：profile 失敗的錯誤 log 內容不含原始 `groupId`／`userId`。（執行：`npm test`）
- [x] **AC-5（M5）**：`NODE_ENV=production` 時 `config.debugWebhook` 為 false。（執行：程式碼審查 + Dockerfile 已設 production）
- [x] **AC-6（M2，真機）**：`gcloud run services describe` 的 env 中，三個憑證皆為 `valueFrom.secretKeyRef`，
      無 `value` 明文。（執行：人工，輸出記於 runbook 附錄）
- [x] **AC-7（M3，真機）**：`--max-instances=3` 生效；告警政策存在且綁定通知管道。（執行：人工）
- [x] **AC-8（回歸關卡未被移除）**：`package.json` 仍具備 `lint`／`build`／`test`／`harness:check` 四條關卡指令，
      且本次四者全綠。（執行：`npm test` 釘住指令存在；全綠與否見任務單證據）

- [x] **AC-9（事故後補）**：runbook 釘住「憑證改動後的必要冒煙」兩項——以 secret 計算正確簽章
      打回 `/webhook` 預期 200、以該連線字串跑一次真實查詢——並記載 `gcloud value()` 對 list
      加 `['…']` 包裝的取值陷阱。（執行：`npm test`）

> **真機待驗（不列為 AC，避免文件宣稱未發生的驗證）**：群組實測一則 `名單` 正常回覆。
> orchestrator 已補驗「帶正確簽章 webhook 回 200」與「真實查詢連上 Neon」，但兩者都**繞過 LINE 平台本身**，
> 故端到端仍需使用者實打。已登記於 `docs/task-board.md` 阻塞清單。

### 事故紀錄（2026-08-23）

首次部署（`00005-89q`）三個憑證取值錯誤，全部 LINE 訊息回 401、33 分鐘全故障，
**由使用者實測發現而非我的驗證發現**。根因與教訓見 `harness/LESSONS.md` 2026-08-23 條目；
修復後最終 revision `00007-pdv`，壞掉的 secret 版本 1 已 disable。

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-22 | 資安盤點 12 條，建議順序 M7 → H1 → M5 → M2 → M3 → M4 → M6 | 僅 M7 動工（T-025），其餘暫緩 |
| 2026-08-23 | 技術債盤點回顧 | M6 不做；mention 上限改文案處理 |
| 2026-08-23 | 「資安類 1-5 先全部修好」 | H1＋M2–M5 全做；M3 採「告警＋帳單天花板」；PROD 變更由 orchestrator 直接執行 |
