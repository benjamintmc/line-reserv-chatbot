# D-026: dispatch 消歧義管線（`handler.ts` 插入點）

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §5.2 **逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——`src/webhook/handler.ts` 為所有指令的單一分派入口，且 AC-23（授權作用對象）在此定案。
- 來源：D-020 §5.2；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。同屬 T-033a 的並行文件：D-021、D-022、D-023、D-024。

## errata（2026-09-02，來源 T-033a R2 雙審 design-reviewer B-1；**使用者已裁決，本節生效**）

> **§5.2 的四種消歧義拒絕（`ambiguous`／`conflict`／`not_found`／`too_many`）送出回覆卻不
> `markProcessed`，牴觸 `CLAUDE.md` §4 去重政策**（「凡本次會送出回覆的訊息，含純拒絕文案，一律
> 消費其 `message.id`；唯一例外是本來就不回覆的路徑」）。具體後果：LINE webhook 重送時，群組會
> 重複收到同一句提示。
>
> **使用者裁決（2026-09-02）：維持現行「不 mark」，本節將其明列為 §4 去重政策的具名例外**，並同步
> 修正 `CLAUDE.md` §4 的例外句（原文只列「本來就不回覆」一種例外，已不描述現實）。理由：
>
> 1. 文案與 AC-7「不呼叫任何 service、不 markProcessed」皆為已核可裁決，改實作須連帶改寫 §5.2、
>    AC-7 與測試。
> 2. **已有同型先例**：`closeEvent`／`cancelEvent` 的 `not_authorized` 於 `event-service.ts:601-603`
>    early-return，早於 `this.tx` 內 `:606` 的 `markProcessed`——同樣是「回覆但不消費」。
>    （審查意見原稱「全 repo 無此先例」，經 orchestrator 查證**不成立**；該意見只檢視了 `editEvent`
>    `:698-711`，那條走 `runImmediate` 先 mark 再授權，是 repo 內並存的**另一種**模式。）
> 3. 這四種拒絕是純判斷、零 DB 副作用，重送重跑不產生任何狀態變化。
>
> **已知代價（接受，非缺陷）**：LINE 重送時使用者會重複看到同一則提示。
>
> **本節由 orchestrator 落筆記錄使用者裁決，尚未經 architect 確認。**

## errata（2026-09-02，T-033b 落地；來源 R2 雙審 design-reviewer nit-1）

> **下方「〔切檔新增〕相位說明」與「〔切檔複審新增〕」兩段自 commit `41c15fc` 起為歷史敘述，
> 不再描述現況。** 機制 A（`message_event_map` 讀寫）已隨 T-033b 落地：
>
> - 步驟 4 的 `quotedEventId` **不再恆為 `undefined`**；`resolveQuotedEventInGroup` 是生產碼中
>   `message_event_map` 的唯一讀取消費點，G14／AC-28 已實作並有測試（D-025 errata E2）。
> - AC-7 釘死文案中的「**回覆**」（引言）**自此真正生效**，與 `@selector` 兩種指定方式並存。
>   T-033a~b 之間那段「照做卻靜默無效」的空窗已結束；釘死字串自始未改（B-2 裁定不因相位改寫）。
> - 仍未落地的只剩 §3.5 開團側（同群 open 上限、開團查重）——屬 **T-033c**（D-027／D-028）。
>
> 兩段歷史敘述保留不刪，以免後續 agent 對照 commit 歷史時失去脈絡。

## 一、設計內容

> **〔切檔新增〕相位說明**：本檔描述 dispatch 管線的**最終狀態**。T-033a 落地時機制 A 尚未實作，
> 故步驟 4 的 `rawQuotedEventId`／`quotedEventId` 兩行與 `resolveQuotedEventInGroup` 恆解出
> `undefined`（等同「未引言」，落既有分支，無新行為）；該段的守門 G14 與 AC-28 屬 **T-033b**（D-025）。
> `splitSelector`（D-024）、`resolveTargetEvent`（D-023）與四個 formatter 隨 T-033a 同批落地。
> **〔切檔複審新增，2026-09-02 R2 複審 B-2〕**：AC-7 釘死文案中的「**回覆**」（引言）於 T-033a~b 恆
> 無效——引言解出 `undefined`，使用者照做會靜默落回同一 `ambiguous` 分支、收到同一句提示。該期間
> **唯一可用的指定方式是 `@selector`**。該文案為 2026-08-31 使用者裁決之釘死字串，**不因相位而改寫**
> （改了會製造第二種說法、且 T-033b 後須改回）；T-033b 落地機制 A 後兩種方式皆生效。

#### 5.2 handler.ts 的消歧義插入點

```
dispatchSingle(groupId, userId, messageId, text):
  1. { selectorRaw, rest } = splitSelector(text)
  2. cmd = parseCommand(rest)
  3. 若 cmd.type ∉ NEEDS_EVENT_SET → 照舊分派（不查候選、不消歧義；my_id/confirm/abort/
     create_event_*/group_next/unknown/非 edit_event 的 invalid 皆屬此類）
  4. 否則：
     candidates = events.listActiveByGroup(groupId)
     rawQuotedEventId = event.message.quotedMessageId 存在 ? await messageEventMap.getEventId(...) : undefined
     quotedEventId = await resolveQuotedEventInGroup(rawQuotedEventId, groupId, events)  // B1：跨群校驗，見 §4.1
     resolution = resolveTargetEvent(candidates, quotedEventId, selectorRaw, nowIso())
     依 resolution.kind 短路（ambiguous/conflict/not_found/too_many → 對應的 4 個新 formatter，
       直接回覆，**不呼叫任何 service**，不 markProcessed——這些是純判斷、無副作用的拒絕，
       比照既有「非授權早退不 mark」的精神；見 AC 對應項）；
     none → eventId = undefined；single/resolved → eventId = resolution.eventId
     5. 呼叫對應 service，Input 帶上 eventId
```

```ts
/** B1 修復：quote 解出的 eventId 必須先確認屬於當前群組，才可交給 resolveTargetEvent。
 *  不符/查無 → 視為未引言（undefined），不建立專屬錯誤訊息、不洩漏別群任何資訊。 */
async function resolveQuotedEventInGroup(
  rawEventId: number | undefined,
  groupId: string,
  events: EventReader,
): Promise<number | undefined> {
  if (rawEventId === undefined) return undefined;
  const row = await events.getById(rawEventId);
  return row !== undefined && row.group_id === groupId ? rawEventId : undefined;
}
```

`NEEDS_EVENT_SET = { signup, cancel, list, add_capacity, group, close_event, cancel_event,
edit_event, edit_help }`。

`handleBatch`（D-012）：`splitSelector` 對整段原文呼叫**一次**（在 D-012 既有的 `\r?\n` 拆行**之前**），
故「第一行 selector」的既定語意（decision #9）由 `splitSelector` 本身的換行穿越規則自然滿足
（見 §4.2 演算法步驟 2 的換行說明）；`resolveTargetEvent` 針對整批只解一次，解出的 `eventId`
套用到批次內每一行（G12：不支援批次內以第 2 行以後的 `@` 切換活動——若某行仍以 `@` 開頭，
`parseCommand` 對該行仍走既有 dispatch，多半落 `unknown`/`invalid`，因 D-012 既有規則本就只認
`signup`/`cancel` 為可執行行，非法/非預期型別一律忽略，零新增行為）。

## 二、Guardrails（Must NOT）

- **G11（`下一輪` 不跑消歧義）**：`nextRound`／`GroupingService.nextRound` 不得呼叫
  `splitSelector`/`resolveTargetEvent`；其目標活動完全由既有 grouping session 決定
  （decision #9 判斷順序清單未列 `下一輪`，擴大範圍即偏離裁決）。
- **G12（批次僅認第一行 selector）**：`handleBatch` 不得允許第 2 行以後以新的 `@selector`
  切換目標活動；整批訊息共用 `dispatchSingle`/`handleBatch` 前一次性解出的 `eventId`。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-026 AC-7] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-7]` 會對不上）。

- [ ] **[D-020 AC-7]（多場、無 selector/引言 → 提示）**：群組有 2 場 open 活動，`+1`（無 `@`、
  非引言）→ 回「群組內有多場球敘進行中，請回覆或標註 @場地/@時間 以指定要操作的球敘」，
  不呼叫任何 service、不 markProcessed。
- [ ] **[D-020 AC-20]（批次僅認第一行 selector）**：多場並行時，訊息 `@旭陽\n+1\n-1 陳先生`
  → 兩行皆作用於旭陽那場（單次消歧義，套用整批）。
- [ ] **[D-020 AC-21]（`下一輪` 不需 selector 即可用）**：多場並行、其中一場已啟動分組 session，
  該場主辦人於同群直接輸入 `下一輪`（無 `@selector`、無引言）→ 正常推進該場的分組（§5.5，
  不因 candidates>1 而要求消歧義）。
- [ ] **[D-020 AC-23]（授權判定作用於正確的已解析活動）**：多場並行，A 場 host 為甲、B 場 host
  為乙；甲於 `@B場地 取消活動` → 依 B 場的 `host_user_id` 判定甲非授權（`not_authorized`），
  不得誤用 A 場的授權放行。
