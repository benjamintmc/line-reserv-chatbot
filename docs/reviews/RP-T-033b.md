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
