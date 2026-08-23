# D-004: 開團流程（Event Creation：建立 / 確認 / 關閉報名 / 取消活動 + 逐步問答 state machine）

- 狀態：APPROVED（2026-07-31）——R2 雙審通過（architect-reviewer 零 blocker + design-reviewer 2 blocker 已修）、OP-1~OP-9 定案、使用者最終核可
- 撰寫者：backend-engineer
- 風險等級：**R2（高）**——含 host 授權（env 白名單）、event 狀態機轉移、刪除類「取消活動」。依 CLAUDE.md §5：強制 design-reviewer + architect-reviewer 雙審 + e2e，Guardrails ≥ 3（本文件列 10 條）。
- 關聯：Brief FR-3 活動建立（主辦人限定）§34 / FR-4 主辦人管理 §35 / FR-5 訊息規範 §36 / 決策紀錄 #3 同群限一場、#6 env host 白名單 §82/85 / 里程碑 M3 §75 / 成功條件 #3「非主辦人 `開團` 被拒；主辦人可完整走完開團→公告→報名」§11 / 關鍵使用者旅程 #1 §88 ・ 任務 T-008 ・ 設計 D-004
- 相依：
  - **D-001（APPROVED）**：`events` schema、**§7 event 狀態機**、`ux_events_active_group` partial unique index（同群至多一場 active）、`conversation_states` 表、repository 原語（`EventRepository.create/getById/findActiveByGroup/updateStatus`、`ConversationRepository.get/upsert/delete`、`ProcessedEventRepository.markProcessed`、`UserRepository.upsert/getById`）。**本文件只組合這些原語，不重新設計 schema。** 若發現 schema/狀態機不足 → 回報 Orchestrator，不私改 D-001。
  - **D-002（APPROVED）**：`parseCommand()` 已產出 `create_event_oneline` / `create_event_start` / `confirm` / `abort` / `close_event` / `cancel_event` / `my_id` 等 `ParsedCommand`。**本文件消費解析結果，不重做解析、不重做正規化。** 一行式欄位（date/time/location/capacity/price）已由 D-002 §4 正規化與範圍檢查完成。
  - **D-003（APPROVED / 已實作 T-006）**：沿用其架構慣例——domain / formatter 對 LINE 零耦合、handler 為 async + DI、副作用寫入以交易封裝、`markProcessed` 去重、formatter 產 LINE-agnostic `MessageDescriptor`。D-003 handler 分派表對 `create_*`/`confirm`/`abort`/`close_event`/`cancel_event` 目前為 **M2 no-op**，**D-004 將其接上**。D-003 的主辦人 override（`-N 名字`）認 `event.host_user_id`；本文件在 §2 釐清其與 env 白名單的分工。

---

## errata（2026-07-31，來源 D-006 決策 #7「開團人擁有 + super-admin 安全網」；不改本文件 APPROVED 狀態）

> D-006（APPROVED）以更精簡的「模型 B」取代本文件的「env 白名單單軌」授權。**授權判定的權威來源改以 D-006 §1–§2 為準**；本文件下列散文/表格/範本/G/AC 在授權面向已被 D-006 覆寫，errata 逐項標註如下（實作見 T-011）：

1. **§1 host 授權（整段授權模型）**：「誰能開團＝env 白名單」→ **開團全開（群內任一成員皆可開團，移除 `create_*` 授權）**；`關閉報名`/`取消活動` 授權 = **該活動 `event.host_user_id`（開團的人）∪ super-admin（env `ADMIN_USER_IDS`）**（`canManageEvent`）。報名 override（`-N 名字`）仍認 `host_user_id`（不變）。
2. **§5.2 close/cancel 授權段**：「handler 先做白名單檢查」→ **service 內 `canManageEvent`（進交易前判定，非授權 early-return 不 mark、無 DB 變更）**；且 **`no_active` 判定前移至交易外 early-return**（授權需先 `findActiveByGroup` 讀 `host_user_id`），不再於交易內 mark 之後判定。
3. **§7 型別/模組**：`EventServiceDeps.hostUserIds` → **`superAdminUserIds`**（仍由 server.ts 以 `config.adminUserIds` 注入）；`CreateEntryResult` 移除 `not_authorized`；`InvalidOnelineResult` 收斂為單一 `{ kind:'format_help' }`；handler/server 授權欄相應調整（handler 不再前置白名單、`my_id` 由 no-op 接線）。
4. **§9 分派表授權欄**：`create_event_oneline`/`create_event_start`/`invalid(create_event)` 授權欄「白名單」→ **「無（開團全開）」**；`close_event`/`cancel_event` 授權欄「白名單」→ **「canManageEvent（host_user_id ∪ super-admin）」**；`my_id` 由「no-op」→ **接線回 (MyID)**。
5. **§9 去重政策散文**：原載「生命週期指令…最終判定即使是拒絕（no_active…）仍消費 messageId」——模型 B 下 **`close/cancel` 的 `no_active`（與 `not_authorized`）已前移至交易外 early-return、不再 mark**（授權需先讀 active）。其餘交易內拒絕（`already_closed`、`確認` 撞約束 (L)、`duplicate`）仍於交易內 mark（不變）。
6. **G1（授權只認注入白名單）**：重寫為模型 B——**開團不得含任何授權 gate（全開）**；`close/cancel` 授權**只得**依 `canManageEvent = superAdminUserIds.has(lineUserId) ∨ (getByLineUserId(lineUserId).id === event.host_user_id)`，非授權者不得改狀態/不得 mark/**不得 upsert 寫任何 users 列（唯讀解析）**。等同 D-006 G1+G2+G3。
7. **AC-10 語意**：由「非白名單 `開團`/`關閉`/`取消` 被拒」→ **`開團` 不再被拒（全開）；改為「非建立者非 super-admin `關閉報名`/`取消活動` 被拒、無 DB 變更（含 users 無新列）」**（對應 D-006 AC-1/4/5）。
8. **訊息 (H)→(H′)**：「只有主辦人可以開團／管理活動。」→ **「只有開團的人（或系統管理員）可以關閉報名／取消活動。」**（開團已全開，無「非授權開團」訊息；此 formatter 僅剩 close/cancel 使用）。
9. **訊息 (I) 用詞**：「（…請**主辦人**先輸入『取消活動』…）」→ **「（…請**開團的人**先輸入『取消活動』…）」**，與 (H′) 用詞一致（design-reviewer B3）。
10. **全文「白名單 host 開團」措辭總括**：§範圍內與 AC-1/2/3/6/11 等前提所述「白名單 host `開團…`」，在開團全開下一律改讀為 **「任一群成員開團」**（建立者即 `host_user_id`）。

---

## errata（2026-08-18，跨群語意；來源：使用者實測回報之 bug，修正見 T-018 修復批次；不改本文件 APPROVED 狀態）

> **問題**：`conversation_states` 的 PK 是 `line_user_id`（**跨群唯一**，非 `(group_id, line_user_id)`）。§3.3 的攔截偽碼只寫「若 `conversationRepo.get(userId)` 存在 → `continueFlow`」，**未比對來源群**。實測後果：同一人在 A 群開團到一半，於 B 群的任何發言都被當成 A 群流程的答案（B 群的 `+1`/`名單` 失效、雜訊被吞、A 群 draft 被誤填）。
>
> **修正語意（權威）**：進行中流程**綁定它發生的那個群**。
>
> 1. **§3.3 攔截條件**：`conversationRepo.get(userId)` 存在 **且 `conv.group_id === 來源 groupId`** 才視為流程答案；否則**不攔截**，該訊息照走 step 2 正常分派（`+1`／`名單`／雜訊靜默各自正常），且原群流程**原封保留**（不前進、不放棄、不 mark）。
> 2. **§3.4 控制指令同樣受群綁定**：別群的 `確認` **不得**用 A 群 draft 在 B 群建立活動（→ `noop`）；別群的 `取消` **不得**放棄 A 群流程（→ `noop`）。故 `AbortInput` 增 `groupId`，`continueFlow`/`confirm`/`abort` 皆於 domain 層先比對 `conv.group_id`（handler 攔截處 + domain 雙防線，domain 為權威）。
> 3. **§3.3「per-user 隔離」措辭**：原文「只有正在開團的 host 自己的訊息被攔截」僅保證**同一人**，**不保證同一群**——應讀為「**同一人且同一群**」。
> 4. **[D-004 AC-15] 語意擴充**：除既有「同群其他成員不受影響」外，新增「**同一人在別群的訊息亦不受影響**」——A 群 awaiting_* 時，該人在 B 群 `+1`/`名單`/雜訊/`確認`/`取消` 皆走一般 dispatch，A 群 conversation 的 `state`/`payload` 不變。（驗證：`src/webhook/event-handler.test.ts` 之 `[D-004 errata 跨群]` 三條整合測試）
> 5. **不動 schema**：`conversation_states.group_id` 欄位**已存在**且 upsert 已寫入，本修正純為讀取端比對，**不新增 migration**、不改 PK。已知取捨（不變）：一人同時只能有一段進行中流程。
> 6. **(N2) 本次修正「新暴露」的靜默死角，已於同輪一併處理（非既有行為）**：
>    - **修正前該路徑不可達**——在 B 群輸入 `開團` 會被攔截成 A 群當前欄位的答案（`applyAnswer` 判格式錯 → 重問），A 群 draft **不會**被覆寫。
>    - **修正後**不再攔截 → `startCreation`／`handleOneline` 無條件 upsert（PK=`line_user_id`）會**靜默**覆寫 A 群半成品 draft，使用者回 A 群作答時 `parseCommand` → `unknown` → **完全無回覆**，正是 §3.3／B2 當初刻意消除的靜默死角。
>    - **處理**：兩個入口於**交易內**（與 upsert 同連線，避免 TOCTOU）先讀既有 conversation，回報 `abandoned: 'create' | 'grouping'`；handler 於既有 (A)/(B) 回覆前附 **(N2)** 告知句——`create` →「已放棄你先前未完成的開團。」、`grouping` →「已結束你先前未完成的分組。」。**刻意不透露前一段流程屬於哪一群、亦不透露其任何內容**（時間／場地／人數／費用／群組名皆不出現）：若讀者能據措辭判斷「那是別群的流程」，等同把他群活動的存在洩漏給本群成員（＝本輪所修的同一類洩漏）。兩句措辭對「同群分組」與「別群開團」皆成立，無法據此區分來源群。
>    - `state='grouping'`（分組 session）被覆寫時**同群亦可達**（grouping 不被 §3.3 攔截），故一併納入。
>    - 驗證：`src/webhook/event-handler.test.ts` `[D-004 errata N2]` 兩條（含「回覆不含 A 群 draft 任何欄位」的反向斷言）＋ `src/domain/event-service.test.ts` `[D-004 errata N2]` 一條（三種 abandoned 判定）。
>    - **關聯 OP-6（conversation TTL）**：本項只消除「靜默」，未消除「一人一段流程」的根本限制。若日後要支援跨群並行流程，須改 PK 為 `(group_id, line_user_id)`（＝migration ⇒ R2），已登記 Backlog。

## errata（2026-08-19，來源 D-013 T-022「conversation_states 改以 (group_id, line_user_id) 為 PK」；不改本文件 APPROVED 狀態）

> D-013（APPROVED，R2）以 **migration 0004** 根治跨群問題：`conversation_states` 的 PK 由 `line_user_id` 改為 **`(group_id, line_user_id)`**。上方 2026-08-18 errata 的**第 5 條與第 6 條已被取代**：
>
> - **取代第 5 條**（「不動 schema、不改 PK；已知取捨：一人同時只能有一段進行中流程」）：schema **已變更**（0004）。同一人在**不同群**可各有一段進行中流程並**並行共存**；互斥範圍縮小為**同群內**（開團問答 ↔ 分組 session 仍共用該群那一列）。跨群不可讀由**結構**保證（查詢鍵含 `group_id`），第 1–4 條的讀取端比對**全部保留**為縱深防禦（D-013 G3）。
> - **取代第 6 條**（(N2) 告知句）：`abandoned: 'create'`（「已放棄你先前未完成的開團。」）**已移除**——查詢鍵改為複合鍵後，撈回的 `prev` 由構造必然同群，該分支恆不可達（**理由是構造性，非「handler 已攔截」**；handler 攔截讀在交易外且 `server.ts` 以 `Promise.all` 並行，有 TOCTOU，不可倚賴）。`grouping` 告知句（「已結束你先前未完成的分組。」）**保留**且仍可達（同群分組 session 被 `開團` 覆寫）。
> - 驗證改由 `[D-013 AC-1]`（`src/webhook/event-handler.test.ts`：兩列並存、無告知句）與 `[D-013 AC-7]`（`src/domain/event-service.test.ts`：別群列不再被視為 abandoned）承接；`[D-013 AC-4]` 覆蓋保留的 grouping 告知句。
> - 權威來源：`design/D-013-conversation-scope-pk.md`。本文件其餘攔截語意與 (N2) 文案敘述仍有效。

## errata（2026-08-23，來源 D-015／T-026「編輯活動資訊」；不改本文件 APPROVED 狀態）

> D-015 新增 `編輯 日期／時間／場地／費用`（T-026）。對本文件的影響僅三處，**授權模型與狀態機本體不變**：
>
> 1. **§5.1 轉移表**：`編輯` **不觸發任何狀態轉移**（`open → open`，只改 `event_datetime`／`location`／`price_per_person`／`venue_fee` 其中一欄），故轉移表**不需新增列**；但須註明「並非所有生命週期指令都會改 status」——`編輯` 是第一個只改欄位的指令。其可用前提與 close/cancel 相同（`open` ∧ 未過期），`closed` 另回專屬文案（D-015 §3）。
> 2. **§8 訊息清單**：新增編輯系列文案（成功「已更新…：舊 → 新」＋@ 正取者、`not_authorized`、`no_active`、`closed_not_editable`、`event_ended`、`past_datetime`、`bad_fee`、`bad_location`、格式錯、`編輯 人數` 導向、無參數 `編輯` 的現值清單）——**逐字釘死於 D-015 §3，不在本文件複製**（避免雙份字串漂移）。既有 **(H′) `formatNotAuthorized` 僅涵蓋 close/cancel**，編輯**另立** formatter（既有字串一字不動）；(C) `formatFieldError` 亦**不得**被編輯路徑沿用（其提示「請輸入 YYYY/MM/DD」會誘使使用者裸打日期而落入 `unknown` 靜默，D-015 G7）。
> 3. **§9 分派表 / 去重政策**：`dispatchSingle` 新增 `edit_event`／`edit_help` 兩分支（新增 union 成員會使 exhaustive `never` 編譯失敗，必補）；且 `invalid{command:'edit_event'}` **不得**沿用「非 create/group 的 invalid 一律回 `[]`」——須送進 `eventService.editEvent()`。**去重政策**：編輯路徑依 CLAUDE.md §4，**所有會回覆的分支（含 `not_authorized`）一律於交易內 `markProcessed`**，與本文件 §9 散文所述 close/cancel「拒絕於交易外 early-return 不 mark」**刻意不同**（該做法成文於 §4 政策之前，依 §4.5 不回溯）。兩者各有適用範圍，勿判為矛盾。
> 4. **權威來源**：`design/D-015-edit-event.md`（APPROVED，R2 三輪雙審封閉）。**插入者**：orchestrator 代筆——撰稿為 architect，因其 subagent 僅有 Read/Write、整檔重寫 594 行會被截斷而毀檔，故改由 orchestrator 精準插入；內容未經改動。

---

## 一、設計內容

### 0. 定位與前提

D-004 實作 **M3 開團流程 domain 邏輯 + webhook 接線**：把 D-002 解析出的開團/生命週期指令，透過 D-001 的 repository 原語轉成 event 的建立與狀態轉移，並產出繁體中文回覆（開團摘要、逐步問答提問、確認摘要、公告、關閉/取消回覆、授權/重複/格式錯誤回覆）。

**與 M2（D-003）的銜接**：本文件負責把活動帶到 `status='open'`；一旦 open，D-003 的 `+N`/`-N`/`名單` 即可作用（成功條件 #3「開團 → 公告 → 報名」的前半段）。M2 假設「已存在一場 open 活動」，**該假設由本文件的 `確認` 流程滿足**。

**架構慣例（沿用 D-003，不得破壞）**：

- domain（`event-service` / `create-flow`）與 formatter（`event-formatter`）**只透過 repository 存取，不直接下 SQL**，**不 import LINE SDK 型別**（G5）。
- 對使用者的 LINE 回覆一律繁體中文；只回應可識別且該情境可執行/需引導的指令（FR-5 防洗版）。
- 有副作用的寫入（conversation_states 逐步收集、`確認` INSERT event、`關閉報名`/`取消活動` updateStatus）一律在**交易內、以 `markProcessed` 為第一步**，達成 exactly-once 副作用（G4）。

### 1. host 授權（R2 核心）

**「誰能開團」＝環境變數白名單**（決策 #6、D-001 Q1：授權只認環境變數，不用 `users.is_host`）。實作上以 `config.adminUserIds`（env `ADMIN_USER_IDS`，比對傳訊人 `line_user_id`）為白名單來源。 _**errata(2026-07-31，來源 D-006 決策 #7)：本段作廢——開團全開（無白名單），`config.adminUserIds` 改作 `superAdminUserIds`（close/cancel 安全網），詳見本文件頂部 errata 與 D-006 §1–§2。**_ **domain 不得讀 `process.env`**：白名單以 DI 注入（`hostUserIds: ReadonlyArray<string>`，由 `server.ts` 從 `config.adminUserIds` 傳入），維持 domain 純度（G1、沿用 D-003 domain 不觸 env 慣例）。

**受授權保護的「生命週期入口」指令**（傳訊人須在白名單，否則不得改狀態）：

| 指令 | `ParsedCommand.type` | 授權要求 |
|---|---|---|
| 一行式開團 | `create_event_oneline` | 白名單 |
| 逐步開團 | `create_event_start` | 白名單 |
| 關閉報名 | `close_event` | 白名單（見 OP-3 範圍裁決） |
| 取消活動 | `cancel_event` | 白名單（見 OP-3 範圍裁決） |

**`確認` / `取消`（confirm / abort）不另做白名單檢查**：此二者僅在傳訊人**自己有進行中的 `conversation_states`** 時才有語意（見 §3.4），而 conversation_states 只可能由通過白名單檢查的 `開團` 建立 → 授權「隱含由對話流程擁有權保證」（per-user PK 隔離）。無進行中流程時 confirm/abort → **靜默 no-op**（G9）。

**「開團者（host）」與 `events.host_user_id` 的關係**：`確認` 建立 open event 時，`host_user_id = 建立者（該白名單使用者）的 user.id`（先 `userRepo.upsert` 取得）。此值供 **D-003 的 `-N 名字` 主辦人 override** 使用（D-003 認 `event.host_user_id`）。

**授權來源分工（重要，對接 OP-3）**：
- **生命週期指令（開團 / 關閉報名 / 取消活動）授權 = env 白名單**（任一白名單使用者皆可，MVP host 可互換）。
- **報名 override（`-N 名字` 代取消他人代報名額）授權 = `event.host_user_id`**（D-003 既有，僅該活動建立者）。
- 兩者刻意分離：env 白名單決定「誰能開/關/取消活動」，`host_user_id` 決定「誰是這場活動的主辦人（可 override 名單）」。此分工列為 **OP-3** 交使用者確認。

### 2. 開團兩路徑總覽

兩條路徑最終都經 **`確認`** 才建立 open event（Brief §34「建立前顯示摘要待 `確認`」、旅程 #1）。差別只在「欄位如何收集」：

| 路徑 | 觸發 | 欄位收集 | 收集後 |
|---|---|---|---|
| 一行式 | `create_event_oneline`（date/time/location/capacity/price 已由 D-002 §4 正規化齊備） | 一次帶齊 | 寫 `conversation_states`（state=`awaiting_confirm`，payload=完整）→ 回摘要待 `確認` |
| 逐步問答 | `create_event_start`（無參數） | state machine 逐欄問答 | 逐步寫 `conversation_states`；收齊 → state=`awaiting_confirm` → 回摘要待 `確認` |

**共同的暫存策略（對齊 D-001 §4 建議）**：開團期間的欄位**存於 `conversation_states.payload`（JSON），直到 `確認` 才 `INSERT events`（status 直接為 `'open'`）**。好處：（a）draft 列不長期滯留；（b）`確認` 的 INSERT open 直接受 `ux_events_active_group` 檢驗，兩位主辦人同時完成問答時第二個 `確認` 被 DB 拒絕（單一進行中活動安全網）。**推論：MVP 下 `events.status='draft'` 不被物化**——「draft 階段」由 `conversation_states` 承載。此為狀態機的實作解讀，列為 **OP-5** 交使用者確認（若使用者要求物化 draft 列，改採「INSERT draft → `確認` flip open」，見 OP-5 備選）。

### 3. 逐步問答 state machine（`create_event_start`）

#### 3.1 state 與 payload

`conversation_states`（D-001 §4）：PK=`line_user_id`、`group_id`、`state`、`payload`(JSON)、`updated_at`。本文件定義 `state` 合法值（schema 只存字串、不在 DB 強制列舉）：

| state | 語意 | 期待輸入 | payload 累積 |
|---|---|---|---|
| `awaiting_date` | 問日期 | `YYYY/MM/DD` 或 `YYYY-MM-DD` | `{}` → `{date}` |
| `awaiting_time` | 問時間 | `HH:MM`（或 `H:MM`） | `{date}` → `{date,time}` |
| `awaiting_location` | 問地點 | 任意非空字串（可含空白） | `+{location}` |
| `awaiting_capacity` | 問人數上限 | 正整數（可帶尾綴 `人`） | `+{capacity}` |
| `awaiting_price` | 問每人價格 | 非負整數（可帶尾綴 `元`） | `+{price}` |
| `awaiting_confirm` | 摘要待確認 | `確認` / `取消` | 完整 payload |

**payload JSON 型別（嚴禁 any；設計說明用）**：

```ts
// 部分收集中的 event 欄位；欄位齊備後即等同 create event 所需輸入
interface CreateEventDraft {
  date?: string;      // 'YYYY-MM-DD'（存正規化後）
  time?: string;      // 'HH:MM'
  location?: string;  // 原樣（trim）
  capacity?: number;  // 正整數
  price?: number;     // 非負整數（元）
}
```

**逐步問答的 location 可含空白**（相對於 D-002 §4 一行式 location 限單一 token）：逐步問答每則訊息整串即該欄答案，故「東方 高爾夫」這類含空白地名在此路徑可用（呼應 D-002 O-5「含空白地名走逐步問答」）。

#### 3.2 逐欄狀態轉移

```
(無流程) ──開團(create_event_start)──► awaiting_date
awaiting_date  ──(合法日期)──► awaiting_time     ──(非法)──► 停留 awaiting_date + 重問
awaiting_time  ──(合法時間)──► awaiting_location ──(非法)──► 停留 awaiting_time + 重問
awaiting_location ──(非空)──► awaiting_capacity
awaiting_capacity ──(合法人數)──► awaiting_price ──(非法)──► 停留 awaiting_capacity + 重問
awaiting_price ──(合法價格)──► awaiting_confirm  ──(非法)──► 停留 awaiting_price + 重問
awaiting_confirm ──確認──► INSERT events(open) + 公告 + 清 conversation_states
awaiting_confirm ──取消──► 清 conversation_states + 回「已取消開團」
任一 state ──取消(abort)──► 清 conversation_states + 回「已取消開團」
```

- **欄位驗證**：日期/時間/人數/價格的格式與範圍**與 D-002 §4 完全一致**（同一 source of truth）。為避免重複規則，建議**由 commands 層匯出 per-field 驗證純函式**（`validateDate/validateTime/validateCapacity/validatePrice`）供本流程複用（見 §7 與 OP-10；此為 parser 層擴充、非契約變更，須與 D-002 協調 → 回報 Orchestrator）。
- 驗證失敗：**停留同一 state**、`updated_at` 更新、回「格式錯誤 + 該欄正確格式」重問（§8 範本），**不前進、不 INSERT**。
- 每前進一步即 `conversationRepo.upsert(...)` 覆寫 state 與 payload（per-user PK，idempotent）。

#### 3.3 handler 對「進行中流程」的攔截（webhook 分派順序調整）

逐步問答的答案（如 `2026/08/15`）本身**不是指令**（`parseCommand` 會回 `unknown`）。因此 handler 分派需**先檢查傳訊人是否有進行中 conversation_states**：

```
handleEvent(text, groupId, userId, messageId):
  1. 若 conversationRepo.get(userId) 存在（進行中開團流程）：
       → 交 eventService.continueFlow({ userId, groupId, messageId, text })
         （內部：parseCommand 僅用來辨識 confirm/abort；其餘整串 text 當該欄答案）
  2. 否則 parseCommand(text) → 依 type 分派（含 create_event_* / close / cancel 及 D-003 的 signup/cancel/list）
```

- **per-user 隔離**：conversation_states 以 host 的 `line_user_id` 為 PK，故**只有正在開團的 host 自己**的訊息被攔截為答案；**同群其他成員的 `+N`/`名單` 完全不受影響**（走 step 2 正常分派）。此為關鍵正確性保證。
- **mid-flow 控制集**：流程中僅 `確認`（confirm）與 `取消`（abort）被視為控制指令；其餘整串文字一律當作**當前 state 的欄位答案**（含使用者恰好輸入 `名單`/`+1` 等——在流程中一律視為答案，見 OP-7）。`確認` 僅在 `awaiting_confirm` 生效，其他 state 下的 `確認` 視為該欄答案（多半格式錯 → 重問）。`取消` 在**任一 state** 皆放棄流程。
- **`awaiting_confirm` 的無欄位特例（design-reviewer B2）**：`awaiting_confirm` 此時**已無待填欄位**，故該 state 下若輸入非 `確認`/`取消`（如 `OK`/`好`/`確定`/`yes`）→ 回 `ContinueFlowResult.confirm_reprompt` → formatter (M) **重新提示**（停留 awaiting_confirm、不建立、不前進）。消除「輸入了卻無回覆」的靜默死角。

#### 3.4 confirm / abort 語意（stateless token → 依 conversation_states 解讀）

- `確認`（confirm）：
  - 有流程且 `state==='awaiting_confirm'` → **建立 open event**（§4）。
  - 有流程但非 `awaiting_confirm` → 視為當前欄位答案（§3.3）。
  - **無流程 → 靜默 no-op**（G9；避免誤觸洗版）。
  - （`awaiting_confirm` 下非 `確認`/`取消` 的其他輸入 → 重新提示 (M)，見 §3.3 特例、B2。）
- `取消`（abort）：
  - 有流程（任一 state）→ `conversationRepo.delete(userId)` + 回「已取消開團」。
  - **無流程 → 靜默 no-op**（G9）。

### 4. `確認` 建立 open event（draft→open 轉移的實作）

`確認` 於 `awaiting_confirm` 觸發，於**單一交易**內（`markProcessed` 為第一步）：

```
runInTransaction(() => {
  1. if (!processed.markProcessed(messageId)) return { kind:'duplicate' }   // G4 去重
  2. draft = JSON.parse(conversation.payload)  // 應已欄位齊備
  3. active = events.findActiveByGroup(groupId)
     if (active !== undefined && active.status ∈ {open,closed})            // G3 入口再確認
        return { kind:'already_active', active }
  4. host = users.upsert(userLineUserId, hostDisplayName)                  // host_user_id 來源（G8）
  5. try {
       event = events.create({ groupId, hostUserId: host.id, eventDate:draft.date,
                 eventTime:draft.time, location:draft.location, capacity:draft.capacity,
                 pricePerPerson:draft.price, status:'open' })              // 直接 open（OP-5）
     } catch (err) {                                                       // G3 安全網
       if (!isUniqueConstraint(err, 'ux_events_active_group')) throw err   // 窄捕捉：非唯一約束一律 re-throw（architect 裁定 1）
       conversation.delete(userLineUserId)                                 // 清落敗者流程，不卡 awaiting_confirm（nit-2）
       return { kind:'already_active' }                                    // → formatter (L)；ux_events_active_group 撞約束
     }
  6. conversation.delete(userLineUserId)                                   // 流程結束
  return { kind:'ok', event }
})
```

- **併發安全網**：兩位 host 同時 `確認`（各自 conversation_states）→ 第一個 INSERT open 成功；第二個 INSERT 撞 `ux_events_active_group`（唯一約束）→ catch → 回 `already_active`（不 crash、不外洩例外，G3）。better-sqlite3 為同步單行程，交易序列化；跨行程時唯一約束為最終防線。
- **交易後**：formatter 產「開團成功公告」（活動摘要 + 報名方式），reply 至群組 → 成員可即刻 `+N`（銜接 M2）。
- **host_user_id 快照名**：step 4 upsert 需 host 顯示名，由 handler 以 `getGroupMemberProfile(groupId, userId)` 取得（沿用 D-003 §7 取名慣例與 fallback）。

### 5. event 狀態機（對齊 D-001 §7）與生命週期指令

**MVP 物化的 events.status ∈ {open, closed, cancelled}**（draft 由 conversation_states 承載，OP-5；done 非本文件範圍，屬活動結束後處理）。

#### 5.1 合法轉移表

| 目前狀態 | 指令 | 轉移 | 實作 | 非法時處置 |
|---|---|---|---|---|
| （無流程 / 無 active event） | `開團` | → conversation flow（awaiting_date / awaiting_confirm） | 寫 conversation_states | 若已有 active（open/closed）→ 拒絕「已有進行中活動」（§8） |
| conversation `awaiting_confirm` | `確認` | 概念 draft→open | **INSERT events status='open'**（§4） | 非 awaiting_confirm 之 `確認` 視為欄位答案 |
| conversation（任一） | `取消`(abort) | 概念 draft→（放棄） | `conversation.delete` | 無流程 → 靜默 no-op |
| `open` | `關閉報名`(close_event) | open→closed | `events.updateStatus(id,'closed')` | 見 5.2 |
| `open` | `取消活動`(cancel_event) | open→cancelled | `events.updateStatus(id,'cancelled')` | 見 5.2 |
| `closed` | `取消活動`(cancel_event) | closed→cancelled | `events.updateStatus(id,'cancelled')` | 見 5.2 |
| `closed` | `關閉報名`(close_event) | — | **非法**（已 closed） | 回「活動已關閉報名」（§8） |
| `cancelled` / `done` | 任何生命週期指令 | — | **終態不可轉移** | 回「目前沒有進行中的活動」（§8） |

- **`EventRepository.updateStatus` 不校驗轉移合法性**（D-001 註：合法性屬 domain）。故 **domain 必須先 `findActiveByGroup` 讀當前 status、判定合法後才呼叫 `updateStatus`**（G2）。非法轉移**一律不呼叫 updateStatus**、只回提示。
- **`closed → open`（reopen，D-001 §7 選配）**：無對應 parser 指令（D-002 未定義），**MVP 範圍外**（OP-11）。

#### 5.2 close_event / cancel_event 流程

於**單一交易**內（`markProcessed` 第一步）：

```
// close_event（關閉報名）
runInTransaction(() => {
  if (!processed.markProcessed(messageId)) return { kind:'duplicate' }
  active = events.findActiveByGroup(groupId)
  if (active === undefined || active.status === 'cancelled')  return { kind:'no_active' }
  if (active.status === 'closed')                             return { kind:'already_closed' }
  if (active.status !== 'open')                               return { kind:'no_active' } // draft 未物化
  n = events.updateStatus(active.id, 'closed')               // open→closed
  return { kind:'ok', event: {...active, status:'closed'} }
})

// cancel_event（取消活動）——刪除類 R2
runInTransaction(() => {
  if (!processed.markProcessed(messageId)) return { kind:'duplicate' }
  active = events.findActiveByGroup(groupId)
  if (active === undefined || active.status === 'cancelled')  return { kind:'no_active' }
  // open 或 closed 皆可取消
  events.updateStatus(active.id, 'cancelled')                // → cancelled（終態）
  return { kind:'ok', event: {...active, status:'cancelled'} }
})
```

- **`取消活動` 是狀態轉移，不刪 registrations**（D-001 §7 註、G10）：報名/取消稽核軌跡一併保留（`cancelled_at`/`cancelled_by_user_id`）。轉 `cancelled` 後該 group 的 active 集合清空 → 可再 `開團`。
- **授權**：close/cancel 於呼叫 service 前，handler 先做白名單檢查（§1）；非白名單 → 依 OP-2 政策回覆（不進交易、不改狀態）。
  - **errata(2026-07-31，來源 D-006 決策 #7)**：改為 **service 內 `canManageEvent`（進交易前判定）**——handler 不再前置白名單。授權需先 `findActiveByGroup` 讀 `host_user_id`，故 **`no_active` 與 `not_authorized` 皆於交易外 early-return、不 mark、無 DB 變更**；交易內權威重讀 active 後才做狀態合法性判定與 `updateStatus`（結算不變）。

### 6. 同群一場 active 約束（對接 `ux_events_active_group`）

- **入口先查**：`開團`（create_event_*）進入前，`events.findActiveByGroup(groupId)`；若存在且 status ∈ {open, closed} → **拒絕開團**，回「已有進行中活動」+ 現有活動摘要（§8），**不寫 conversation_states**（fail fast）。
- **確認再查 + DB 安全網**：`確認` 交易內再查一次（§4 step 3），並倚賴 INSERT open 撞 `ux_events_active_group` 作為跨行程/競態最終防線（catch → `already_active`）。
- **兩位 host 各自逐步問答的競態**：conversation_states 為 per-user PK，兩人可同時各有流程；入口查在「開始時」皆看不到 event（尚未 INSERT），故兩人可同時走到 `awaiting_confirm`；**由 `確認` 的唯一約束保證只有一人成功**，另一人得 `already_active`。此為預期行為（G3 不被違反：DB 層強制）。

### 7. 模組劃分（新增 / 修改）

| 檔案 | 類型 | 職責 | 依賴 | 被誰依賴 |
|---|---|---|---|---|
| `src/domain/create-flow.ts` | **新增（純函式）** | 逐步問答 state machine 純邏輯：`nextState(state)`、`applyAnswer(state, payload, answer) → { ok, payload, nextState } \| { error, reason }`、`isComplete(payload)`。**不觸 DB、不觸 LINE**；欄位驗證複用 commands 層 validator | schema 型別、commands validator（§OP-10） | event-service |
| `src/domain/event-service.ts` | **新增** | 開團 domain：`startCreation()` / `handleOneline()` / `continueFlow()` / `confirm()` / `abort()` / `closeEvent()` / `cancelEvent()`。組合 repository 原語 + create-flow；含授權判定（白名單注入）、狀態轉移合法性、同群 active 判定、交易 + 去重。**回傳結構化 domain 結果物件（非 LINE 訊息）**。嚴禁 any | events/users/conversation/processed repo、tx runner、create-flow、注入 `hostUserIds` | webhook handler |
| `src/domain/event-formatter.ts` | **新增（純函式）** | 把 event domain 結果組版為繁中 `MessageDescriptor`（純文字，`mentionees:[]`）：逐步提問、確認摘要、開團公告、關閉/取消回覆、非白名單/重複/格式錯誤回覆。不觸 DB、不觸 LINE SDK | schema 型別、`MessageDescriptor`（共用型別） | webhook handler |
| `src/webhook/handler.ts` | **修改** | （a）分派前先查 conversation_states 攔截進行中流程（§3.3）；（b）把 `create_event_*`/`confirm`/`abort`/`close_event`/`cancel_event` 從 no-op 接上 event-service；（c）加白名單檢查（傳入 host 顯示名）；（d）event-formatter → LINE 訊息。**LINE SDK 型別只在此層** | commands、event-service、event-formatter、conversation repo、users repo、profile client、注入 `hostUserIds` | server.ts |
| `src/server.ts` | **修改** | 組裝 `EventService`（注入 repos、tx runner、`config.adminUserIds` 為 `hostUserIds`）並傳入 handler | config、repos、services | – |
| `src/db/index.ts`（或新 `src/db/tx.ts`） | **修改/新增** | 匯出共用交易原語 `runInTransaction<T>(work): T`（多 repo 原子寫入用；見 §「需新增原語」） | better-sqlite3 db | event-service |
| `src/commands/*`（validator 匯出） | **修改（協調 D-002）** | 匯出 `validateDate/validateTime/validateCapacity/validatePrice` 純函式（單一 source of truth；OP-10） | – | create-flow |

> 分層理由與 D-003 一致：`create-flow`/`event-service`/`event-formatter` 對 LINE SDK 零耦合（可純測）；handler 負責 LINE 事件形狀、async profile fetch、conversation 攔截與 reply。

#### 7.1 domain 結果物件型別（設計說明用，非實作交付；嚴禁 any）

```ts
// event-service 回傳型別（示意）
type CreateEntryResult =
  | { kind: 'not_authorized' }                       // 非白名單
  | { kind: 'already_active'; event: EventRow }      // 同群已有 active（open/closed）
  | { kind: 'invalid_field'; reason: InvalidReason } // 一行式欄位錯（D-002 已辨識，此為政策落實）
  | { kind: 'flow_started'; state: string }          // 逐步問答已啟動 → 回首問
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft }; // 一行式齊備 → 回摘要待確認

type ContinueFlowResult =
  | { kind: 'field_error'; state: string; reason: InvalidReason } // 欄位答案錯 → 停留重問
  | { kind: 'advanced'; state: string }                           // 前進到下一問
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft }         // 收齊 → 摘要
  | { kind: 'confirm_reprompt' }                                  // awaiting_confirm 下輸入非 確認/取消 → 重新提示 (M)（B2；停留、不建立）
  | { kind: 'aborted' }                                           // 取消開團
  | { kind: 'created'; event: EventRow }                          // awaiting_confirm 下 確認 → 建立
  | { kind: 'already_active' }                                    // 確認時撞唯一約束（race 落敗）→ (L)，清 conversation
  | { kind: 'duplicate' };                                        // 去重

type ConfirmResult =
  | { kind: 'noop' }                                 // 無流程
  | { kind: 'duplicate' }
  | { kind: 'already_active' }                       // 確認時撞唯一約束
  | { kind: 'created'; event: EventRow };

type AbortResult = { kind: 'noop' } | { kind: 'aborted' };

type CloseResult =
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'no_active' }
  | { kind: 'already_closed' }
  | { kind: 'ok'; event: EventRow };

type CancelResult =
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'no_active' }
  | { kind: 'ok'; event: EventRow };
```

### 8. 訊息範本（純文字，繁體中文）

以旅程 #1 舉例：`2026-08-15 07:30`、`東方球場`、`capacity=16`、`每人 2200 元`。

**(A) 逐步問答提問（依序）**
```
awaiting_date    → 開始開團！請輸入活動日期（格式 YYYY/MM/DD，例：2026/08/15）
                   （過程中隨時輸入「取消」可放棄開團）
awaiting_time    → 請輸入開球時間（格式 HH:MM，例：07:30）
awaiting_location→ 請輸入球場地點（例：東方球場）
awaiting_capacity→ 請輸入人數上限（正整數，例：16）
awaiting_price   → 請輸入每人費用（元，例：2200；免費請輸入 0）
```
（首問附「取消」逃生口提示，N1；其後每次錯誤重問亦可隨時 `取消` 放棄。）

**(B) 確認摘要（awaiting_confirm；一行式與逐步問答共用）**
```
請確認開團資訊：
日期：2026-08-15 07:30
地點：東方球場
人數上限：16
每人費用：2200 元

輸入「確認」建立活動，或「取消」放棄。
```

**(C) 欄位格式錯誤（停留重問，以日期為例）**
```
日期格式不正確，請輸入 YYYY/MM/DD（例：2026/08/15）
```
（時間 → `時間格式不正確，請輸入 HH:MM（例：07:30）`；人數 → `人數需為正整數（例：16）`；價格 → `費用需為 0 或正整數（免費請輸入 0，例：2200）`。錯誤重問時使用者仍可隨時輸入 `取消` 放棄，N3/nit-3。）

**(D) 開團成功公告（確認後 reply 群組）**
```
[東方球場 球聚] 開團成功！
日期：2026-08-15 07:30
地點：東方球場
人數上限：16
每人費用：2200 元

報名方式：輸入 +1（或 +N）報名，-1（或 -N）取消，名單 查看報名狀況。
```

**(E) 關閉報名回覆（close_event）**
```
「東方球場」球聚已關閉報名，不再接受新報名。
```

**(F) 取消活動回覆（cancel_event）**
```
「東方球場」球聚已取消。
```

**(G) 已取消開團（abort / awaiting_confirm 下取消）**
```
已取消開團。
```

**(H) 非白名單（非主辦人嘗試生命週期指令；政策見 OP-2）**
```
只有主辦人可以開團／管理活動。
```
> **errata(D-006)**：開團已全開 → 無「非授權開團」訊息。此範本更新為 **(H′)「只有開團的人（或系統管理員）可以關閉報名／取消活動。」**，僅 `close_event`/`cancel_event` 非授權時使用（`formatNotAuthorized`）。

**(I) 已有進行中活動（重複開團）**
```
目前已有進行中的活動，無法再開新團：
日期：2026-08-15 07:30
地點：東方球場
每人費用：2200 元
（如需另開新團，請主辦人先輸入「取消活動」結束目前活動。）
```
（N2：重開只需「取消活動」一步即釋出 active 名額；`關閉報名`(open→closed) 不釋放名額，故不必先關閉。欄位補 `每人費用` 與 (B)/(D) 一致。）
> **errata(D-006 B3)**：「請主辦人先輸入」→「請**開團的人**先輸入」，與 (H′) 用詞統一。

**(J) 生命週期指令但狀態不符**
```
close_event 已 closed → 活動已關閉報名。
close/cancel 無 active → 目前沒有進行中的活動。
```

**(K) 一行式欄位格式錯（create 類 invalid，落實 D-002 §6 / D-003 §6 政策）**
```
格式：開團 <日期> <時間> <地點> <人數> <價格>
例：開團 2026/08/15 07:30 東方球場 16人 2200元
```

**(L) 確認時撞唯一約束（race 落敗；不依賴對方活動欄位）—— design-reviewer B1**
```
手腳慢了一步！剛剛已有另一場活動成立，目前無法再開新團。你這次的開團未建立。
```
（用於 §4 step 5 catch 回 `already_active` 時；**刻意不含日期/地點欄位**——落敗者交易未讀到對方 event 完整欄位，避免渲染空白欄。落敗者的 conversation 於 catch 內一併清除，不卡在 awaiting_confirm，nit-2。）

**(M) 等待確認時輸入無法辨識（停留 awaiting_confirm，不建立）—— design-reviewer B2**
```
請輸入「確認」建立活動，或「取消」放棄。
```
（`awaiting_confirm` 下輸入非 `確認`/`取消` 的字，如 `OK`/`好`/`確定`/`yes` → 重新提示，停留該 state、不建立、不前進。消除靜默死角。）

### 9. webhook 分派表（`src/webhook/handler.ts` 修改後）

> **⚠️ errata(D-006) 指標**：下表「授權欄／去重欄」及 §7 的 `hostUserIds` 已被頂部 errata #3/#4/#5 覆寫——`create_*` 授權「白名單」→「無（開團全開）」；`close/cancel` 授權「白名單」→「canManageEvent（host_user_id ∪ super-admin）」、`no_active`/`not_authorized` 去重「交易內 mark」→「交易外 early-return 不 mark」；`my_id` no-op → 接線 (MyID)。以頂部 errata 為準。

前置：`event.type==='message' && event.message.type==='text'` 且 `source.type==='group'`，抽 `text/messageId/userId/groupId`。**先查 conversation_states 攔截（§3.3）**；否則 `parseCommand` → 下表分派。

| 情境 / `ParsedCommand.type` | handler 行為 | 授權 | 去重 |
|---|---|---|---|
| 有進行中流程（conversation_states 存在） | `eventService.continueFlow`（內部辨識 confirm/abort，其餘當答案） | 隱含（流程擁有權） | 前進/建立步驟交易內 markProcessed |
| `create_event_oneline` | 白名單→`eventService.handleOneline`（欄位已由 parser 齊備）；非白名單→(H) | 白名單 | awaiting_confirm 僅寫 conversation（交易內 mark） |
| `create_event_start` | 白名單→`eventService.startCreation`（回首問 (A)）；非白名單→(H) | 白名單 | 寫 conversation（交易內 mark） |
| `confirm` | 有流程→§3.4；無流程→**no-op（不回覆、不 mark）** | 隱含 | 建立時交易內 mark |
| `abort` | 有流程→放棄 (G)；無流程→**no-op** | 隱含 | delete conversation（交易內 mark） |
| `close_event` | 白名單→`eventService.closeEvent`；非白名單→(H) | 白名單 | 交易內 mark |
| `cancel_event` | 白名單→`eventService.cancelEvent`；非白名單→(H) | 白名單 | 交易內 mark |
| `signup`/`cancel`/`list` | D-003（M2，已實作）不變 | — | D-003 |
| `my_id` | M4，仍 no-op | — | 不 mark |
| `invalid`（command=`create_event`） | 回格式提示 (K)（落實 D-003 §6 政策；本文件實作） | 白名單→提示；非白名單→(H) 或靜默（OP-2） | 不 mark（無副作用） |
| `invalid`（signup/cancel 類，如 `+99`） | 靜默（D-003 既定） | — | 不 mark |
| `unknown` | **不回覆**（FR-5、G9） | — | 不 mark |

- **`switch` 對 union 窮舉**（含 `default: never`），沿用 D-002 G7 / D-003：新增指令型別編譯期報錯。
- **去重政策（architect-reviewer T-008 追認後校正，消除原分派表 vs 註記矛盾）**：
  - **生命週期指令（`關閉報名`/`取消活動`/`確認`/`取消`）一旦進入交易即以 `markProcessed` 為第一步**（G4），故其**最終判定即使是拒絕**（no_active (J)、already_closed、confirm 時 already_active (L)）**仍消費 messageId**（重送 → `duplicate` → 不重複回覆；行為更冪等、無害）。此即實作採用之正解。
    - **errata(2026-07-31，來源 D-006 決策 #7 / architect 追加)**：模型 B 下 **`close_event`/`cancel_event` 的 `no_active` 與 `not_authorized` 已前移至交易外 early-return、不再 mark**（授權需先讀 active 取 `host_user_id`）。故上句「no_active 仍消費 messageId」僅適用 `確認`（confirm）殘留情境；`close/cancel` 的 `no_active`/`not_authorized` 屬「交易前 early-return 不 mark」類（重送同一拒絕會再回一次，低度洗版可接受）。`already_closed`、confirm 撞約束 (L)、`duplicate` 仍於交易內 mark（不變）。
  - **交易前的 early-return 拒絕不 mark**：非白名單 (H)、`開團` 入口重複活動 (I)、一行式格式提示 (K)、無流程 confirm/abort、unknown/invalid——這些在進交易前 return、無 DB 副作用，故不 mark（沿用 D-003 no_open_event 慣例；代價：重送同一拒絕會重覆回一次，低度洗版可接受）。
  - 原文舊述「無 active (J) 不 mark」不精確（J 於 close/cancel 交易內、mark 之後才判定），已依實作與 architect 追認校正如上。「拒絕回覆的 mark 政策」通則之統一化已登記 `harness/LESSONS.md`（D-003 nit-3 + 本項，回寫候選）。

### 範圍內

- **host 授權**：以注入的 env 白名單（`config.adminUserIds`）判定 `開團`/`關閉報名`/`取消活動`；非白名單依政策回覆或靜默。
- **一行式開團**：消費 `create_event_oneline`（欄位已由 D-002 齊備）→ 同群 active 判定 → 寫 conversation（awaiting_confirm）→ 摘要待 `確認`。
- **逐步問答**：`create_event_start` → state machine（date→time→location→capacity→price→confirm）逐欄收集於 conversation_states.payload、欄位驗證與重問、mid-flow 攔截、per-user 隔離。
- **`確認` 建立**：交易內 INSERT events status='open'、host_user_id=建立者、去重、同群唯一約束安全網、清 conversation、開團公告；銜接 M2 報名。
- **`取消`(abort)**：放棄流程（清 conversation）。
- **狀態轉移**：open→closed（關閉報名）、open/closed→cancelled（取消活動）；非法轉移一律拒絕不寫入；`取消活動` 不刪 registrations（保留稽核）。
- **同群一場 active**：入口 `findActiveByGroup` 拒絕 + `確認` 唯一約束安全網。
- **交易與冪等**：所有副作用步驟交易內 markProcessed（exactly-once）。
- **訊息組版**：(A)–(K) 繁中純文字範本。
- **webhook 接線**：conversation 攔截 + 分派表 + 白名單檢查 + formatter → LINE 訊息。

### 範圍外（明確不做）

- **報名/取消/名單/遞補**（D-003 / M2，已實作）——本文件只把活動帶到 open。
- **`我的ID` / host 白名單執行期管理介面**（M4；MVP 白名單走 env，決策 #6）。
- **`events.status='draft'` 物化與 `closed→open` reopen**（OP-5/OP-11；MVP 不做）。
- **`events.status='done'`（活動結束）轉移**：無對應指令，非本文件範圍。
- **過去日期/每月天數/閏年等業務日期校驗**（OP-8；D-002 僅範圍檢查，MVP 沿用）。
- **conversation_states TTL 主動清理**（OP-6；MVP 以新 `開團` 覆寫、`取消`/`確認` 清除，主動 TTL 排程列 backlog）。
- **跨群同時多場活動**（決策 #3，MVP 限一場）。
- **球組編排 / 收款統計**（v2）。
- **編輯已 open 活動欄位**（改日期/地點/人數；MVP 不做，需先取消再開，記 backlog）。

---

## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）

- **G1（授權只認注入白名單）**：`開團`/`關閉報名`/`取消活動` 的授權**只得依注入的 `hostUserIds`（來源 env `ADMIN_USER_IDS`）** 判定；domain **不得讀 `process.env`**、不得以 `users.is_host` 或其他來源作生命週期授權依據（D-001 Q1）。非白名單者的生命週期指令**不得產生任何 DB 狀態變更**（不得寫 conversation_states、不得 INSERT/updateStatus events）。
  - **errata(D-006)**：本 G1 已被 D-006 G1/G2/G3 取代——**開團全開（無授權 gate）**；`close/cancel` 授權 = `canManageEvent`（`superAdminUserIds` ∪ `event.host_user_id`，唯讀 `getByLineUserId` 不 upsert）；`superAdminUserIds` 注入、domain 不讀 env（不變）。
- **G2（狀態轉移合法性）**：**不得寫入非法轉移**。合法集合僅：（概念）draft→open（`確認` INSERT open）、open→closed（`關閉報名`）、open/closed→cancelled（`取消活動`）。domain **必須先讀當前 status 判定合法後**才呼叫 `updateStatus`/`create`；`cancelled`/`done` 為終態不得再轉移；`closed→open` 不得發生（MVP）。（`updateStatus` 不自校驗，合法性責任在 domain。）
- **G3（同群一場 active 不可違反）**：**不得**讓同一 `group_id` 同時存在 > 1 場 active（open/closed）。`開團` 入口須 `findActiveByGroup` 拒絕重複；`確認` INSERT open 須倚賴 `ux_events_active_group`，撞唯一約束時**必須 catch 並回 `already_active`**，不得讓例外外洩/crash、不得繞過唯一約束（如先刪既有 active 再插）。
- **G4（交易 + 去重原子）**：有 DB 副作用的步驟（conversation upsert、event INSERT、updateStatus、conversation delete）**不得在交易外執行**，且**必須以 `processed.markProcessed(messageId)` 為交易第一步**；重送（回 false）**必須中止不重複副作用**。不得僅靠記憶體去重（NFR-2）。
- **G5（domain 不下 SQL、不觸 LINE）**：`create-flow.ts`/`event-service.ts`/`event-formatter.ts` **不得出現 SQL 字串或直接存取 `db`**（一律經 repository / tx runner），**不得 import `@line/bot-sdk` 型別**；LINE 型別只在 `handler.ts`。（沿用 D-003 G10/分層）
- **G6（禁 any）**：新增 domain / 改寫 handler **不得使用 `any`**；`ParsedCommand`、`CreateEventDraft`、各 `*Result` 皆具名定型；`conversation_states.payload` 解析後須以 `CreateEventDraft` 型別承載（不得以 `any` 承接 `JSON.parse`）。
- **G7（欄位驗證單一 source of truth）**：逐步問答與一行式的日期/時間/人數/價格驗證規則**不得與 D-002 §4 分歧**；不得在 domain 重新硬編一套不同的 regex/範圍（須複用 commands 層 validator 或與其等價並經測試對齊）。
- **G8（host_user_id 為建立者）**：`確認` INSERT open 時 `host_user_id` **必須為建立該活動的白名單使用者之 `user.id`**（先 `userRepo.upsert` 取得），供 D-003 主辦人 override；不得寫入他人或空值。
- **G9（回覆政策防洗版）**：`unknown`、無流程時的 `confirm`/`abort`、mid-flow 未攔截的雜訊**不得觸發回覆或 markProcessed**（FR-5）；只有可識別的生命週期指令與進行中流程答案才產生回覆。
- **G10（取消活動不刪 registrations）**：`取消活動` **一律為 `events.status → cancelled` 的狀態轉移**，**不得對 `registrations` 下任何 `DELETE`**（沿用 D-001 G9）；registrations 及其取消稽核欄（`cancelled_at`/`cancelled_by_user_id`）一併保留。

---

## 三、Acceptance Checks（每條可轉測試；條件 → 預期 → 驗證方式；標記 `[D-004 AC-n]`）

- [ ] **[D-004 AC-1]（一行式開團→摘要→確認→open）**：白名單 host `開團 2026/08/15 07:30 東方球場 16人 2200元` → 回確認摘要 (B)、寫 conversation(state=`awaiting_confirm`, payload 齊備)、**尚未** INSERT events；接著 `確認` → INSERT `events`（status='open'、host_user_id=host.id、欄位相符）、清 conversation、回開團公告 (D)。（驗證：unit/整合 test，event-service + repo / FR-3、旅程 #1）
- [ ] **[D-004 AC-2]（一行式欄位錯 → 格式提示）**：白名單 host `開團 缺欄位`（`invalid(create_event, create_wrong_arity)`）→ 回格式提示 (K)、**不寫 conversation、不 INSERT**。（驗證：unit test，handler + formatter / D-002 §6、D-003 §6 政策落實）
- [ ] **[D-004 AC-3]（逐步問答完整走完）**：白名單 host `開團` → 回 (A) awaiting_date；依序 `2026/08/15`→`07:30`→`東方球場`→`16`→`2200` 各回下一問／收齊回摘要 (B)；`確認` → INSERT open（欄位＝依序輸入值）、清 conversation。（驗證：整合 test，逐訊息推進 state machine / FR-3 逐步問答）
- [ ] **[D-004 AC-4]（逐步欄位驗證錯 → 停留重問）**：awaiting_date 下輸入 `2026/13/40`（非法日期）→ 回 (C) 日期格式錯、**停留 awaiting_date、payload 不含 date**；重輸入合法值後正常前進。（驗證：unit test，create-flow / G7、§3.2）
- [ ] **[D-004 AC-5]（逐步 location 可含空白）**：awaiting_location 下輸入 `東方 高爾夫球場` → payload.location=`東方 高爾夫球場`、前進 awaiting_capacity。（驗證：unit test / §3.1、D-002 O-5）
- [ ] **[D-004 AC-6]（confirm 建立 host_user_id=建立者）**：host A（白名單）走完流程 `確認` → 建立 event 之 `host_user_id === userRepo.upsert(A).id`。（驗證：unit test / G8、對接 D-003 override）
- [ ] **[D-004 AC-7]（abort 放棄流程）**：流程進行中（任一 state）host 輸入 `取消` → `conversation.delete`、回 (G)、無 event 建立；其後同 host `確認` → **no-op**（無流程）。（驗證：unit test / §3.4、G9）
- [ ] **[D-004 AC-8]（open→closed）**：已有 open 活動，白名單 host `關閉報名` → `updateStatus(closed)`、回 (E)；再 `關閉報名` → 回「活動已關閉報名」(J)、狀態不變。（驗證：unit test / G2、§5.1）
- [ ] **[D-004 AC-9]（open/closed→cancelled，且不刪 registrations）**：open 活動且有若干 registrations（含已 soft-delete 列），白名單 host `取消活動` → `updateStatus(cancelled)`、回 (F)；**registrations 列數不變**（無 DELETE）、稽核欄保留；closed 活動亦可 `取消活動`→cancelled。（驗證：unit/整合 test / G2、G10、D-001 §7 註）
- [ ] **[D-004 AC-10]（非白名單拒絕，無副作用）**：非白名單成員 B `開團 …` / `關閉報名` / `取消活動` → 回 (H) 或靜默（依 OP-2 裁決）、**無任何 DB 變更**（無 conversation、無 event 狀態改變）。（驗證：unit test，handler + 注入白名單 / G1、成功條件 #3、FR-5）
  - **errata(2026-07-31，來源 D-006 決策 #7)**：`開團` 不再被拒（開團全開）。本 AC 語意改為 **「非建立者非 super-admin `關閉報名`/`取消活動` 被拒（(H′)）、無 DB 變更（不 mark、event 狀態不變、`users` 無新列——唯讀解析不 upsert）」**；`開團` 全開由 D-006 AC-1 覆蓋。實作測試已依此更新（見 `event-service.test.ts` [D-004 AC-10 errata]、`event-service.claiming.test.ts` [D-006 AC-4/5]）。
- [ ] **[D-004 AC-11]（重複開團拒絕）**：同 group 已有 open（或 closed）活動，白名單 host `開團 …` → 回 (I)「已有進行中活動」+ 現有摘要、**不寫 conversation、不 INSERT**。（驗證：unit test / G3、§6、決策 #3）
- [ ] **[D-004 AC-12]（確認撞唯一約束安全網 + 窄捕捉）**：模擬同 group 於 `確認` INSERT open 時已存在 active（先行插入一場 open）→ `確認` 交易內 INSERT 撞 `ux_events_active_group` → **catch（僅 UNIQUE）→ 回 `already_active`（formatter (L)）、清該 host conversation**，不 crash；**且**注入非唯一約束錯誤（模擬其他 SQLITE error）時**必須向上拋、不得被當作 `already_active`**（窄捕捉，architect 裁定 1）。（驗證：unit/整合 test / G3、§4）
- [ ] **[D-004 AC-13]（去重：確認重送）**：相同 `message_id` 的 `確認` 連續處理兩次 → 第二次交易內 markProcessed 回 false 中止 → **只建立 1 場 event、只回覆一次**。（驗證：unit/整合 test / G4、NFR-2）
- [ ] **[D-004 AC-14]（去重：逐步答案重送）**：相同 `message_id` 的欄位答案（如 `07:30`）重送 → 第二次不重複推進 state（避免把同一答案套用到下一問）。（驗證：unit test / G4、§2 交易+dedup）
- [ ] **[D-004 AC-15]（mid-flow per-user 隔離）**：host A 開團流程進行中（awaiting_location），同群成員 B `+1` → **B 的報名照常由 D-003 處理**（不被當作 A 的 location 答案）；A 的下一則訊息才是 location 答案。（驗證：整合 test，handler + conversation repo / §3.3 關鍵正確性）
- [ ] **[D-004 AC-16]（無流程時 confirm/abort no-op）**：無 conversation_states 時 `確認` / `取消` → handler 回空訊息、不 mark、不改狀態。（驗證：unit test / G9、§3.4）
- [ ] **[D-004 AC-17]（生命週期指令狀態不符）**：無 active 活動時 `關閉報名` / `取消活動` → 回「目前沒有進行中的活動」(J)、無狀態變更；cancelled/done 終態下任何生命週期指令不轉移。（驗證：unit test / G2、§5.1）
- [ ] **[D-004 AC-18]（開團後 M2 可報名，銜接）**：白名單 host 走完 `確認` 建立 open 活動後，成員 `+2` → D-003 `signup` 正常產生 2 列 confirmed、回名單（成功條件 #3「開團→公告→報名」全程）。（驗證：e2e/整合 test / 旅程 #1、與 D-003 銜接）
  - **errata（2026-07-31，來源 D-005 §3 主辦自動登記）**：D-005 已 APPROVED 使 `確認` 建立 open event 時**自動登記主辦為第 1 正取（seq=1）**。故本 AC 的名單計數自 host 起算：成員 `+2` 後名單為 **3/16**（主辦 + 2），非原範例假設「空 event → 2/16」。實作測試已依此更新（`countConfirmed` 自 host+N 起算）；本 errata 僅澄清範例語意，不改 AC 驗證意圖。
- [ ] **[D-004 AC-19]（domain 不下 SQL、不觸 LINE）**：`src/domain/{create-flow,event-service,event-formatter}.ts` 內無 SQL 字串、無 `db.prepare`/`db.transaction` 直接呼叫、無 `@line/bot-sdk` import。（驗證：靜態審查 / grep，G5）
- [ ] **[D-004 AC-20]（payload 型別安全）**：`conversation_states.payload` 之 `JSON.parse` 結果以 `CreateEventDraft` 承載，欄位齊備判定（`isComplete`）正確；缺欄位時不進 `確認` 建立。（驗證：unit test，create-flow / G6）
- [ ] **[D-004 AC-21]（awaiting_confirm 非確認/取消 → 重新提示）**：`awaiting_confirm` 下輸入 `OK`/`好`/`確定`（非 `確認`/`取消`）→ 回 (M) 重新提示、**停留 awaiting_confirm、不建立、不前進**；隨後 `確認` 正常建立。（驗證：unit test，create-flow + handler / design-reviewer B2、G9）
- [ ] **[D-004 AC-22]（validator 與 D-002 等價）**：commands 匯出的 `validateDate/validateTime/validateCapacity/validatePrice` 對同一組輸入，與 D-002 §4 一行式 inline parse 產生**相同**的接受/拒絕與正規化輸出（含零填充）。（驗證：對照 unit test / G7、architect nit-1）

---

## 四、關鍵取捨與開放問題（OP-n，交 Orchestrator 與使用者裁決）

> 以下為需使用者拍板的需求/政策點；backend 附建議選項，但**不自行定案**。

- **OP-1（host 白名單來源）**：「誰能開團」用現有 `config.adminUserIds`（env `ADMIN_USER_IDS`）直接當 host 白名單，還是新增專屬 `HOST_USER_IDS` env 以區分 Admin（FR-4 管理 host）與 Host（開團）兩角色？
  - 建議：**MVP 直接沿用 `ADMIN_USER_IDS` 為 host 白名單**（決策 #6 無 Admin 後台、無角色管理介面，MVP Admin≈Host 可合一）；若日後要分離再加 `HOST_USER_IDS` 並更新 `.env.example`。（task 指示即用 `config.adminUserIds`，此 OP 僅為留痕確認。）
- **OP-2（非白名單者的回覆政策）**：非白名單者下 `開團`/`關閉報名`/`取消活動` → 回一句「只有主辦人可以開團／管理活動」(H)，還是**完全靜默**（最強防洗版）？
  - 建議：**回一句簡短提示 (H)**。理由：這些是明確可辨識的指令嘗試（非閒聊），成功條件 #3 明列「非主辦人 `開團` 被拒絕」——回覆讓使用者知道被拒比靜默更符合「被拒絕」語意；且單則、無迴圈，洗版風險低。（保守派可選靜默；請裁決。）
- **OP-3（生命週期授權範圍：env 白名單 vs event.host_user_id）**：`關閉報名`/`取消活動` 由**任一白名單 host** 皆可執行，還是**限該活動的 `host_user_id`（建立者本人）**？
  - 建議：**env 白名單（任一 host 可互換）**；`event.host_user_id` 保留給 D-003 的 `-N 名字` 報名 override（僅建立者）。理由：MVP host 可互換、授權來源單一（env）較易守 G1；報名 override 屬更細粒度、沿用 D-003 既定。請確認此「生命週期＝白名單、報名 override＝host_user_id」分工。
- **OP-4（一行式是否仍需 `確認`）**：一行式已帶齊欄位，仍要求 `確認` 才建立（與逐步問答一致、Brief §34/旅程 #1），還是**一行式一次建立**（省一步、更快）？
  - 建議：**維持需 `確認`**（Brief §34「建立前顯示摘要待 `確認`」明確要求；R2 建立類加一道確認較安全）。若使用者偏好快速，可改一行式 one-shot（則 §2/§4 相應簡化）。
- **OP-5（draft 是否物化）**：開團期間資料存 `conversation_states.payload` 直到 `確認` 才 `INSERT events(status='open')`（D-001 §4 建議，**MVP 不物化 draft 列**），還是 `開團` 即 `INSERT events(status='draft')` 佔用 active 名額、`確認` 再 flip open？
  - 建議：**採 conversation_states 暫存（不物化 draft）**（D-001 §4 已建議；draft 列不滯留、唯一約束在 `確認` 生效）。代價：多位 host 可同時各走問答、由 `確認` 唯一約束決勝（§6）。若使用者要「開始開團即鎖住該群名額（fail fast）」，則改物化 draft（draft 屬 active 集合，第二人 `開團` 立即被拒）——此改動涉及狀態機解讀，需明確裁決。
- **OP-6（conversation TTL / 逾時）**：進行中開團流程是否需主動逾時清理（D-001 提 30 分鐘 TTL）？
  - 建議：**MVP 不做主動 TTL 排程**；以「新 `開團` 覆寫、`取消`/`確認` 清除」控管，主動 TTL sweep 列 backlog。（若使用者要求逾時自動放棄，需加排程/惰性檢查 `updated_at`。）
- **OP-7（mid-flow 指令逃逸）**：開團流程進行中，host 自己輸入 `名單`/`+1` 等 → 一律當作**當前欄位答案**（本設計預設），還是允許某些指令「逃出」流程正常執行？
  - 建議：**維持一律當答案**（僅 `確認`/`取消` 為控制指令）。理由：per-user 隔離下只有開團中的 host 被「困住」，其正在填表、極少同時要報名；規則單純。（若要逃逸，需定義白名單指令集，複雜度上升。）
- **OP-8（日期業務校驗）**：是否拒絕**過去日期**、做每月天數/閏年精算？
  - 建議：**MVP 沿用 D-002 範圍檢查**（月 1–12、日 1–31、時 0–23、分 0–59），**不拒過去日期、不做閏年**（D-002 §範圍外已列）。若要求，加入 domain 業務校驗並補 AC。
- **OP-9（欄位驗證器來源）**：逐步問答的 per-field 驗證，**由 commands 層匯出 `validateDate/…` 純函式複用**（單一 source of truth），還是 domain 自行實作等價驗證並以測試對齊？
  - 建議：**由 commands 層匯出並複用**（守 G7、避免規則分歧）。此為 parser 層擴充（新增匯出、非契約變更），需與 D-002 owner 協調——**回報 Orchestrator 確認是否由本任務一併補上 commands 層匯出**。

> 另記（非 OP，實作備查）：`closed→open` reopen 無 parser 指令，MVP 範圍外；「編輯已 open 活動」需先取消再開，列 backlog。

---

## 需新增的 repository / 基礎原語清單（供 T-008 實作階段）

- **【新增：共用交易原語】** `runInTransaction<T>(work: () => T): T`（建議置於 `src/db/index.ts` 或新 `src/db/tx.ts`，或以 `EventRepository.runInTransaction` 提供）。
  - 語意：以 better-sqlite3 `db.transaction(work)()` 包裹**跨 repo 的原子寫入**（`markProcessed` + `conversation.upsert`/`events.create`/`events.updateStatus`/`conversation.delete`），達成去重與狀態變更同成同敗（G4）。
  - 為何不直接複用 `RegistrationRepository.runImmediate`：後者語意屬「報名防超賣的 IMMEDIATE 鎖」，開團/生命週期寫入無超賣併發需求（同群唯一由 `ux_events_active_group` 保證），耦合 RegistrationRepository 不當。此原語為中性交易 runner。
  - **隔離級別：DEFERRED（architect-reviewer 2026-07-31 裁定，非 IMMEDIATE）**。理由：開團/生命週期寫入非「讀後寫防超賣」；同群唯一由 `ux_events_active_group` 於 INSERT 當下強制（§4 step 3 的 `findActiveByGroup` 讀僅 UX early-exit，非正確性機制）；且 `markProcessed`（寫）為交易第一步，DEFERRED 於首寫即取 RESERVED 鎖，write-first pattern 下行為近似 IMMEDIATE。與報名 IMMEDIATE 情境本質不同（後者無 DB 約束兜底，read-decide-write 須序列化）。
  - **窄捕捉要求（architect 裁定 1，T-008 落實 + AC-12 驗 + architect-reviewer T-008 追認校正）**：`確認` 的 `events.create` 撞約束時，catch **僅得捕捉 `code==='SQLITE_CONSTRAINT_UNIQUE'` 且訊息以欄位簽章 `events.group_id` 唯一指涉 `ux_events_active_group`**（該欄為 events 表唯一的 unique 來源，見 migration 0001；相容 index 名 `ux_events_active_group` 以防未來 SQLite 版本變動）→ 回 `already_active`；**其餘任何錯誤一律 re-throw**（含 `SQLITE_CONSTRAINT_UNIQUE` 但訊息指向其他 column，如 `users.line_user_id`），不得靜默吞掉半完成交易（re-throw 使交易回滾、fail loud，AC-12 已雙向驗）。
    - 註：better-sqlite3 對 **partial unique index** 撞約束時回報的是**欄位** `UNIQUE constraint failed: events.group_id`（不含 index 名），故以欄位簽章判別而非 index 名，是與實際運行時行為對齊。
- **【協調 D-002 / commands 層】** 匯出 per-field 驗證純函式 `validateDate/validateTime/validateCapacity/validatePrice`（回傳 `{ ok:true, value }` | `{ ok:false, reason:InvalidReason }`），供 `create-flow` 逐欄驗證複用（OP-9、G7）。此非 repository 原語、屬 parser 層擴充，**需 Orchestrator 確認由本任務一併補上或另開子任務**。
- **既有原語足夠**：`EventRepository.create`（可傳 `status:'open'`）、`getById`、`findActiveByGroup`、`updateStatus`；`ConversationRepository.get/upsert/delete`；`ProcessedEventRepository.markProcessed`；`UserRepository.upsert/getById` **皆已存在，足以支撐 M3**，除上述交易 runner 與（協調性的）field validator 外**無需新增 event/conversation repository 方法**。

---

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-07-31 | D-004 DRAFT 提交（backend） | 待 design-reviewer + architect-reviewer 審查、OP-1~OP-9 待使用者裁決 |
| 2026-07-31 | OP-1 host 白名單來源 | **沿用 `ADMIN_USER_IDS`**（MVP Admin≈Host；orchestrator 採預設） |
| 2026-07-31 | OP-2 非白名單回覆政策 | **回一句提示 (H)**（使用者裁決；符成功條件 #3「被拒絕」語意） |
| 2026-07-31 | OP-3 生命週期授權範圍 | **任一白名單主辦皆可**開/關/取消；報名 override（`-N 名字`）仍限 `event.host_user_id`（使用者裁決） |
| 2026-07-31 | OP-4 一行式是否需確認 | **仍需 `確認`**（使用者裁決；對齊 Brief §34、與逐步問答一致） |
| 2026-07-31 | OP-5 draft 是否物化 | **不物化 draft**：conversation_states 暫存、`確認` 才 INSERT open（使用者裁決；唯一約束於確認生效決勝） |
| 2026-07-31 | OP-6 conversation TTL | **MVP 不做主動 TTL sweep**（新開團覆寫/確認/取消清除；orchestrator 採預設），列 backlog |
| 2026-07-31 | OP-7 mid-flow 指令逃逸 | **一律當欄位答案**（僅 確認/取消 為控制指令；orchestrator 採預設） |
| 2026-07-31 | OP-8 日期業務校驗 | **沿用 D-002 範圍檢查**，不拒過去日期、不做閏年（orchestrator 採預設） |
| 2026-07-31 | OP-9 欄位驗證器來源 | **由 commands 層匯出複用**（守 G7）；orchestrator 裁定**納入 T-008 範圍**由 backend 一併補 commands 匯出（parser 層擴充、非契約變更） |
| 2026-07-31 | 交易 runner DEFERRED/IMMEDIATE | **交 architect-reviewer 裁定**（見「需新增原語」§；backend 傾向 DEFERRED，唯一約束為併發防線） |
| 2026-07-31 | T-008 實作完成 + R2 品質關卡 | **三關全通過**：architect-reviewer APPROVED 零 blocker（窄捕捉追認 PASS、G1~G10 全 PASS）、design-reviewer APPROVED 零 blocker（範本 (A)–(M) 逐字對齊）、unit-tester 165 tests 全綠/AC 80/80/無 bug（補 3 強化測試含 UNIQUE-其他-column→re-throw、cancel 稽核欄保留）。文件校正已套用：§4/AC-12/需新增原語 窄捕捉措辭改「欄位簽章 events.group_id 指涉」、§9 去重政策收斂（生命週期交易內一律 mark、交易前 early-return 不 mark）。T-008 標 DONE，e2e 留整合階段。 |

> **OP-1~OP-9 全數定案（2026-07-31）**，裁決與本文件設計內容一致，**無需改動設計正文**。architect-reviewer 需特別裁定：(a) 交易 runner DEFERRED vs IMMEDIATE、(b) 是否需 ADR、(c) 「不物化 draft」對 D-001 §7 狀態機的解讀是否需回寫 D-001 註記。

### R2 雙審結果（2026-07-31）
| reviewer | 結論 | 處置 |
|---|---|---|
| architect-reviewer | **建議 APPROVED（零 blocker）** | 裁定 1：交易 runner **DEFERRED** 足夠（+窄捕捉要求，已入 §4/§需新增原語/AC-12）；裁定 2：**不需 ADR**（ADR-004 保留給 PG 切換）；裁定 3：**需回寫 D-001 §7**「draft 不物化」澄清註記（architect 職責，另派）。nit-1 validator 等價（已補 AC-22）、nit-2 already_active 清 conversation（已入 §4/(L)）、nit-3 mid-flow 取消活動（(C) 已提示可 `取消`）。 |
| design-reviewer | **需修正（2 blocker）→ 已修正** | B1 已補範本 **(L)**（不依賴對方欄位 + 清 conversation）；B2 已補範本 **(M)** + `ContinueFlowResult.confirm_reprompt` + §3.3/§3.4 定義。nit N1（(A) 取消提示）、N2（(I) 簡化為「取消活動」一步 + 補每人費用）、N3（(C) 價格文案）已採納；N4/N5 記錄不改。 |

> **兩 blocker（B1/B2）已於設計正文補齊，architect 零 blocker。** 待使用者最終 APPROVED 即可派 T-008 實作。
> **後續動作（orchestrator 分派，不阻擋 D-004）**：①派 architect 回寫 D-001 §7/§4「draft 不物化」註記（順帶修 backlog 記的 D-001 §9 command parser 誤歸措辭）②LESSONS 登記「拒絕回覆的 mark/不 mark 去重政策不對稱」（D-003 nit-3 + D-004 §9 同型，第 2 次出現＝回寫候選）。
| 2026-08-02 | **errata（D-008 T-014 套用）**：confirm flip + closed 釋放 + formatClosed 用詞 | §4 confirm 交易內、insert 前：未過期 active → `already_active`（清 conversation，nit-1）、過期 open → `updateStatus('done')` flip 後同交易建立（原子，G1）；`CreateEventInput` `eventDate`/`eventTime` → `eventDatetime`（`taipeiToUtcIso` 合併）。§5 close/cancel：closed 不再由 `findActiveByGroup` 返回 → `already_closed` 不可達（保留防禦）、二次關閉→`no_active`、過期 open→`no_active`（OP-7 不 flip）。§8 (E) `formatClosed` 用詞「已關閉報名」→「報名已截止」（B1，與名單 closed 標籤收斂）；(I)/(D) 日期改衍生 `event_datetime`。來源：D-008 §五 D-004（APPROVED）。 |
