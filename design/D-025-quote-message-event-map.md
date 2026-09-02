# D-025: 機制 A — quote-reply → `message_event_map`（含跨群校驗 B1）

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §4.1 **逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——G14／AC-28 為跨群資訊外洩的防禦深度（architect-reviewer B1 blocker 的修復），屬授權/隔離類。
- 來源：D-020 §4.1；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。相依：D-021（表由 0006 建立）、D-026（`resolveQuotedEventInGroup` 的插入點）。同屬 T-033b：D-029。

## 一、設計內容

#### 4.1 機制 A：quote-reply → `message_event_map`

- **寫入時機（唯一正確時機）**：`server.ts` 呼叫 `replyClient.replyMessage(...)` 拿到回應後，
  用回應的 `sentMessages[].id`（真正送出的 LINE message id，而非我方組的暫時物件）逐一寫入
  `message_event_map`（G3：不得提前用「即將送出的訊息陣列長度」猜測寫入，reply 可能整則失敗、
  `sentMessages` 的數量/id 以 LINE 回應為準）。
- **`relatedEventId` 如何從 handler 傳到 server**：`WebhookHandler.handleEvent` 回傳型別改為

  ```ts
  export interface HandleEventResult {
    messages: messagingApi.Message[];
    /** 這次回覆若與某一場具體活動相關，其 id；undefined = 不寫入 message_event_map。 */
    relatedEventId?: number;
  }
  export interface WebhookHandler {
    handleEvent(event: WebhookEvent): Promise<HandleEventResult>;
  }
  ```

  `server.ts` 收到後：若 `messages.length>0` 且 reply 成功且 `relatedEventId !== undefined`，
  對 `res.sentMessages` 每個 `id` 呼叫 `messageEventMap.record(id, relatedEventId)`。
- **`ReplyClient.replyMessage` 回傳型別**須從 `Promise<unknown>` 改為 SDK 真型別
  `Promise<messagingApi.ReplyMessageResponse>`（`lineClient` 本就是這個型別，先前只是介面沒宣告，
  現在需要讀 `sentMessages`，補上型別而非新增行為）。
- **哪些送出點要附 `relatedEventId`**：見 §5.3 的完整枚舉表（G4）。
- **讀取（消費 quote）**：`event.message.quotedMessageId`（webhook 文字訊息事件既有欄位，使用者若
  引用了過去某則訊息即帶此值）存在時，`await deps.messageEventMap.getEventId(quotedMessageId)`
  取得 `rawQuotedEventId`（查無 → `undefined`，等同沒有引言）。`MessageEventMapReader`／`Repository`
  加入 `WebhookHandlerDeps`（**必填**，理由同 D-018 §1「選填會讓功能靜默失效」的先例）。
- **讀取後的跨群安全校驗（B1 修復，2026-09-01，architect-reviewer 要求）**：`rawQuotedEventId`
  **尚不可信任**——`message_event_map` 未存 `group_id`，理論上只要某使用者能對一則 bot 訊息引言
  （即便 LINE 用戶端實務上使用者無法跨群引言，本設計此前從未把這個限制明講、也從未被任何
  Guardrail 或 AC 釘死），`rawQuotedEventId` 就可能指向別群的活動。因此在傳入 §4.3
  `resolveTargetEvent` 之前，**必須**於 dispatch 層（§5.2）以 `events.getById(rawQuotedEventId)`
  取得該列，比對 `row.group_id === groupId`：
  - 相符 → `quotedEventId = rawQuotedEventId`（正常往下走既有 §4.3 邏輯）。
  - 不符，或 `row === undefined` → `quotedEventId = undefined`（**視為使用者沒有引言**，不建立任何
    專屬錯誤分支、不回覆任何提及別群活動的文字），交由 §4.3 既有的 none/single/ambiguous/
    `@selector` 分支之一正常決定結果——確保「別群活動是否存在」這件事完全不會透過任何訊息內容
    洩漏（AC-28）。
  - 此校驗**只在 dispatch 層做一次**，`resolveTargetEvent`／`matchSelector` 維持純函式、**不**
    接受 `groupId` 參數、**不**查 DB（G6 不變）；service 層因此**不需要**（也不應該）重複驗證
    `eventId` 所屬 group（見 §5.1 附註、G14）。

## 二、Guardrails（Must NOT）

- **G3（message_event_map 寫入時機）**：只能在 `server.ts` 取得 `replyMessage` 的
  `sentMessages[].id`（真實回應）之後寫入；不得依「即將送出的 `messages` 陣列」預先寫入
  （reply 可能整則失敗、`sentMessages` 的數量/id 以 API 回應為準，不得假設兩者一一對應）。
- **G14（quote 解出的 eventId 須驗證屬於當前群組，B1 修復）**：`message_event_map` 未存
  `group_id`，quote 解出的 `rawQuotedEventId` 不可信任來源；dispatch 層（§5.2）**必須**於呼叫
  `resolveTargetEvent` 之前以 `events.getById(rawQuotedEventId)` 驗證 `row.group_id === groupId`，
  不符或查無 → 視為未引言（`quotedEventId = undefined`），不得直接信任 `message_event_map` 的
  查詢結果、不得建立任何會洩漏別群活動資訊（活動名稱/場地/時間/是否存在）的專屬錯誤分支——結果
  一律落入既有 none/single/ambiguous/`@selector` 分支之一。此驗證只在 dispatch 層做**一次**，
  `resolveTargetEvent`／`matchSelector` 維持純函式（見 G6）；service 層因此**不需要**（也不應該）
  重複驗證 `eventId` 所屬 group（見 §5.1 附註）。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-025 AC-13] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-13]` 會對不上）。

- [ ] **[D-020 AC-13]（quote 命中恰一場）**：使用者引用先前一則屬於活動 B 的 bot 訊息並回覆
  `+1`（無 `@selector`）→ 報名到活動 B。
- [ ] **[D-020 AC-14]（quote 與 selector 衝突）**：使用者引用活動 A 的訊息，但文字帶
  `@活動B場地 +1` → 回「回覆與內文球敘資訊不符，請修正再試」，不執行任何報名。
- [ ] **[D-020 AC-15]（quote 與 selector 一致時不視為衝突）**：引用活動 A 的訊息且 `@selector`
  也命中活動 A → 正常執行（不誤判 conflict）。
- [ ] **[D-020 AC-16]（`message_event_map` 寫入：開團公告）**：`確認` 建立新活動成功後，
  該次 reply 的 `sentMessages[0].id` 被寫入 `message_event_map`，`event_id` = 新建活動 id。
- [ ] **[D-020 AC-28]（跨群 quote 被安全拒絕，B1）**：群組 X 有 2 場 open 活動（需要消歧義的
  情境）；攻擊情境以直接寫入 `message_event_map` 模擬（因 LINE 用戶端實務上使用者無法跨群引言，
  測試不依賴該限制、直接構造資料層情境）一列 `event_id` 指向**群組 Y** 的某活動。群組 X 內使用者
  引用該筆 `message_id` 並回覆 `+1`（無 `@selector`）→ `quotedEventId` 被判定為未引言
  （`undefined`），行為等同「群組 X 有 2 場、無引言、無 selector」→ 回既有 `ambiguous` 提示
  （「群組內有多場球敘進行中...」），**訊息內容不含群組 Y 任一活動的場地／時間／id**；不呼叫
  任何 service、不誤判定到群組 Y 的活動、不 markProcessed。

## 四、errata（T-033b 動工時追加，2026-09-02）

> 落筆者：orchestrator（裁決／實作紀錄，比照 D-007／D-021 前例）；設計主體未改。

### E1：quote 上線後，`eventId` 不再保證 active——受影響路徑全枚舉

> 初版只列了 `close`／`cancel` 一條（architect-reviewer 5b 的要求）。
> **T-033b R2 雙審 architect-reviewer B-1 指出該枚舉不完整**，經查證屬實，本節改為完整清單。

T-033a 期間 quote 恆解出 `undefined`，故所有指令拿到的 `eventId` 必然來自 `listActiveByGroup`
⇒ `status ∈ {draft, open}`。**T-033b 之後不再成立**：§4.3 明定 `quotedEventId` 不過濾「是否仍在
候選集合內」，該場能不能做這件事交給各指令自身的狀態判斷。逐指令盤點結果：

| 指令 | T-033b 前的狀態守門 | 判定 |
|---|---|---|
| `+N`／`-N` | `isOpenForSignup`（status='open' 且未過期） | ✅ 原本就有，無須改動 |
| `加開 N` | `status !== 'open'` → `no_open_event`（`registration-service.ts:450`） | ✅ 原本就有 |
| `編輯`／`編輯`（說明） | 鎖內重讀判 `closed`／非 `open`（`event-service.ts:706-708`） | ✅ 原本就有 |
| `關閉報名`／`取消活動` | 交易外授權先跑、交易內重讀判狀態 | ⚠ 見下方 (1) |
| **`名單`** | **無**（`findEventForDisplay` 註解宣稱「必為 draft/open，天然正確」） | ❌ **缺陷，T-033b 修正** |
| **`分組`／`分組 N場`** | **無**（`grouping-service.ts` 全檔零 status 判斷） | ❌ **缺陷，T-033b 修正** |
| `下一輪` | 不吃 quote（G11，目標活動由 session 決定） | ✅ 不受影響 |

> **表列涵蓋 `NEEDS_EVENT_SET` 全部 9 個成員**（`handler.ts:141-151`）。`編輯` 那列涵蓋兩個
> command type：`edit_event` 與 **`edit_help`**——後者走的是**不同的 render 分支**
> （`renderEdit/help` 會輸出該場活動現值），但共用同一道鎖內守門（`help` 分支在
> `event-service.ts:725`，位於 `:704-709` 的狀態判定**之後**）⇒ 引用已取消活動打 `編輯`
> 不會印出現值。**特意點名，是因為日後有人單獨動 help 路徑時，表上沒點名就擋不住**
> （architect-reviewer 複審 nit，2026-09-02）。

**(1) `close`／`cancel` 的交易外結果會變（規範中的行為，非缺陷）**：非授權者引用一場已關閉活動下
`關閉報名`／`取消活動` → 交易外授權判定先跑，回 `not_authorized` 而**非** `no_active`（交易內重讀
仍正確判 `no_active`／`already_closed`）。授權失敗優先於狀態失敗，兩者都不洩漏活動內容。
日後若要改為「狀態先判」，須另立設計並同步 D-021 §5.1。

**(2) `名單`（已修正）**：`displayPhase` 只認 `{closed, ended, live}`，cancelled 會落到 `live`
⇒ 引用一則指向**已取消**活動的舊訊息打 `名單`，會把它當進行中活動整份印出來。
修正：`findEventForDisplay` 的 `eventId` 分支先過 `DISPLAYABLE_EVENT_STATUSES`
（cancelled/done → `undefined` → `no_open_event`），與下方 fallback 路徑同一條規則；
`closed` 仍可查、標「（報名已截止）」，不過度收緊。

**(3) `分組`（已修正）**：分組原本由「`eventId` 必來自 active 集」隱式保證，本層從未判 status
⇒ 引用舊訊息即可對已關閉／已取消的活動分組並寫入 grouping session。
修正：`groupBalanced`／`startRounds` 加 `isActiveEvent`（`{draft, open}`）守門，**維持 T-033b 前的
語意**（`關閉報名` 後不能再分組）。若日後要開放「關閉報名後才分組」，那是產品決策，另案處理。

回歸鎖：`src/webhook/d025-quote-mapping.test.ts` 的「D-025 errata E1」段（4 條，含未過度收緊的
對照組）。已驗證：移除修正後恰好該 2 條轉紅。

### E2：`message_event_map` 的讀取點（G14 窮舉，T-033b 落地後複驗）

生產碼**只有一處**讀取：`handler.ts` 的 `resolveQuotedEvent` → 立即交給
`resolveQuotedEventInGroup` 以 `events.getById` 比對 `group_id`。repository 的 `getEventId`
無其他呼叫端。**新增讀取點時必須經過 `resolveQuotedEventInGroup`**，不得把
`getEventId` 的結果直接交給 service 或 `resolveTargetEvent`（`conversation_states` 前例：
寫入有存 `group_id`、5 個讀取點全沒用）。
