# D-017: 文案與驗證一致性收斂

- 狀態：**APPROVED（2026-08-23，使用者裁決「修復順序①文案整潔化」）**
- 撰寫者：orchestrator（`docs/backlog.md` 累積的文案類 nit）
- 關聯：任務 **T-028**／風險等級 **R1**（純輸出層與驗證層，零 R2 模組改動）

## 一、設計內容

清償 Backlog 中六項文案／驗證不一致。**其中兩項經比對後判定為「刻意分工」而非缺陷**
——不是所有登記的債都該用「合併」來還，把結論寫進程式碼註解，避免下一位 reviewer 再提一次。

### (A) 場地名稱上限：三條路徑收斂為一條規則

`編輯 場地` 有 40 字上限，**開團（一行式與逐步問答）完全沒有** ⇒ 可以建出 100 字的地點，
**事後卻不能編輯它**（改任何值都會撞到上限）。`validators.ts` 新增 `validateLocation`
作為三條路徑的單一規則，行為對齊既有的 `編輯 場地`：去頭尾空白、非空、≤ `MAX_LOCATION_LEN`、
**不截斷**、保留內部空白（「東方 A 場」合法）。

- 逐步問答：超長 → 停留同一步重問（與日期／時間／人數錯誤的既有行為一致，不需新文案）。
- 一行式：超長 → `invalid(bad_location)` → 現行的開團格式說明。
- **這是行為改變**：先前可建立的超長地點活動，現在會被拒。既有資料不受影響（不回溯檢查）。

### (B) 同一狀態兩種說法

`formatAlreadyClosed()` 說「活動已關閉報名。」，而同一個 closed 狀態在 `event-formatter` §189／§444
與名單標籤都說「報名已截止」⇒ 統一為 **「這場活動的報名已截止。」**。

### (C) 「沒有活動」兩句：**維持分工，不合併**（比對 14 個呼叫點後的結論）

- `formatNoOpenEvent()`「目前沒有開放報名的活動。」→ **報名類**指令（`+N`／`-N`／`名單`／`加開`／`分組`）
- `formatNoActiveEvent()`「目前沒有進行中的活動。」→ **管理類**指令（`取消活動`／`編輯 …`）

兩者的下一步動作不同（開一場 vs 等下一場），合併會讓使用者失去線索。
本次只補齊 `formatNoOpenEvent` 缺的句號，使句式一致；並在兩個函式的註解互相指認，
說明為何不合併。

### (D) `formatEditOk` 對空氣喊話

正取 0 人（主辦開團後自行 `-1`）時仍輸出「已報名的各位請確認。」——沒有「各位」可以請確認，
主辦會誤以為有人收到了通知。改為只輸出成功句。

**實作陷阱（本次實際踩到）**：`overflow`（超過 20 人退化）時呼叫端傳入的 `targets` **也是空陣列**，
兩種情況的 `targets.length` 都是 0，只有 `overflow` 旗標能分辨。**必須先判 `overflow`**，
否則會把「人太多」誤判成「沒有人」而吞掉必要的提示句。

### (E) `editErrorField` 非 exhaustive

原簽名 `(reason: string)` 以 `return 'location'` 收尾 ⇒ parser 日後為 `edit_event` 新增第 4 個
原因碼時會**靜默套上錯誤的欄位文案**，編譯器不會有意見。改吃 `InvalidReason` 並窮舉所有值，
新增原因碼時 `_exhaustive` 直接編譯失敗。

### (F) 顯示名 fallback：**維持分工，不統一**

`'使用者'`（一般顯示名 fallback，由 D-003 的顯示名驗收條目釘死）與 `'代報者'`（代報語境）看似風格不一，
但語境不同：後者會組成「小明（由 @代報者 代報）」，換成「由 @使用者 代報」語意更差。
**不改**，理由記於此。

### 範圍外

- 遞補通知的 mention 數量上限（Backlog T-026 nit ⑦）——另案。
- 縮減名額、去重政策收斂——皆碰 R2 模組，使用者裁決的順序中排在後面。

### 將改動的既有文件（預列 errata）

- `design/D-015` §3 → `formatEditOk` 的釘死字串在「正取 0 人」情況下不再輸出提示句。
- `design/D-007` §3 → 「cancel candidates 唯讀讀安全」措辭與 CLAUDE.md §4 不一致（T-017 遺留）。

### Conversation state 三件套

無——本設計不新增任何 conversation state。

## 二、Guardrails（Must NOT）

- **G1**：`validateLocation` **不得截斷**超長輸入（沿用 D-015 G6）——截斷會讓使用者拿到一個
  自己沒打過的場地名，且無從察覺。
- **G2**：不得順手「統一」(C) 與 (F) 兩組刻意分工的文案——若日後要合併，須先重做呼叫點比對並開新設計。
- **G3**：不得改動 `registration-service.ts`／`event-service.ts`／`migrations/`（R2 模組），
  本任務純輸出層與驗證層。
- **G4**：`formatEditOk` 的 `overflow` 判斷不得排在 `targets.length === 0` 之後（見 (D) 陷阱）。

## 三、Acceptance Checks

- [x] **AC-1**：`validateLocation` 拒空／拒超長／放行上限值本身／只去頭尾空白。（執行：`npm test`）
- [x] **AC-2**：一行式開團超長地點 → `invalid(bad_location)`；上限值本身放行。（執行：`npm test`）
- [x] **AC-3**：逐步問答超長地點 → 停留 `awaiting_location`、不寫入 draft。（執行：`npm test`）
- [x] **AC-4**：`編輯 場地` 超長仍回 `bad_location` 且 `detail.len` 為實際字數；空值仍回 `edit_help`（零回歸）。（執行：`npm test`）
- [x] **AC-5**：closed 狀態文案含「報名已截止」且不含「已關閉報名」。（執行：`npm test`）
- [x] **AC-6**：兩句「沒有活動」皆以句號結尾且**仍不相等**（維持分工）。（執行：`npm test`）
- [x] **AC-7**：正取 0 人 → 只回成功句；`overflow` 且 targets 為空 → 提示句保留。（執行：`npm test`）
- [x] **AC-8**：`editErrorField` 簽名為 `InvalidReason` 且函式體含 `_exhaustive`。（執行：`npm test`）
- [x] **AC-9（回歸）**：`npm run lint`／`build`／`test`／`harness:check` 全綠。（執行：如指令）

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-23 | 技術債盤點，使用者訂修復順序 | ①文案整潔化 ②去重不對稱 ③測試檔假綠 ④其他 |
| 2026-08-23 | 資安插隊 | 先做完 T-027，再回到① |
| 2026-08-23 | 本批動工 | 「把文案整潔化完成後 commit/push/merge/deploy」 |
