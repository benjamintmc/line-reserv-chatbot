# D-030: `下一輪` 開放給「開團的人 + 該場有報名的人」（以 quote 指定 session）

- 狀態：**APPROVED（使用者裁決 2026-10-18）**
- 撰寫者：orchestrator（代 backend-engineer 落筆，實作前交 backend-engineer 接手）
- 風險等級：**R2（高）**——**放寬授權**（取代 D-011 errata 2026-08-17 的 host-only）。雙 reviewer + e2e。
- 關聯：D-011（分組／`下一輪`）、D-025（quote → `message_event_map`、G14 跨群校驗）、D-026（dispatch 消歧義管線）、D-029（`relatedEventId` 送出點）、D-013（conversation 複合 PK）。任務 T-035。

## 一、設計內容

### 範圍內

1. **授權放寬**：`下一輪` 的可執行者從「該 event 的 `host_user_id` 本人」擴大為
   **host 本人 ∪ 該 event 有**未取消**報名列的人**（`registrations.findActiveByOwner(eventId, userId).length > 0`，
   含 waitlist、含其代報名列）。**super-admin 仍不在內**（沿用 D-011 errata 2026-08-17 的排除）。
2. **session 以 quote 指定**：訊息帶 `quotedMessageId` 且經 D-025 §5.2 既有跨群校驗解出
   `quotedEventId` 時，`下一輪` 以 **`(group_id, eventId)`** 撈 grouping session
   （`conversation_states` 中 `state='grouping'` 且 `payload::jsonb->>'eventId'` 相符者），
   而非撈發話者自己的列。推進後**寫回撈到那一列的 `line_user_id`**（＝開團者的列），
   不得在發話者名下另開 session。
3. **無 quote 時維持現狀**：仍以 `(groupId, executorLineUserId)` 撈自己的 session（host 既有體驗零回歸）。
4. **文案補述**（唯一字串改動）：`formatNoGroupingSession()` 末尾加一句引導引用
   ——非主辦不引用時原文案會讓人以為功能壞掉。

### 範圍外

- 不改 `分組`／`分組 N場`（**維持 host-only**）；只有「接續既有 session」放寬。
- 不新增 migration（`eventId` 已存在於 payload，D-029 §5.5）。
- 不讓 `下一輪` 進 `NEEDS_EVENT_SET`、不跑完整消歧義（D-026 G11 不變）：只消費 quote，不吃 `@selector`、不做 ambiguous 分支。
- 不檢查 session 綁定的 event 當下是否仍 active（見「已知取捨」）。

### 已知取捨（使用者 2026-10-18 裁決）

- **競態不處理**：兩人幾乎同時引用 → 兩個 `message.id` 各自 `markProcessed` 通過，會連跳兩輪。
  使用者裁決「當作多宣佈了一輪」，**不加 `FOR UPDATE`**。
- **過期／已關閉的場**：quote 解出的 event 不判 status（`分組` 入口已判過；session 存在即表示當時 active）。

### 改動點（檔案層級）

| 檔案 | 改什麼 |
|---|---|
| `src/db/repositories/conversation-repository.ts` | `ConversationReader` 加 `getGroupingByEvent(groupId, eventId)`；SQL 以 `state='grouping' AND (payload::jsonb->>'eventId')::int = $2` 取單列（`LIMIT 1`，payload 非合法 JSON 的舊列以 `payload IS NOT NULL` + `jsonb` cast 失敗風險見 G4） |
| `src/domain/grouping-service.ts` | `NextRoundInput` 加選填 `quotedEventId?: number`；`nextRound` 依 §2/§3 分流撈 session；新增授權判定 `isHostOrRegistered`；新增 `not_authorized` 到 `NextRoundResult` |
| `src/webhook/handler.ts` | `case 'group_next'` 改傳 `quotedEventId: await resolveQuotedEvent(quotedMessageId, groupId)`；`renderNextRound` 補 `not_authorized` 分支（回 `formatGroupNotHost()` 的新姊妹文案 `formatNextRoundNotAllowed()`） |
| `src/domain/grouping-formatter.ts` | 補 `formatNextRoundNotAllowed()`＝`'只有開團的人或有報名的人可以喊下一輪。'`；`formatNoGroupingSession()` 加引導句 |

### errata E1（2026-10-18，R2 雙審要求；**取代上表 `conversation-repository.ts` 一列的 SQL 寫法**）

> 上表釘的 `WHERE … (payload::jsonb->>'eventId')::int = $2` **會違反它自己的 G4**：Postgres 對非 JSON
> 文字做 `::jsonb` cast 會丟 22P02，而 WHERE 子句**求值順序不保證**——`payload LIKE '{%'` 之類的前置
> 守衛可能被 planner 排在 cast 之後，歷史壞列仍會炸掉整個查詢。
> **落地寫法**：SQL 只篩 `(group_id, state)` 並取回整列（每群 grouping 列預期個位數），
> `eventId` 的比對在 TS 以 `payloadEventId()`（try/catch `JSON.parse` + `typeof === 'number'`）完成
> ——結構上不可能讓查詢報錯。**不得**改回 cast 寫法。
> 連帶：改動點表**增列 `src/db/schema.ts`**——`GROUPING_STATE` 由 `grouping-service.ts` 下放至此、
> 由 `grouping-service.ts` re-export（既有匯入點零改動）。理由：repository 需要該常數，而
> db 層**不得** import domain；字面值仍維持單一來源。

### errata E2（2026-10-18，architect-reviewer B1；**本節新增一項落地要求**）

> **`nextRound` 的 upsert 之前，必須於交易內重讀該列並比對 `state`／`payload`，不一致即回 `no_session`。**
> 理由：`conversation_states` 的 `(group_id, line_user_id)` 是**開團問答 draft 與分組 session 共用**
> 的同一列，而交易 runner 只是 `BEGIN…COMMIT`、不鎖列。D-030 之前 `下一輪` 只寫發話者自己的列
> ⇒ 窗口僅 host 自己可造成；放寬授權後**任一有報名者**都能寫 host 的列：窗口內 host 開始 `開團`
> → draft 被靜默覆寫為 grouping；host 剛 `確認`／`放棄`（delete）→ 已結束的 session 被復活。
> 兩者皆毀掉他人進行中的流程，**與使用者裁決忽略的「連跳一輪」不同級**，故修。
> 不需 `FOR UPDATE`、不宣稱任何鎖。AC-12 為回歸鎖。
> **副作用**：此重讀順帶使「兩人同時喊」收斂為只推進一輪——那是附帶結果，不是本條的理由，
> 下方「已知取捨」的裁決維持不變（即使它再次出現也不視為缺陷）。

### 將改動的既有文件（預列 errata）

- **D-011 errata 2026-08-17（host-only）** → 加註：**僅 `分組` 系列維持 host-only，`下一輪` 自 D-030 起為 host ∪ 有報名者**。
- **D-011 AC-23** → 文案字串變更（`formatNoGroupingSession` 多一句），釘字串的測試同步更新。
- **D-029 §5.5** → 加註：`GroupingState.eventId` 自 D-030 起**不再只是回覆錨點**，同時是 session 的查詢鍵（新增語意，欄位與寫入點不變）。
- **CLAUDE.md §4 去重政策**：新增的 `下一輪 not_authorized` 屬例外 (b)（`markProcessed` 之前 return、全程唯讀、零寫入），與既有 `no_session` 同類；本條依 §4「新增此類分支須在該設計文件明列」於此明列。

### Conversation state 三件套

不新增 conversation state（沿用既有 `grouping`），不適用。

## 二、Guardrails（Must NOT）

- **G1（跨群防線不得下移）**：`quotedEventId` 必須是 dispatch 層 `resolveQuotedEventInGroup` 的產物（D-025 G14）；
  `GroupingService` **不得**自行讀 `message_event_map`、**不得**接收原始 `quotedMessageId`。
- **G2（session 不得易主）**：以 `(group_id, eventId)` 撈到的 session，推進後 `upsert` 的 `lineUserId`
  **必須**是撈到那列的 `line_user_id`；**不得**用發話者的 id 寫回（否則一次「下一輪」就把 session 複製／搬到別人名下）。
- **G3（授權只放寬 `下一輪`）**：`groupBalanced`／`startRounds` 的 `isHost` 判定**不得**改動；
  super-admin **不得**因本次改動取得 `下一輪` 權限。
- **G4（查詢不得因舊列炸掉）**：`getGroupingByEvent` 的 SQL 必須容忍 payload 為 NULL 或非 JSON
  的歷史列（T-033b 前的 session 無 `eventId`）——以 `payload IS NOT NULL` 前置並確保 cast 不會讓整個查詢報錯；
  查無 → `undefined`（走既有 `no_session`），**不得**拋例外。
- **G5（不洩漏別群／別場）**：`not_authorized` 與 `no_session` 的文案**不得**提及活動名稱、場地、時間或「某場存在與否」。

## 三、Acceptance Checks

- [ ] **[D-030 AC-1]** host 開 `分組 2場 3輪`；**該場有報名的甲**引用該分組回覆打 `下一輪` → 正常產出第 2 輪。（`npm test`）
- [ ] **[D-030 AC-2]** 同上，甲改為**引用該場的開團公告**（非分組訊息）打 `下一輪` → 同樣產出第 2 輪（任何映射到該 event 的訊息皆可）。（`npm test`）
- [ ] **[D-030 AC-3]** 該場**沒有報名**的乙引用同一則訊息打 `下一輪` → `not_authorized`、回「只有開團的人或有報名的人可以喊下一輪。」，**輪次不推進**（再由 host 打 `下一輪` 得到的是第 2 輪而非第 3 輪）。（`npm test`）
- [ ] **[D-030 AC-4]（G2）** 甲以 quote 推進後，`conversation_states` 中**只有** host 那一列被更新（`round=2`），甲名下**無**任何 `grouping` 列。（`npm test`，直接斷言 repo 查詢）
- [ ] **[D-030 AC-5]** host **不引用**打 `下一輪` → 與 D-011 AC-21 行為完全一致（零回歸）。（`npm test`）
- [ ] **[D-030 AC-6]（G1 跨群）** 甲在 B 群引用一則映射到 A 群活動的訊息打 `下一輪` → 視為未引用 ⇒ `no_session`；A 群 session **不被推進**、回覆不提及 A 群任何資訊。（`npm test`）
- [ ] **[D-030 AC-7]（G4）** payload 無 `eventId` 的歷史 `grouping` 列存在時，帶 quote 的 `下一輪` 查詢**不拋例外**、回 `no_session`。（`npm test`）
- [ ] **[D-030 AC-8]（G3）** super-admin（在 `ADMIN_USER_IDS`、且該場無報名）引用後打 `下一輪` → `not_authorized`。（`npm test`）
- [ ] **[D-030 AC-9]** 達 `roundsLimit` 後，有報名者引用打 `下一輪` → `exhausted`（授權通過但輪數已盡，文案不變）。（`npm test`）
- [ ] **[D-030 AC-11]** 有報名者**不引用**打 `下一輪` → 回完整兩行引導文案，且他人 session 不受影響。（`npm test`；design-reviewer 2026-10-18 要求：新文案原本零 handler 端覆蓋）
- [ ] **[D-030 AC-12]（E2／B1）** 交易外讀到 session 後、交易內 upsert 前該列已被改成開團 draft → 早退 `no_session`，draft **原封不動**。（`npm test`）
- [ ] **[D-030 AC-10]（真機）** 2 帳號 1 群組：乙 `+1` 後引用分組訊息打 `下一輪`，收到第 2 輪。腳本與記錄落點：`docs/manual-test-T-035.md`。

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-10-18 | 非開團者可否喊 `下一輪` | 可以，授權採「host + 有報名」 |
| 2026-10-18 | 兩人同時喊造成連跳輪次 | 忽略，當作多宣佈一輪 |
