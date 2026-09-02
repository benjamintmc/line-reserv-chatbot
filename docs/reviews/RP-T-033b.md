# 審查包（Review Packet）— T-033b

- 任務：**T-033b**（機制 A：quote-reply 映射 + 送出點枚舉）／設計：**D-025、D-029**（umbrella D-020）／風險：**R2**
- 分支：`feat/t-033b-quote-message-event-map`（自 `6dec137`）；未 push、未開 PR
- 變更：**25 檔**（新增 4、生產碼修改 6、測試/夾具修改 15）

**新增（4）**
| 檔案 | 內容 |
|---|---|
| `src/db/repositories/message-event-map-repository.ts` | `MessageEventMapReader`／`Writer` + `MessageEventMapRepository`（`record` / `getEventId`） |
| `src/webhook/d025-quote-mapping.test.ts` | `[D-025 AC-13/14/15/28]` + 查無映射案例 |
| `src/webhook/d029-emit-points.test.ts` | `[D-029 AC-17/22]`、`[D-025 AC-16]` + G3 反向案例 |
| `src/webhook/__tests__/handle-messages.ts` | 測試 helper（只取 `messages`，保住既有 125 處斷言寫法） |

**修改（生產碼 6）**：`src/webhook/handler.ts`（`HandleEventResult`、quote 讀取、14 個 render 分支錨點）、
`src/server.ts`（`ServerDeps` 物件參數、`recordReplyMapping`、`ReplyClient` 型別收緊、單例 `defaultDeps`）、
`src/domain/grouping.ts`（`GroupingState.eventId` + `StartOptions.eventId`）、
`src/domain/grouping-service.ts`（寫入 session eventId、`NextRoundResult.round.eventId`）、
`src/domain/event-service.ts`（`EditEventResult.ok.eventId`）、
`src/domain/disambiguation-formatter.ts`（相位註解校正，**釘死字串未動**）。

## 1. 變更摘要（≤ 5 行）
`handleEvent` 回傳型別改為 `{ messages, relatedEventId? }`；`server.ts` 於 `replyMessage` **回應之後**
用 `sentMessages[].id` 寫 `message_event_map`（G3）。讀取端：`event.message.quotedMessageId` →
`messageEventMap.getEventId` → **`resolveQuotedEventInGroup` 以 `events.getById` 比對 `group_id`**（G14）→
交給既有純函式 `resolveTargetEvent`（未改）。D-029 §5.3 表列 14 個分支逐一附錨點，
`分組`／`下一輪` 的錨點來自新增的 `GroupingState.eventId`（§5.5）。

## 2. Guardrails 自檢表

| Guardrail | 遵守？ | 證據（檔案:行） |
|---|---|---|
| **G3**（寫入時機）只能用 `replyMessage` 回應的 `sentMessages[].id`，不得依「即將送出的 `messages` 陣列」預先寫入 | ✓ | `src/server.ts:143-154` `recordReplyMapping` 只讀 `res.sentMessages`；呼叫點 `src/server.ts:220-233` 位於 `await replyClient.replyMessage(...)` 之後，且 reply 拋錯時 `res === undefined` ⇒ 一列都不寫。反向測試：`d029-emit-points.test.ts`「reply 未成功（無 sentMessages）→ 一列都不寫」。**全 repo 無第二處寫入**（見 §5 窮舉） |
| **G14**（quote 解出的 eventId 須驗證屬於當前群組） | ✓ | 唯一讀取點 `src/webhook/handler.ts:809`（`resolveQuotedEvent`），結果**立即**交 `resolveQuotedEventInGroup`（`handler.ts:176-184`）比對 `row.group_id === groupId`；不符/查無 → `undefined`（視為未引言）。service 層未新增任何 group 比對。測試 `[D-025 AC-28]`：斷言回覆為既有 ambiguous 字串、不含別群場地／日期／id、不呼叫 service、不 `markProcessed` |
| **G4**（送出點枚舉完整性）新增/修改回覆分支必須對照 §5.3 表 | ✓ | 14 列逐一實作，`[D-029 AC-17]` 對每列各觸發一次並斷言 `record` 恰以正確 `eventId` 呼叫一次；「明確不附」清單另取 9 個分支斷言完全不呼叫。表上唯一未實作列＝`renderCreateEntry/duplicate_event`（T-033c 才存在），已落 D-029 errata E1 |
| **G6**（純函式不越界）`resolveTargetEvent`／`matchSelector` 不收 `groupId`、不查 DB | ✓ | `src/domain/event-disambiguation.ts` **本批零改動**（`git diff --stat` 無此檔） |
| **G11**（`下一輪` 不跑消歧義） | ✓ | `NEEDS_EVENT_SET` 未變；`下一輪` 的錨點取自 session（`NextRoundResult.eventId`），非重新解析。測試 `[D-029 AC-22]` 第二段：`下一輪` 不帶 selector 仍錨在 session 綁定的那場，非另一候選 |
| **CLAUDE.md §4 去重政策** | ✓ | 未新增任何「回覆但不 mark」的分支；四種消歧義拒絕維持既有具名例外，`plain(...)` 只是換了回傳容器 |

## 3. 刻意的設計偏離 / 需要 reviewer 裁定的三點

1. **`buildServer` 改為物件參數** `buildServer(deps: ServerDeps = {})`（原 `(handler, replyClient)`）。
   理由：新增第三個依賴（`messageEventMap`），而三個位置參數的預設值會各自求值 ⇒ 不快取就會建出
   第二個 `pg.Pool`（違反 D-007 G4）。現改為物件 + 惰性單例 `defaultDeps()`（`server.ts:120-127`）。
   影響 6 處測試呼叫端，生產路徑 `src/index.ts` 的 `buildServer()` 不變。
2. **`renderEdit/help`、`renderCreateEntry/already_active` 不附錨點**。前者在 §5.3「明確不附」清單內；
   後者是 T-033c 才會改名為 `duplicate_event` 的分支，已落 errata E1（**T-033c 必須補上**）。
3. **quote 查表在 `candidates.length <= 1` 時仍會執行**（2 次額外查詢）。
   刻意不加「候選 ≤1 就跳過查表」的短路：那會把「≤1 忽略 quote」這條不變式複製到第二個地方，
   而 G2 正是為了讓該規則只存在於 `resolveTargetEvent` 一處。行為零差異（AC-6 覆蓋），只是成本。

## 4. 機器關卡（orchestrator 於本機實跑，非採信回報）

`npm run lint` 0 ／ `npm run typecheck` 0 ／ `npm run build` ✓ ／
`npm test` **533 passed（68 檔，基線 523/66，+10，零 skip）** ／
`npm run harness:check` **AC 273/273**（基線 266）、`doc_budget` ✓、`board_sync` ✓。

## 5. G14 讀取點窮舉（architect-reviewer 上一輪明確要求，複驗用）

`grep -rn "message_event_map\|getEventId\|messageEventMap" src --include=*.ts`（排除測試）：

- **讀**：`handler.ts:809`（`resolveQuotedEvent`）→ `handler.ts:176-184`（`resolveQuotedEventInGroup`，
  `events.getById` + `group_id` 比對）。**無第二處**——`getEventId` 沒有其他呼叫端。
- **寫**：`server.ts:152`（`recordReplyMapping`）。**無第二處**。
- 其餘命中皆為型別宣告、依賴注入與註解。

## 6. 相位提醒

`formatAmbiguousEvent` 的釘死字串含「請回覆或標註 @場地/@時間」——**「回覆」自本批起真正生效**
（T-033a~b 期間為已知空窗，D-026 §一 B-2 裁定不因相位改寫）。註解已同步更新，字串本身未動。

---

## 7. R2 雙審結果與封閉（2026-09-02）

### design-reviewer：**PASS with nits**（0 blocker）
四則釘死文案以 **sha256 + code point 雙重驗證**：本批零字元變動，且與 D-024／D-025／D-026／brief
全等；formatter 的改動全在 JSDoc。球種中性通過（新增行 grep 球種用語 0 命中；生產碼新增的唯一
中文字串是 log，不送使用者）。4 條 nit：
1. **D-026 相位註記過時** → **已修**：D-026 補 errata，聲明該兩段自 `41c15fc` 起為歷史敘述。
2. ambiguous 提示的「回覆」缺指向、可能形成無說明迴圈 → 入 backlog（釘死字串，改動需先出 errata）。
3. `分組`／`下一輪` 回覆不含活動識別 → 入 backlog（根因在 D-011 組版）。
4. 候選恰 1 場時 quote 被忽略（G2 既有規則）→ 非回歸，僅記錄。

### architect-reviewer：**BLOCK → 已封閉**
G3／G4／G6／G11／G14 五條全數通過，**G14 讀取點窮舉經其自行 grep 複驗屬實**；§3 三點裁定全部同意
（並補充：真正避免第二個 `pg.Pool` 的是 `defaultDeps()` 快取而非物件參數本身；`resolveQuotedEvent`
在無 quote 時早退，第 3 點的成本比本包描述更低）。

**B-1：D-025 errata E1 的「新暴露路徑」枚舉不完整。經 orchestrator 逐條查證——兩條均屬實，已修。**

| 查證項 | 結果 |
|---|---|
| `displayPhase`（`event-status.ts:31-35`）無 `cancelled` 分支 → 落 `live` | **屬實** |
| `findEventForDisplay`（`registration-service.ts:262-266`）註解宣稱「必為 draft/open，天然正確」 | **屬實，且該不變式自本批起失效** |
| `grouping-service.ts` 全檔零 status 判斷 | **屬實**（`grep -n "status" ` 零命中） |
| 對照：`signup`／`cancel`／`加開`／`編輯` 是否原本就有守門 | **有**（`isOpenForSignup`／`:450`／`:706-708`）——故只有 `名單`／`分組` 兩條需修 |

**修法**（皆為維持 T-033b 前語意的最小改動，不做新產品決策）：
- `findEventForDisplay` 的 `eventId` 分支先過 `DISPLAYABLE_EVENT_STATUSES`；cancelled/done →
  `no_open_event`，**`closed` 仍可查並標「（報名已截止）」**（不過度收緊）。同步修正假註解。
- `groupBalanced`／`startRounds` 加 `isActiveEvent`（`{draft, open}`）守門。
- D-025 errata E1 改寫為**逐指令完整盤點表**（7 個指令，標明哪些原本就有守門）。

**回歸鎖已驗證有效**：`d025-quote-mapping.test.ts`「D-025 errata E1」段 4 條；
`git stash` 移除修正後**恰好該 2 條轉紅**（`名單` 顯示已取消活動、`分組` 對已關閉活動成功），
其餘 7 條維持綠（證明守門未誤傷）。

### nit 處置
- architect nit「`renderBalanced`／`renderStartRounds` 的 `eventId === undefined` 分支不可達」→ 已加註型別收斂用。
- architect nit「`buildServer` 部分注入會靜默建 Pool」→ 已在 `ServerDeps` 加 ⚠ 註記。
- architect nit「`recordReplyMapping` 迴圈內逐列 await，中途拋錯會部分成功」→ 實務 1–2 則，接受現狀。
- 其餘（`cachedDeps` 模組級全域、`GroupingState.eventId` 選填取捨）皆判定為可接受，僅記錄。

### 修正後關卡（orchestrator 於本機重跑）
lint 0／typecheck 0／build ✓／**537 tests（68 檔，+4）**／harness **AC 273/273**、doc_budget ✓、board_sync ✓。

## 8. B-1 複審結果（2026-09-02）

architect-reviewer 複審 `a8b9b09`，判定 **B-1 封閉**：兩處修正正確、為還原舊語意的最小改動、零回歸風險；
並認可「移除修正後恰 2 條轉紅」比單純新增綠燈更可信。三項提問的回覆：

- **(a) 未過度收緊**，與其意圖一致。`closed` 在 `名單` 可查是對的（`DISPLAYABLE` 本就含 `closed`、
  fallback 路徑一直允許，收緊反而製造第二條規則）。並指出這其實是本批的**淨增益**：
  以前 `eventId` 分支拿不到 `closed`，現在引用舊公告可查到「（報名已截止）」的名單。
- **(b) 維持現狀正確，但要補 backlog**：選 `{draft, open}` 對——缺陷修復不夾帶產品決策，
  且「關閉報名後不能分組」本就是既有行為、非本批回歸。但「先鎖人數再分隊」是合理流程，
  該當產品問題另案。**已補**（`docs/backlog.md`，註明動工前需使用者裁決 + architect 決定改 D-011 或新開設計）。
- **(c) 無第三條漏網**，但盤點表少點名 `NEEDS_EVENT_SET` 的第 9 個成員 **`edit_help`**——
  它走不同的 render 分支（`renderEdit/help` 會輸出活動現值），雖共用同一道鎖內守門
  （`event-service.ts:725` 在 `:704-709` 狀態判定之後，orchestrator 已複驗），
  但表上沒點名，日後單獨動 help 路徑就擋不住。**已補**（E1 表加註，明列涵蓋全 9 成員）。

## 9. 裁定

**T-033b → DONE（2026-09-02，orchestrator 裁定）**。CLAUDE.md §6 關卡逐項：

0. 四關全綠（本機實跑）✓
1. AC 273/273，D-025 5 條 + D-029 2 條全覆蓋 ✓
2. 測試隨行（537 tests，+14）✓
3. **R2 雙審通過、Guardrails 零違反、blocker 已封閉** ✓
4. e2e：依 2026-09-02 使用者裁決，真機驗證統一掛 T-033c ✓（不在本批要求）
5. task-board 已更新（T-033b DONE、T-033c 解除阻塞 → READY、T-026 依 >10 筆規則歸檔）

**尚未 push、未開 PR、未部署**——等使用者決定。
