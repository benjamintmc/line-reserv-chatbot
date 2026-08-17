# D-011: 分組（即時計算，中性策略，逐輪揭示）

狀態：APPROVED（含 2026-08-17 errata；場地名 A-Z、`分組`/`下一輪` host-only 排除 super-admin）

- 撰寫者：backend-engineer
- 風險等級：R1（中）——唯讀名單 + 逐輪 session 暫存（既有 `conversation_states`）、零 migration、無金流/授權升級/刪除。走標準流程（unit-tester + 一位 reviewer），Guardrails ≥ 3。
- 關聯：Brief 決策（分組為全新項目，非交接清單）／FR 分組需求・任務 T-018（分組實作，待 orchestrator 於 task-board 正式編號）・設計 D-011
- 相依（先讀後寫，皆 APPROVED，本文件**只復用、不私改**）：
  - D-001（資料模型）：`registrations` 的 `status`（confirmed/waitlist）、`kind`（self/proxy）、`display_name` 快照、`cancelled_at`；`conversation_states`（`line_user_id` PK、`state`、`payload` JSON）。
  - D-002（指令解析）：全形數字正規化、上限（`MAX_COUNT`）、邊界回中文提示、`ParsedCommand` discriminated union、`名單` 為唯讀指令範式。
  - D-003（報名核心）：正取名單唯讀查詢 `RegistrationReader.listConfirmed`（`status='confirmed' AND cancelled_at IS NULL`）、`roster.buildRoster`（名字快照 + `名字(k)` 後綴）。
- 復用之現行程式：`registration-repository.listConfirmed`、`src/domain/roster.ts`、`conversation-repository`（session 讀寫）、`src/commands/{parse,types,validators,index}.ts`、`src/webhook/handler.ts`（host-only 授權）。

> 本文件是設計文件、**不寫實作程式碼**。文中少量片段僅說明介面形狀，非交付碼。

---

## 一、設計內容

### 0. 定位
新增指令 `分組`，與 `名單` 同級：讀「當前 active event 的正取名單」→ 純函式計算 → 中性組版回覆。策略A **即時計算、不儲存**；策略B 啟動**有狀態多輪 session**（暫存於既有 `conversation_states`、主辦 `line_user_id` 為鍵，見 §1）。event **不存策略/mode**。名單來源＝`listConfirmed(eventId)` 經 `roster.buildRoster`（含 proxy 人頭、`名字(k)` 後綴、排除 waitlist/cancelled）；**策略B 名單於分組當下凍結**。

### 1. 指令文法（中性用語，parser 決定策略；沿用 D-002 慣例）
- `分組` → **策略A（均分）**：一次分完，每組只有 3 或 4 人、最大化 4 人組。
- `分組 {M}場 [{R}輪] [單打]` → **策略B（多輪輪替）**：啟動一段**有狀態 session**、**只輸出「第 1 輪」**，後續以 `下一輪` 逐輪揭示。不帶「單打」＝**雙打**（每場 4 人 2v2）、帶「單打」＝**單打**（每場 2 人 1v1、無隊友）。`{R}輪` 為**選填上限**：未帶＝**不設上限**（可持續 `下一輪`）；有帶＝走到第 R 輪為止。
  - **用語**：**場** = 同時進行的場地數；**輪** = 逐次揭示的回合；`courtSize` = 每場人數（雙打 4／單打 2）。每輪上場 `M×courtSize` 人，其餘輪空（sit-out）。
  - **`M` 未帶** → 雙打預設 `floor(N/4)`、單打預設 `floor(N/2)`；**`{R}輪` 未帶** → 不設輪數上限（可持續 `下一輪`）。
- 解析：`{M}場`/`{R}輪` 數字沿用 D-002 全形→半形正規化與 `MAX_COUNT` 上限；`M<1`、`R<1`、超上限 → `invalid`（中文提示）。新增 `ParsedCommand` 分支 `{ type:'group'; courts?:number; rounds?:number; mode:'singles'|'doubles' }`（策略A 時 mode 無意義，預設 doubles）。
- 觸發權限：**僅該 event 的 `host_user_id`（主辦人本人）**；**排除 super-admin**（errata 2026-08-17，取代裁決 #4 canManageEvent）。
- **`下一輪`**（新指令）→ 產生**下一輪**、避開**先前所有輪**的隊友/對手並延續輪空累計公平，只回該輪；無進行中 session → 中文提示「目前沒有進行中的分組，請先『分組 …』」；已達 `{R}輪` 上限 → 回「已達輪數上限」。授權 **host-only**（session 以主辦 `line_user_id` 為主鍵，非主辦含 super-admin 查無 session）。策略A 一次分完、**無 `下一輪`**。
- **狀態暫存**：復用既有 `conversation_states`（主辦 `line_user_id` 為鍵）經 `conversation-repository`，`state` 標記 `grouping`（與開團問答互斥、不衝突）；`payload`(JSON) 存 mode／M／courtSize／**凍結名單 labels**／歷史（各輪配對＋各人 sit-out 累計）／目前輪序。`下一輪` 讀 payload→算→寫回；**不加欄位/表/migration**。已知取捨：主辦不能同時處於開團問答與分組 session；名單於分組當下凍結。

### 2. 演算法A：均分 partition（純函式 `partitionBalanced(labels, rng)`）
把 N 人拆成只有 3/4 的組、最大化 4 人組（組數最少）。以 `r = N % 4`：
- `r=0` → 全 4；`r=3` → 一組 3 + 其餘 4；`r=2`（N≥6）→ 兩組 3 + 其餘 4；`r=1`（N≥9）→ 三組 3 + 其餘 4。
- **邊界**：`N∈{1,2}` → 不足成組，回中文提示「報名人數不足，無法分組」，不產任何組；`N=5` → 數學上無法用 3/4 拆（4+1、3+2 皆違反最少 3）→ 產**一組 5 人**並附註「（人數 5，暫不拆組）」。
- 分派：以注入的 `rng` 隨機洗牌後依組數切段（可重跑重骰）。

### 3. 演算法B：逐輪輪替排程（純函式）
`courtSize`（雙打 4／單打 2）：**雙打**每場＝2 隊友 pair + 4 對手 pair；**單打**每場＝1 對手 pair、**無隊友 pair**。每輪同時上場 `M×courtSize` 人、其餘輪空。
- **成本函式（擇低，依序權重）**：① 最小化重複隊友（單打不適用，恆 0）② 最小化重複對手 ③ 輪空次數在 N 人間盡量平均（**以累計 sit-out 次數極差 ≤1 為主**）④ 懲罰同一人**連續三輪（含）以上**出賽（連兩輪不罰）。**③④ 衝突時以 ③（出賽數平均）優先、④ 為次級軟懲罰**（裁決 #1／#2，2026-08-17）。
- **`下一輪`（增量排程 `nextRound(state, rng)`）**：以 payload 歷史為既有配對集，對新一輪套同一成本函式（避開**所有**先前隊友/對手、延續 sit-out 累計）；隨機化貪婪 + 多次重啟取最低成本，只算/回一輪並寫回 state。可重跑重骰。

### 4. 輸出組版（中性；新增 `src/domain/grouping-formatter.ts`，純函式）
沿用既有 formatter 的名字快照與 `-` 日期分隔慣例，**不新增第二種措辭、不改既有 formatter**。
- 策略A：逐行 `第 1 組：A、B、C、D`（人名以 `、` 分隔）。
- 策略B：`第 r 輪` 標題下逐場——雙打 `A場：A、B vs C、D`、單打 `A場：A vs B`（無「、」隊友）；場地名用 A、B、C…Z（M>26 以 `第 M 場` 遞補）；每輪末列 `輪空：X、Y`（無則略）。
- **末尾不附每人出賽/休息統計**（維持精簡、避免洗版；裁決 #3，2026-08-17）。

### 5. 模組劃分（改哪些檔）
| 檔案 | 類型 | 摘要 |
|---|---|---|
| `src/domain/grouping.ts` | ➕ 純函式 | `partitionBalanced` / `scheduleRounds` / `nextRound`（courtSize 參數化）；零 DB、零副作用、嚴禁 any |
| `src/domain/grouping-formatter.ts` | ➕ 純函式 | 中性組版（第 N 組／第 r 輪／A場／vs／輪空） |
| `src/commands/{types,parse,validators,index}.ts` | 🔧 | 新增 `group`／`下一輪` 分支與 `{M}場 {R}輪 [單打]` 解析（復用 D-002） |
| `src/webhook/handler.ts` | 🔧 | 接線 `分組`／`下一輪` → host_user_id 授權 → `listConfirmed`+`buildRoster`／經 `conversation-repository` 讀寫 session → domain → 回覆 |

### 範圍內
新增 `分組`／`下一輪` 指令、策略A/B（雙打+單打，courtSize 參數化）純函式與中性組版、策略B 逐輪 session（`conversation_states` 暫存）、parser 分支、handler 接線（host-only 授權）。

### 範圍外
新增欄位/資料表/migration；寫入 `events`／`registrations`／`users`；event 儲存策略；跨活動比對；球組收款統計；同群多場並行；**性別欄位/分組（v2；單打模式本身與性別無關，男女配對屬場邊人工層）**。

---

## 二、Guardrails（Must NOT；R1）

- **G1（不落庫、僅暫存 session）**：分組**不得**新增欄位/資料表/migration；策略B session **僅**暫存於既有 `conversation_states`（經 `conversation-repository`），**不得**寫入 `events`／`registrations`／`users` 或更動其語意；`grouping.ts`/`grouping-formatter.ts` 維持零 DB 副作用純函式。
- **G2（球種中性化，憲法 §0）**：所有 user-facing 文案**不得**出現任何特定球種字眼（「高爾夫」「匹克球」「pickleball」等）；只用中性詞（第 N 組／第 r 輪／A場／vs／輪空／人數不足）。
- **G3（名單組成）**：分組輸入**不得**納入 `waitlist` 或已取消（`cancelled_at IS NOT NULL`）列；**必須**含 proxy 代報名人頭；只讀 `confirmed`（一律經 `listConfirmed`+`buildRoster`，不得另寫查詢繞過）。
- **G4（不改既有措辭）**：**不得**改動 `event-formatter.ts`／`list-formatter.ts` 既有措辭或任何既有 repository 查詢語意；名字快照與 `-` 日期分隔沿用、不得新增第二種措辭。
- **G5（策略不落庫）**：`events`／`registrations` **不得**儲存分組策略/mode（session 存於 `conversation_states` 屬允許）；策略與 mode 只由當次指令參數（`分組` vs `分組 {M}場 {R}輪 [單打]`）決定。
- **G6（單打不涉隊友/性別）**：單打模式（courtSize=2）**不得**產生任何隊友 pair；分組**不得**引入任何性別欄位或性別分組邏輯（男女配對屬場邊人工層，性別分組為 v2）。

---

## 三、Acceptance Checks（`[D-011 AC-n]`，可轉測試）

- [ ] **[D-011 AC-1]（A: r=0）**：N%4==0（如 N=8/12）→ 全為 4 人組、無 3 人組。
- [ ] **[D-011 AC-2]（A: r=3）**：N%4==3（如 N=7/11）→ 恰一組 3 人、其餘皆 4 人。
- [ ] **[D-011 AC-3]（A: r=2）**：N≥6 且 N%4==2（如 N=6/10）→ 恰兩組 3 人、其餘皆 4 人。
- [ ] **[D-011 AC-4]（A: r=1）**：N≥9 且 N%4==1（如 N=9/13）→ 恰三組 3 人、其餘皆 4 人。
- [ ] **[D-011 AC-5]（A: 邊界 1/2）**：N∈{1,2} → 回中文「報名人數不足，無法分組」、不產任何組。
- [ ] **[D-011 AC-6]（A: 邊界 5）**：N=5 → 產一組 5 人並附註（不拆為 4+1／3+2）。
- [ ] **[D-011 AC-7]（B 雙打: 隊友不重複）**：雙打可行案例（如 20 人 5 場，逐輪至 4 輪）→ 隊友 pair 零重複。
- [ ] **[D-011 AC-8]（B 雙打: 對手不重複）**：同上可行案例 → 對手 pair 零重複。
- [ ] **[D-011 AC-9]（B: 輪空平均）**：存在輪空的案例（如雙打 12 人 2 場，數輪後）→ 各人 sit-out 次數極差 ≤ 1。
- [ ] **[D-011 AC-10]（B: 避免連續三輪）**：可行案例下，無人被排連續三輪（含）以上出賽。
- [ ] **[D-011 AC-11]（B: 只出第 1 輪）**：`分組 {M}場`（帶或不帶輪）→ 首次**只輸出第 1 輪**（不一次全出）。
- [ ] **[D-011 AC-12]（B 雙打: M 預設=floor(N/4)）**：雙打未帶場 → M = floor(N/4)。
- [ ] **[D-011 AC-13]（中性文案）**：策略A/B 任一輸出字串皆**不含**「高爾夫／匹克球／pickleball」等球種字眼；含「第 N 組」或「第 r 輪／A場」。
- [ ] **[D-011 AC-14]（只納 confirmed、含 proxy）**：名單含 confirmed self、confirmed proxy、waitlist、cancelled 混合時 → 分組人數＝confirmed 有效列數（含 proxy、排除 waitlist/cancelled）。
- [ ] **[D-011 AC-15]（雙打組版格式）**：策略A 每行 `第 k 組：` + `、` 分隔名；雙打每輪 `第 r 輪` 下各場 `A場：A、B vs C、D`，有輪空者列 `輪空：…`。
- [ ] **[D-011 AC-16]（解析 {M}場{R}輪）**：`分組 ２場 ５輪`（全形）解析 courts=2/rounds=5/mode=doubles；`分組 0場` 或超上限 → `invalid`（中文提示）。
- [ ] **[D-011 AC-17]（解析 單打）**：`分組 ２場 ５輪 單打`（全形）→ mode=singles/courts=2/rounds=5。
- [ ] **[D-011 AC-18]（B 單打: 每場 2 人、無隊友、對手不重複）**：單打可行案例 → 每場恰 2 人、無隊友 pair、對手 pair 零重複。
- [ ] **[D-011 AC-19]（B 單打: M 預設=floor(N/2)）**：單打未帶場 → M = floor(N/2)。
- [ ] **[D-011 AC-20]（單打組版格式）**：單打每輪 `第 r 輪` 下各場 `A場：A vs B`（無「、」隊友），有輪空者列 `輪空：…`。
- [ ] **[D-011 AC-21]（下一輪: 全歷史不重複）**：連續 `下一輪` → 每新輪隊友/對手皆與**先前所有輪**不重複（可行時零重複）、sit-out 累計延續、只回該輪。
- [ ] **[D-011 AC-22]（輪數上限）**：未帶 `{R}輪` → 開放式，可連續 `下一輪` 超過任何固定數（如 >5 次仍產）；帶 `{R}輪` → 到第 R 輪後 `下一輪` 回「已達輪數上限」中文提示。
- [ ] **[D-011 AC-23]（下一輪無 session）**：無進行中分組時 `下一輪` → 中文提示「目前沒有進行中的分組…」、不產任何輪。
- [ ] **[D-011 AC-24]（session 存 conversation_states；A 無下一輪）**：策略B session 存於 `conversation_states`（主辦 `line_user_id` 為鍵、payload JSON），**非新表**；策略A 一次分完、`下一輪` 對其無效。

---

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-17 | D-011 進 IN_DISCUSSION | 4 項待裁決逐條與使用者敲定如下，回填後待使用者最終 APPROVED 解鎖 T-018。 |
| 2026-08-17 | 納入單打模式 | 使用者裁決：策略B 加 `[單打]`（court size 參數化，雙打 4／單打 2）；單打無隊友、只最小化重複對手；M 未帶單打 floor(N/2)。**不涉性別**（男女配對屬場邊人工層，性別分組為 v2）。 |
| 2026-08-17 | 策略B 改逐輪 `下一輪` 揭示 | 使用者裁決：`分組 {M}場…` 只出第 1 輪、`{R}輪` 為選填上限（未帶不設上限）；新增 `下一輪` 避開全歷史配對；session 暫存於既有 `conversation_states`（主辦為鍵、R1、不加表/migration）。 |
| #1／#2 | 「出賽數平均」vs「避免連續三輪」優先序 ＋ sit-out 公平定義 | **裁決：出賽數平均優先**（累計 sit-out 次數極差 ≤1 為主），連續三輪為次級軟懲罰。 |
| #3 | 是否於回覆末尾附每人出賽/休息統計 | **裁決：不附**（維持精簡、避免洗版）。 |
| #4 | `分組` 觸發權限是否放寬給所有人 | **裁決：不放寬**，沿用 `canManageEvent`（同關閉報名）。 |
| 2026-08-17 errata | 場名 A-Z；`分組`/`下一輪` host-only | 場名 甲乙→A、B、C…Z（≥26 用「第 M 場」）；授權由 canManageEvent 改 **host_user_id only、排除 super-admin**（取代裁決 #4）。 |
