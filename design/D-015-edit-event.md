# D-015: 編輯活動資訊（`編輯 日期／時間／場地／費用`）

- 狀態：**APPROVED（2026-08-22，使用者核可）** — 三輪 R2 雙審全數封閉（5+2 blocker）+ 使用者最終核可。**2026-08-22 使用者指示動工**：T-026 已派工 backend-engineer，「待動工豁免」行已由 orchestrator 移除（15 條 AC 自此納入 `check_ac_coverage`，未補測試前該關卡會紅——這是刻意的施工中訊號，不得再加豁免繞過）。
- 撰寫者：architect
- 關聯：任務 T-026 ／ 相依 D-002（parser）、D-003 §4（mention）、D-004、D-005、D-006 §2、D-008、D-010、D-012 §2（多行批次）
- 風險等級：**R2（高）**——動 `src/domain/event-service.ts`（CLAUDE.md §4.5 預設高風險模組）＋鎖內 read-modify-write ＋授權。依 §5：雙 reviewer + e2e，Guardrails ≥3（本文件 9 條）。
- 修訂：R2 雙審 5 blocker（A1–A5）已封閉；複審殘留 2 blocker 亦已回填——**F1**（顯示一律用「場地」，`地點` 降為隱藏別名）、**F2**（fee 取值改 compact，`validateVenueFee`／`validatePrice` 不吸收空白）。

## 一、設計內容
**定位**：對 `open` 且未過期的活動，以單行指令改四項欄位之一（日期／時間／場地／費用），只用 reply 回群組，顯示「改前 → 改後」並 @ 提醒正取者。**不新增欄位／migration**（日期與時間共用 `event_datetime`），**不改** `capacity`／`price_mode`／`status`／`settled_per_person`。
### 1. 指令與 parser 契約（`ParsedCommand` 新增 `edit_event`／`edit_help`；`InvalidCommandKind` 新增 `'edit_event'`、`InvalidReason` 新增 `'bad_location'`）
| 輸入（首 token 為 `編輯`） | 產出 | 備註 |
|---|---|---|
| `編輯 日期 2026/09/01`／`編輯 時間 7:30` | `edit_event{field:'date' 或 'time', value}` | 值一律經既有 `validateDate`／`validateTime` 正規化；格式錯 → `invalid{command:'edit_event', reason:'create_bad_date' 或 'create_bad_time'}` |
| `編輯 場地 …`／`編輯 地點 …` | `edit_event{field:'location', value}` | **F1：對外顯示一律用「場地」，`地點` 為 parser 收但文案不示範的隱藏別名**；`value = tokens.slice(2).join(' ')`（**保留空格**，場地名需要；已 `normalizeWhitelist`+trim）；空值 → `edit_help`；長度 > 40（UTF-16 code unit，同 `MAX_PROXY_NAME_LEN` 計法）→ `invalid{reason:'bad_location'}`，**不截斷** |
| `編輯 費用 3000`／`編輯 費用 場地費 4000` | `edit_event{field:'fee', value}` | **F2：`value = tokens.slice(2).join('').replace(/\s+/g,'')`（compact 後再送 validator）**——`validateVenueFee`／`validatePrice` **不吸收空白**（只有被 G6 禁用的 `validateFee` 會 compact），不先壓掉空白則 `場地費 4000`／`2500 元` 會被誤拒；格式須依 `event.price_mode` 判定，parser 無此資訊（見 §2 步驟 5） |
| `編輯 人數 12`／`編輯 人數`（缺值） | `edit_event{field:'capacity', value}` | **一律回導向文案（不落 help）、不執行任何異動** |
| `編輯`／未知欄位名／其他缺新值 | `edit_help` | 回現值＋範例 |

**畸形輸入裁定**：首 token 為 `編輯` 者**一律回覆、不落入 `unknown`**（`編輯` 不會出現在閒聊，不套用 `+N`／`加開` 的靜默防洗版政策；既然無參數 `編輯` 要回現值，`編輯 日期`（缺值）靜默就是「打對一半卻沒反應」的死角）。
**人數不可編輯（理由）**：`registration-service.signup` 以**交易外**的 `event.capacity` 快照作容量決策，安全性依賴 D-010 G1「capacity 單調不減」；開放縮減會靜默超賣。
**已知取捨（「一律回覆」非全域保證，勿誤讀 AC-9）**：(a) 開團問答進行中時，`handler` 的 conversation 攔截**優先於** `parseCommand`，本人在該群打 `編輯 …` 會被當成該題答案（回 field_error，非靜默）；(b) 多行訊息只執行 signup/cancel（D-012 G1），含 `編輯` 的行被靜默忽略。
**場地 40 字上限的已知不一致**：開團路徑目前對場地無長度限制，本設計先在編輯路徑收斂；此不一致**已由 Orchestrator 記入 Backlog**，本文件不逕改開團路徑。
### 2. 介面型別與交易邊界（D-007 路線 A；**不動凍結區 `src/db/tx.ts`**）
| 型別 | 形狀 |
|---|---|
| `EditEventInput` | `{ groupId; executorLineUserId; messageId; request }`，`request = {kind:'set'; field:'date'\|'time'\|'location'\|'fee'; value:string} \| {kind:'capacity'} \| {kind:'help'} \| {kind:'format_error'; field:'date'\|'time'\|'location'; detail?:{len:number}}` |
| `EditEventResult` | `{kind:'ok'; field; before:string; after:string; perPerson?:number; tagOwnerIds:number[]; overflow:boolean} \| {kind:'help'; event} \| {kind:'capacity'} \| {kind:'format_error'; field; detail?} \| {kind:'bad_fee'; priceMode} \| {kind:'past_datetime'; now} \| {kind:'not_authorized'} \| {kind:'no_active'} \| {kind:'closed_not_editable'} \| {kind:'event_ended'} \| {kind:'duplicate'}`。**`overflow := tagOwnerIds.length > MAX_MENTIONS_PER_MESSAGE`，於解析 `line_user_id` 之前判定**（可能高估 → 偏向退化，與 §4 保守取值同理；N-b 釘死，不留第二種算法） |

**handler 分派（N3，必改否則漏 mark）**：`edit_help` 與 `invalid{command:'edit_event'}` **都必須送進 `editEvent()`**（分別轉 `request.kind='help'`／`'format_error'`）；現行 `handler.dispatchSingle` 對非 create/group 的 `invalid` 一律回 `[]`（不回覆、不 mark），照抄即違反 G5。新增 union 成員亦會使 `dispatchSingle` 的 exhaustive `never` 編譯失敗 → 必須補分支。
交易外唯讀 `events.findActiveByGroup(groupId)` **僅用於取 `id` 當鎖鍵**，其欄位不得作決策輸入或「改前值」；取 id 後該列若被並行 flip，鎖內重讀會回 `no_active`（**窄競態、良性，刻意不加補償邏輯**，N10）。
- **(A) 有候選活動** → `runImmediate(id, repos => …)`（`FOR UPDATE` 於 `BEGIN` 後、work 前取得）：
  1. `repos.processed.markProcessed(messageId)` **為第一步**；false → `duplicate`（不回覆）。**置於以下所有拒絕 early-return 之前**。
  2. `fresh = repos.events.getById(id)`（鎖內權威重讀）；`undefined` → `no_active`；`status==='closed'` → `closed_not_editable`；其餘非 `open` → `no_active`；`isExpired(fresh, now)` → `event_ended`。
  3. `canManageEvent(repos.users, superAdmins, fresh, executor)`（共用謂詞，唯讀不 upsert）false → `not_authorized`。
  4. 分派：`help`／`format_error`／`capacity` → 直接回對應結果（已 mark、無 UPDATE）。**這三條唯讀分支仍走同一個 `FOR UPDATE` 入口**：統一入口的可維護性優先於省一次列鎖（刻意取捨，N9）。`set` → 步驟 5。
  5. **改前值一律取自 `fresh`**：date/time → `utcIsoToTaipei(fresh.event_datetime)` 拆本地 `{date,time}` → 只換被編輯的半邊 → `taipeiToUtcIso` 合回 `newIso`；`newIso <= now` → `past_datetime`（不 UPDATE）；否則 `updateEventDatetime`。location → `updateLocation`。fee → 依 `fresh.price_mode` 走 `validateVenueFee`＋`updateVenueFee`，新攤額必須以**改後值**算：`perPersonAmount({...fresh, venue_fee:newFee}, countConfirmed())`（N6）；或 `validatePrice`＋`updatePricePerPerson`；驗證失敗 → `bad_fee`（不 UPDATE）。
  6. 鎖內**只**取該 event 的 confirmed 列（`owner_user_id` 去重後即 `tagOwnerIds`，並據以定 `overflow`），回結果即 COMMIT；**`users.getById` 解析 `line_user_id`／顯示名於交易外進行**（比照既有 `buildPromotionNotice`／`renderAddCapacity`），不得在鎖內做 N+1 查詢延長鎖期（N5）。
- **(B) 無候選活動**（`findActiveByGroup` 回 `undefined`；含 closed 已離開 active 集）→ 仍須消費 `message.id`：`runInTransaction`（DEFERRED，無列可鎖）內 `markProcessed` 後，以 `findLatestDisplayable` 判最新一場是否 `closed` → `closed_not_editable`，否則 `no_active`。
- **時鐘**：`now = nowIso()` 由 service 取一次，下傳過期判定、`past_datetime` 與 formatter；formatter 不得自取時鐘。
- **放置與新原語**：`EventService.editEvent()`；`EventServiceDeps` 新增 `runImmediate: ImmediateRunner`（`server.ts` 注入既有 runner）。`EventRepository` 新增四個 client-bound 寫原語 `updateEventDatetime`／`updateLocation`／`updatePricePerPerson`／`updateVenueFee`（皆 `UPDATE events SET <單欄>, updated_at WHERE id`）。
### 3. 回覆文案（繁中、球種中性；`{}` 為代入值；字串逐字釘死）
- **成功（改前 → 改後）**：日期／時間 `已更新活動時間：{舊 YYYY-MM-DD HH:MM} → {新}`（**恆顯示合併後完整時刻**，讓使用者確認另一半沒被動到）；場地 `已更新場地：{舊} → {新}`；費用(per_person) `已更新每人費用：{舊} 元 → {新} 元`；費用(split) `已更新場地費：{舊} 元 → {新} 元（目前正取 {K} 人，平均每人約 {攤額} 元；暫估，關閉報名後結算）`
- **mention 行**（接於成功句後、**同一則**）：`活動資訊已更新，已報名的各位請確認：{@A} {@B}…`；超限退化（§4）→ 同句根 `活動資訊已更新，已報名的各位請確認。`
- **拒絕**：`not_authorized` → `只有開團的人（或系統管理員）可以編輯活動資訊。`（新 formatter，既有 (H′) 字串不動）；`no_active` → 沿用 `formatNoActiveEvent()`「目前沒有進行中的活動。」；`closed_not_editable` → `報名已截止的活動無法編輯。`；`event_ended` → `活動已結束，無法編輯活動資訊。`
- **格式錯（A3：編輯專用 formatter，**不得**沿用 `formatFieldError` 的開團問答字串——那會叫使用者裸打日期，落入 `unknown` 靜默死角）**：日期 `日期格式不正確，請輸入「編輯 日期 YYYY/MM/DD」（例：編輯 日期 {exampleDate(now)}）。`；時間 `時間格式不正確，請輸入「編輯 時間 HH:MM」（例：編輯 時間 07:30）。`
- **past_datetime**：`不能把活動時間改到過去（現在是 {now}）。請改輸入未來的時間（例：編輯 日期 {exampleDate(now)}）。`　`{now}` 顯示格式釘死 `YYYY-MM-DD HH:MM`（同 `eventDateTimeDisplay`）。
- **bad_fee**：per_person → `本活動是每人固定費用，請輸入金額（例：編輯 費用 2500）。本活動的計費方式無法變更。`；split → `本活動是場地費均攤，請輸入場地費總額（例：編輯 費用 場地費4000）。本活動的計費方式無法變更。`
- **bad_location**：`場地名稱請控制在 40 字以內（你輸入了 {n} 字）。`
- **capacity 導向**（`編輯 人數 N` 與 `編輯 人數` 皆走此）：`人數不能直接編輯。要增加名額請輸入「加開 N」（例：加開 2）；縮減名額目前不支援。`
- **help 全文（A5，逐字釘死）**：`{費用列}` 沿用 `list-formatter.feeLine(event, K, 'live')`——**該函式自帶標籤**（per_person 回 `每人費用：2500 元`；split 回 `場地費：4000 元，平均每人約 N 元（暫估，關閉報名後結算）`），故 code block 內**不得**再加外層 `費用：` 前綴（2026-08-23 errata：原寫 `費用：{費用列}` 會輸出「費用：每人費用：2500 元」重複標籤）；`{現值}` 為 `event.location`；**`{費用範例}` 依 `price_mode` 動態產生**——per_person → `編輯 費用 2500`，split → `編輯 費用 場地費4000`（否則 split 活動照範例打會改錯對象）。標籤與範例關鍵字逐字對齊（F1：一律「場地」）。**註記：現值顯示用 `YYYY-MM-DD`、範例用 `YYYY/MM/DD`，`validateDate` 兩者皆收，非不一致，勿改。**
```
活動目前資訊：
日期：{YYYY-MM-DD}
時間：{HH:MM}
場地：{location}
{費用列}
人數上限：{capacity}

編輯 日期 {exampleDate(now)}
編輯 時間 07:30
編輯 場地 {現值}
{費用範例}
人數請用「加開 N」
```
### 4. 異動成功後 @ mention 正取者（複用 D-003 §4，仍為 reply）
- 產出仍是 `MessageDescriptor{text, mentionees}`，由既有 `handler.toLineMessage` 轉 `TextMessageV2` + `{mN}` substitution。**不得新建 mention 機制、不得用 push／multicast**。
- 對象：**只** confirmed（候補不 tag），依 `owner_user_id` 去重（同一人只 tag 一次）；`kind='proxy'` 列改 tag **代報者本人**（沿用 D-003 §4）。顯示名只取既有快照（`registrations.display_name`／`users.display_name`）。
- 取不到 `line_user_id` → 該人退化為不可點純文字 `@{名字}`（不進 `mentionees`，沿用 D-003 §4 fallback）。
- **數量上限（離線無法確證）**：`@line/bot-sdk@9.5.0` 的 `TextMessageV2.substitution` 是開放 map（OpenAPI 產生、無 maxItems），既有 `toLineMessage` 亦無上限檢查 → 本文件**不臆測數字**；實作時以官方文件確認後填入常數 `MAX_MENTIONS_PER_MESSAGE`，並**取保守值**（AC-13 前置）。**失效語意**：若超限致 reply 400，DB 已 COMMIT 且 `message.id` 已消費 → 使用者看不到成功訊息、重送也不再回覆（正是要保守取值的原因）。
- **超限行為（已裁決）**：`overflow` 為真（定義見 §2 型別表）→ **整則退化為不帶任何 `@` 的提醒句**（`mentionees: []`），不部分 tag、不拆多則。
### 範圍內
- 四欄編輯、鎖內 read-modify-write、`編輯 人數` 導向、help、三種拒絕分流、場地 40 字上限、成功後 @ 正取者、全分支去重、parser／handler／formatter 擴充。
### 範圍外
- **縮減 `capacity`**（另案；前提是先讓 `signup` 鎖內重讀 capacity，已入 Backlog）、切換 `price_mode`、編輯 `closed`／過期／`cancelled` 活動（`關閉報名` 本身已裁決將移除，不為將消失的狀態開路徑）、多輪問答式編輯、**多行批次中的 `編輯`**（D-012 只執行 signup/cancel，靜默忽略）、push／multicast、異動稽核紀錄。
### 將改動的既有文件（預列 errata）
- **`docs/02-api-contract.md`** → 指令一覽新增 6 列（`編輯 日期／時間／場地（隱藏別名 地點）／費用`＋`編輯 人數` 導向＋無參數 `編輯`）、`ParsedCommand` 新增 `edit_event`／`edit_help`、`InvalidCommandKind` 新增 `'edit_event'`、`InvalidReason` 新增 `'bad_location'`。由 api-contract-designer 執行；**章節編號待其核對**（本文件未逐節讀該檔）。
- **D-002（parser）** → §3 dispatch 表新增 `編輯` 分支與別名 `地點`、§1 union／原因碼同上；**`src/webhook/handler.ts`** → `dispatchSingle` 新增 `edit_event`／`edit_help` 分支（exhaustive `never` 會編譯失敗），並讓 `invalid{command:'edit_event'}` 改走 `editEvent()` 而非回 `[]`（N4）。
- **D-004** → §5.1 加註「`編輯` 不觸發狀態轉移（open→open），僅改欄位」；§8 訊息清單新增編輯系列文案並註明 (H′) 僅涵蓋 close/cancel；§9 handler 分派表新增兩型。
- **D-006（A1，兩套相反政策必須顯式界定）＋ D-010** → D-006 §2／G2「非授權者無 DB 變更、不 mark」之範圍**限 `closeEvent`／`cancelEvent`**；D-010 §二 G4「非授權者不得 mark」範圍**限 `addCapacity`**。編輯路徑依 CLAUDE.md §4 去重政策寫入 `processed_events`，為**明文例外**，`users` 仍**不得** upsert。
- **D-008** → §2 三取用語意表新增第四列「編輯用」＝沿用 `findActiveByGroup`＋`isExpired`（closed 判別複用 `findLatestDisplayable`，不新增 accessor）；§六 nit-6 註記「不得改到過去」只在編輯路徑實作，**建立路徑仍未清償**。
- **D-003 / D-005 / D-001** → **無需 errata**：mention 規則原樣複用未改語意；計費公式與 `settled_per_person` 時機不變；schema 不新增欄位、不改約束。
### Conversation state 三件套
**本設計不新增 conversation state。** 理由：四欄皆單值，單行 `編輯 <欄位> <新值>` 即可帶齊；多輪會與 D-013 的 `(group_id, line_user_id)` 單列 session 互相覆寫（開團／分組已共用該列），且須補 (b) 無效答案重問範本才不生靜默死角，成本高於收益。畸形輸入以單則 `edit_help`（現值＋範例）一次解決。
## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）
- **G1（決策輸入必於鎖內取得）**：不得以交易外 `findActiveByGroup` 快照作「改前值」或狀態／過期判定；`event_datetime`／`location`／`price_per_person`／`venue_fee`／`price_mode`／`status` 一律於 `runImmediate(id)` 內經 `getById` 重讀後使用。不得在交易外 `UPDATE events`、不得繞過 `src/db/tx.ts` runner 另開交易、不得修改 `tx.ts`。
- **G2（可寫欄位封閉集）**：單次編輯只能 UPDATE `event_datetime`／`location`／`price_per_person`／`venue_fee` 其中**一欄**；不得寫 `capacity`／`price_mode`／`status`／`settled_per_person`／`group_id`／`host_user_id`；`編輯 人數` 路徑不得產生任何 `events` UPDATE。
- **G3（不得改到過去）**：合併後 `newIso` 必須 `> now`（同一注入時鐘、UTC ISO 字串比較，鎖內判定）；不滿足即拒絕且不 UPDATE。不得存在任何可寫入 `event_datetime <= now` 的分支。
- **G4（授權不得另寫一份）**：一律呼叫 `src/domain/authz.ts` 的 `canManageEvent`；不得複製、內聯或放寬；非授權者不得 UPDATE `events`、不得 upsert `users`（維持唯讀 `getByLineUserId`）。
- **G5（去重全覆蓋）**：所有會送出回覆的分支（ok、help、capacity、not_authorized、no_active、closed_not_editable、event_ended、past_datetime、bad_fee、format_error——**`bad_location` 即 `format_error{field:'location'}`**）都必須 `markProcessed`，且位於該交易內所有拒絕 early-return **之前**；不得有「有回覆卻未消費 `message.id`」的分支（含 handler 對 `invalid` 直接回 `[]` 的既有寫法）；不得對非 `編輯` 開頭的 `unknown` 訊息 mark。
- **G6（複用既有驗證）**：日期／時間／金額格式一律複用 `commands/validators.ts`，不得新寫 regex 或另訂範圍；**費用路徑不得呼叫 `validateFee`**（依前綴自動判模式＝靜默切換 `price_mode`），改以 §1 F2 的 compact 取值後送 `validateVenueFee`／`validatePrice`；場地超長不得截斷（一律回 `bad_location`）。
- **G7（回覆通道與文案）**：只得用 reply，不得 `push`／`multicast`；formatter 不得呼叫 `new Date()`／`nowIso()`（時鐘一律參數注入）；**不得沿用 `formatFieldError` 等開團問答字串**（會指示裸值輸入而落入 `unknown` 靜默）；對使用者示範的文案一律用「場地」，不得示範 `編輯 地點`；新增文案不得引入特定球種用語（CLAUDE.md §0）。
- **G8（mention 對象封閉）**：mention 一律經 `MessageDescriptor.mentionees` + 既有 `toLineMessage`，不得自組 mention JSON、不得改既有 mention 機制。不得 tag 候補或已取消者；同一 `owner_user_id` 不得出現兩次；`kind='proxy'` 不得 tag 被代報者，一律 tag 代報者本人；無 `line_user_id` 者不得進 `mentionees`。
- **G9（超限整則退化＋不新增查詢）**：`overflow` 為真時不得部分 tag、不得拆多則，一律整則退化為無 `@` 提醒句。組 mention 不得新增任何 LINE profile API 呼叫（含 `getGroupMemberProfile`）；不得把 `users.getById` 的 N+1 解析放進 `FOR UPDATE` 鎖內。
## 三、Acceptance Checks（每條註明執行方式）
- [ ] **AC-1（鎖內併發不互相覆蓋）**：兩則不同 `messageId`（一則 `編輯 日期`、一則 `編輯 時間`）對同 event 真並行 → 序列化後 `event_datetime` **同時**反映新日期與新時間。（`npm test`；PG 真並行整合測試，沿用 D-010 AC-3 設施）
- [ ] **AC-2（read-modify-write 保留另一半＋G2 逐欄斷言）**：台北 `2026-08-15 07:30`，`編輯 日期 2026/09/01` → `2026-09-01 07:30`；再 `編輯 時間 6:00` → `2026-09-01 06:00`。並以**整列 before/after diff** 斷言：除 `event_datetime` 與 `updated_at` 外，`events` 所有欄位逐欄相等。（`npm test`）
- [ ] **AC-3（不得改到過去）**：注入固定 now，`編輯 日期 <昨日>`、`編輯 時間 <今日已過時刻>` → 皆回 `past_datetime` 釘死文案（含 `{now}` 為 `YYYY-MM-DD HH:MM`）、`event_datetime` 不變。（`npm test`）
- [ ] **AC-4（授權）**：非 host 且非 super-admin `編輯 場地 X` → `not_authorized`、`events` 無變動、`users` 無新列（僅 `processed_events` 增一列）；host 與 super-admin 皆可成功。（`npm test`）
- [ ] **AC-5（三種拒絕分流）**：`closed` → `報名已截止的活動無法編輯。`；過期 `open` → `活動已結束，無法編輯活動資訊。`；無活動／`cancelled` → `目前沒有進行中的活動。`；三者皆無 UPDATE。（`npm test`）
- [ ] **AC-6（費用兩模式且不切換＋G2 逐欄斷言）**：**前置**：動工前確認 fee 取值已 compact（F2），且 `validateVenueFee`／`validatePrice` 對 `場地費` 前綴／`元` 尾綴的實際行為與本文件一致（N7）。per_person `編輯 費用 2500`／`2500 元` → `price_per_person=2500`、`price_mode` 不變；split `編輯 費用 場地費 4000`（**含空格亦須成功**）→ `venue_fee=4000`、回覆攤額 = `perPersonAmount({...fresh, venue_fee:4000}, K)`、`settled_per_person` 仍 NULL；per_person 收到 `場地費4000` → `bad_fee`、無 UPDATE。每例皆以整列 diff 斷言：除目標欄位與 `updated_at` 外逐欄相等。（`npm test`）
- [ ] **AC-7（人數導向）**：`編輯 人數 12` 與 `編輯 人數`（缺值）→ 皆回導向文案（不落 help）、`capacity` 不變、無任何 `events` UPDATE，且 `message.id` 已消費。（`npm test`）
- [ ] **AC-8（去重全分支）**：對 G5 列舉之每一分支以同 `messageId` 送第二次 → 一律 `duplicate`、不回覆、無二次寫入；特別涵蓋 `edit_help` 與 `invalid(edit_event)` 兩條經 handler 新分支的路徑。（`npm test`，表格驅動）
- [ ] **AC-9（parser 契約；注意 §1 已知取捨，非全域保證）**：`編輯`／`編輯 費率 100`／`編輯 場地`（缺值）→ `edit_help`；`編輯 日期 2026-13-99` → `invalid(create_bad_date)`；`編輯 場地 東方 A 場` 與**隱藏別名** `編輯 地點 東方 A 場` → 同為 `location`、`value='東方 A 場'`（保留空格）；`編輯 費用 場地費 4000` → `value='場地費4000'`（compact）；全形『編輯　日期　2026/09/01』→ 正常解析。（`npm test`）
- [ ] **AC-10（help 逐字比對＋動態日期＋中性）**：`編輯` 回覆與 §3 釘死全文**逐字相等**（標題「活動目前資訊：」＋五列現值〔第 4 列為 `feeLine` 自帶標籤的費用列，**無外層 `費用：` 前綴**〕＋空行＋四條範例＋導向句），**per_person 與 split 兩種 `price_mode` 各比一次**（`{費用列}`／`{費用範例}` 各自正確）；換兩個 now 得兩種 `exampleDate`（證明未寫死、未讀系統時鐘）；全文不得出現「編輯 地點」字樣（F1）。球種中性由 reviewer 逐字檢視，結論記於 `docs/reviews/RP-T-026.md`。（`npm test` + 人工檢視）
- [ ] **AC-11（場地 40 字上限＋G2 逐欄斷言）**：40 字 → 成功且以整列 diff 斷言除 `location`／`updated_at` 外逐欄相等；41 字 → `bad_location` 文案且 `{n}` 為實際字數、**不截斷**、`location` 不變。（`npm test`）
- [ ] **AC-12（mention 對象正確）**：confirmed 3 人（其中一人有兩列自報名＋一列代報名）+ 候補 2 人 → 恰 tag 3 個不重複 owner、不含候補；代報名列 tag 代報者本人；owner 無 `line_user_id` 者以純文字 `@名字` 出現且不在 `mentionees`；訊息型別為 `textV2` + `{mN}` substitution。（`npm test`）
- [ ] **AC-13（超限整則退化）**：**前置**：`MAX_MENTIONS_PER_MESSAGE` 已依**官方出處**確證並填入保守值（無出處前本條不得標記通過，亦不得以「參考值」代替）。`tagOwnerIds.length` = 上限 → 正常 tag；= 上限 + 1 → `overflow` 為真、`mentionees` 為空、文案為退化句、仍為單一則。（`npm test`）
- [ ] **AC-14（不新增 profile 查詢／不延長鎖期）**：spy 驗證編輯成功路徑對 `getGroupMemberProfile` 呼叫次數為 **0**；且鎖內（client-bound repo）的 `users` 查詢次數 **≤ 1**（僅 `canManageEvent` 授權解析那一次），逐人 `users.getById` 一律發生於交易外。（`npm test`）
- [ ] **AC-15（機器關卡全綠）**：`npm run lint`／`npm run build`／`npm test`／`npm run harness:check` 四關全綠，輸出貼於 `docs/reviews/RP-T-026.md`。（四道指令）
## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-22 | 指令兩條／DB 單欄；四欄可編輯；人數不可編輯；僅 open 未過期；不得改到過去；不推播 | 已裁決（載入本文件規格） |
| 2026-08-22 | 縮減名額／通知方式／`closed` 可否編輯／場地長度 | 縮減**不做**入 Backlog；通知改 **@ mention**（複用 D-003 §4、仍 reply）；`closed` **不放寬**但改文案「報名已截止的活動無法編輯。」；場地上限 **40 字**（不一致入 Backlog） |
| 2026-08-22 | 風險等級 | 依 §4.5（動 `event-service.ts`）**升 R2**，雙 reviewer + e2e |
| 2026-08-22 | R2 雙審 5 blocker（A1–A5）＋複審 2 blocker（F1 顯示統一「場地」、F2 fee compact）＋ nit | 全數採納回填；不採納：`formatNoActiveEvent`/`formatNoOpenEvent` 併案（Backlog）、排除編輯者自己、mention 上限直接填 20（須官方出處）、成功句改用「日期」（恆顯示合併時刻為刻意設計） |
| 2026-08-22 | §4 成功後 @ 全體正取者是否採用（使用者稍早曾裁決「標記正取者不做」，理由為需付費推播） | **採用**。兩者情境不同：`關閉報名` 無人下指令故只能 push（計費）；`編輯` 由使用者主動下指令，@ 夾在既有 reply 內（不計費）。使用者確認「多一則 TAG 大家沒問題」 |
| 2026-08-22 | 跨任務衝突（orchestrator 登記） | 與「移除 `關閉報名`」相撞三處（split 文案「關閉報名後結算」、`closed_not_editable` 語意、`findLatestDisplayable` 判 closed）。**不影響本設計正確性**（`closed` 現仍存在）；已登記 `docs/backlog.md`，要求該案設計文件把 D-015 列入預列 errata。 |
| 2026-08-23 | help 費用列重複標籤（實作暴露） | errata：去掉外層 `費用：` 前綴，改為直接嵌入 `feeLine` 自帶標籤（§3 help block 第 5 列 → `{費用列}`；§3 敘述句與 AC-10 同步） |
