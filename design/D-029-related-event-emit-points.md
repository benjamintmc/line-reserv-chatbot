# D-029: `relatedEventId` 送出點枚舉與 `GroupingState.eventId`

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §5.3／§5.5 **逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——隨 T-033c 一併審查；G4 是「日後新增回覆分支不得漏登映射」的長期守門，漏登會使 quote 靜默失效。
- 來源：D-020 §5.3、§5.5；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。相依：D-025（同任務，映射表寫入時機 G3）。

## 一、設計內容

#### 5.3 `relatedEventId` 送出點枚舉（G4：新增/修改任何回覆分支時對照本表）

| 分支（函式／case） | eventId 來源 |
|---|---|
| `renderSignup` / `ok` | `result.view.event.id` |
| `renderCancel` / `ok` | `result.view.event.id` |
| `renderList` / `ok` | `result.view.event.id` |
| `renderAddCapacity` / `ok` | `result.view.event.id` |
| `renderBalanced` / `balanced` | 消歧義解出的 `eventId`（`BalancedResult` 本身不帶 event，由呼叫端在 `dispatchSingle` 內附加） |
| `renderStartRounds` / `round` | 同上，且需寫入 `GroupingState.eventId`（新增欄位，供 `下一輪` 沿用） |
| `renderNextRound` / `round` | 讀 `JSON.parse(conv.payload).eventId`（見 §5.5） |
| `renderCreateEntry` / `duplicate_event` | `result.event.id`（既存衝突活動） |
| `renderContinue` / `created` | `result.event.id`（**新建活動的公告訊息，最重要的錨點**） |
| `renderConfirm` / `created` | `result.event.id` |
| `renderClose` / `ok` | `result.event.id` |
| `renderCancelEvent` / `ok` | `result.event.id` |
| `renderEdit` / `ok` | `result.eventId`（**`EditEventResult.ok` 需新增此欄位**，現行只有 field/before/after 等） |
| `handleBatch` 成功路徑 | `lastView.event.id` |

**明確不附（無單一具體活動、或該分支本就無 DB 副作用可言）**：`no_open_event`/`event_ended`/
`nothing_to_cancel`/`duplicate`(去重)/`not_authorized`/`no_active`/`already_closed`/`over_limit`/
`insufficient`/`no_session`/`exhausted`/`format_error`/`help`/`capacity` 導向/`bad_fee`/
`past_datetime`/`closed_not_editable`/`my_id`/`invalid`(非 edit_event)/`unknown`/四個新消歧義錯誤
（ambiguous/conflict/not_found/too_many）/`flow_started`/`awaiting_confirm`（draft 尚未成為 event
列）/**`group_open_limit`（§3.5 同群 open 數上限，無單一衝突列可指涉）**。**新增任何回覆活動相關
內容的分支時，必須在此表補一列，不得只改程式碼不改本表**（reviewer 逐條核對用）。

#### 5.5 `GroupingState` 新增 `eventId`

`src/domain/grouping.ts` 的 `GroupingState` 介面新增 `eventId: number`（session 綁定的活動）。
`startRounds` 寫入時填入消歧義解出的 `eventId`；`nextRound` 讀出後原樣寫回（不變更）；
handler 的 `renderNextRound`/`renderStartRounds` 用它作為 `relatedEventId`（§5.3）。
**`下一輪` 本身仍不跑 `splitSelector`/`resolveTargetEvent`**（G11）——這只是讓它的訊息也能被
quote，不代表它參與消歧義判斷。

## 二、Guardrails（Must NOT）

- **G4（送出點枚舉完整性）**：§5.3 表為完整清單；新增/修改任何會產生「與某活動相關」訊息的
  render 分支時，**必須**同步更新該表並判斷是否附 `relatedEventId`，不得只改程式碼。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-029 AC-17] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-17]` 會對不上）。

- [ ] **[D-020 AC-17]（送出點枚舉覆蓋）**：對 §5.3 表列的每一個分支各構造一次觸發，斷言
  `messageEventMap.record` 被以正確 `eventId` 呼叫一次；對「明確不附」清單中任一分支，斷言
  完全不呼叫 `record`。
- [ ] **[D-020 AC-22]（`分組` 訊息可被 quote 且映射到正確活動）**：`分組`／`下一輪` 產生的訊息，
  其 `sentMessages[].id` 對映到 `GroupingState.eventId`（session 綁定的那場），非其他候選活動。

## 四、errata（T-033b 動工時追加，2026-09-02）

> 落筆者：orchestrator（實作對照紀錄，比照 D-007／D-021 前例）；§5.3 表本體未改。

### E1：`renderCreateEntry / already_active` 於 T-033a~b 期間**刻意不附**錨點

§5.3 表列的是 `renderCreateEntry / duplicate_event`——那是 **T-033c**（D-027 開團查重）才存在
的分支。現行程式碼在該位置是 `already_active`（入口拒絕第二場，T-033c 會整段移除）。
兩者語意相近但不是同一列，此刻附上等於偷跑一個表上沒有的分支（G4 反面）⇒ **維持 `plain`**。
**T-033c 改名為 `duplicate_event` 時，必須同批把 `relatedEventId = result.event.id` 補上。**

### E2：`renderNextRound / round` 的 `eventId` 為選填（跨版本 session 相容）

§5.5 要求 `GroupingState.eventId` 為必填欄位；但 T-033b 上線那一刻，PROD 可能存在**上線前**建立、
payload 沒有該欄位的 grouping session。實作因此讓 `NextRoundResult.round.eventId` 為選填，
`nextRound` 只在確實讀到數字時才回傳。代價僅是那幾則舊 session 的 `下一輪` 訊息不能被 quote；
**不得**因缺欄位而改判 `no_session`（那會直接打斷使用者進行中的分組）。
