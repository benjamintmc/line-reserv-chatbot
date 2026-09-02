# D-023: 語意解析核心 `event-disambiguation.ts`（`resolveTargetEvent` + `matchSelector`）

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §4.3 **逐字**切出（顯示截斷屬 formatter 層，見 D-024），未改動任何已核可決定。
- 風險等級：**R2（高）**——本檔本身是純函式，但其輸出決定 `close_event`／`cancel_event`／`edit_event` 的授權作用對象（見 AC-23，D-026），故隨 T-033a 一併以 R2 審查。
- 來源：D-020 §4.3；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。同屬 T-033a 的並行文件：D-021、D-022、D-024、D-026。

## 一、設計內容

#### 4.3 語意解析（`src/domain/event-disambiguation.ts`，純函式）

```ts
export type TargetResolution =
  | { kind: 'none' }                        // candidates.length === 0
  | { kind: 'single'; eventId: number }     // candidates.length === 1（忽略 quote/selector）
  | { kind: 'resolved'; eventId: number }   // >1 候選，quote 或 selector 命中恰一場
  | { kind: 'ambiguous' }                   // >1 候選，無 quote 也無 selector
  | { kind: 'conflict' }                    // quote 與 selector 都給了，指向不同活動
  | { kind: 'not_found'; selectorRaw: string } // selector 命中 0 場
  | { kind: 'too_many'; selectorRaw: string }; // selector 命中 >1 場

export function resolveTargetEvent(
  candidates: EventRow[],
  quotedEventId: number | undefined,
  selectorRaw: string | undefined,
  now: string,
): TargetResolution;

/** 供 resolveTargetEvent 內部使用，亦單獨導出供測試：selector 對候選集合的比對。 */
export function matchSelector(
  candidates: EventRow[],
  selectorRaw: string,
  now: string,
): EventRow[]; // 回傳所有命中的列（0/1/多）
```

**`resolveTargetEvent` 判斷順序（逐字對應 decision #9 §步驟 1–6，G2 不得重排）**：

1. `candidates.length <= 1` → `candidates.length===0` 回 `none`；`===1` 回 `single`（**完全不看**
   quote/selector，即便使用者剛好帶了、或帶錯了，也不驗證——單場時的既有行為零回歸）。
2. `candidates.length > 1`：
   a. 若 `quotedEventId !== undefined` 且 `selectorRaw !== undefined`：先各自求值
      `quotedEventId`（直接視為候選之一，不再二次過濾是否在 candidates 內——見下方附註）與
      `matchSelector(candidates, selectorRaw, now)` 命中結果；若兩者不是同一個活動（selector
      命中非恰一場，或命中的那場 id ≠ quotedEventId）→ `conflict`。
   b. 否則若只有 `quotedEventId` → `resolved(quotedEventId)`。
   c. 否則若只有 `selectorRaw` → 依 `matchSelector` 命中數：0 → `not_found`；>1 → `too_many`；
      恰 1 → `resolved`。
   d. 兩者都無 → `ambiguous`。

**附註（quote 解析範圍的刻意取捨）**：`quotedEventId` 來自 `message_event_map`，其值**不限於**
目前仍在 `candidates`（active）內的活動——使用者可能引用一則指向已關閉/已取消活動的舊訊息。
本設計**不**在此處過濾，理由：多場並行下唯一需要消歧義的情境就是 candidates>1，只要
`quotedEventId` 有值就代表使用者明確指了某一場（即便那場已非 active），後續交給該指令自身既有的
「這場活動還能不能做這件事」判斷（如 `no_open_event`/`event_ended`/`closed_not_editable`）處理，
不在消歧義層重複這層邏輯（分工單一）。

**與跨群校驗的分工邊界**：本附註談的是「同群內、非 active 的舊活動」是否要被過濾——答案是不過濾
（分工單一，交給各指令自身狀態判斷）。這與 B1 修復的「跨群」校驗是兩件不同的事：**跨群校驗在
`resolveTargetEvent` 被呼叫之前、於 §5.2 dispatch 層就已完成**（見 §4.1）；傳入本函式的
`quotedEventId` 保證**若非 `undefined`，必屬於當前 `groupId`**——`resolveTargetEvent` 本身因此
不需要、也沒有 `groupId` 參數可用來重複這層檢查。

**`matchSelector` 比對規則**：

1. 以空白切分 `selectorRaw` 為 tokens。
2. 逐 token 分類：符合 `^\d{4}[/-]\d{1,2}[/-]\d{1,2}$` → 完整日期；符合 `^\d{1,2}[/-]\d{1,2}$`
   → 月日（無年，用今年份比對台灣本地日期的 `MM-DD`）；符合 `^\d{1,2}:\d{2}$` → 時間；
   其餘 → 場地文字 token。
3. 場地查詢字串 = 場地文字 tokens 以單一空白 join；非空時，先以 `event.location.includes(query)`
   （子字串，區分大小寫）過濾候選集合。
4. 若有日期 token，再以 `utcIsoToTaipei(event.event_datetime)` 的 `date` 過濾（完整日期精確比對；
   月日 token 只比對 `MM-DD` 後兩段，忽略年份）。
5. **時間 token 僅在「場地+日期過濾後仍 >1 場」時才進一步套用**（decision #9：「時間可先比對日期、
   不夠精準再加時間」——時間是次要窄化條件，非必要條件）。
6. 回傳最終過濾後的集合（可能 0/1/多筆）。

**已知限制（Backlog，非本輪必解）**：場地名稱若本身含空白（如「東方 A 場」），使用者以
`@東方 A場 +1` 這類 selector 輸入時，token 切分與比對可能不夠精準；MVP 先以子字串比對 + 使用者
可用完整場地名或唯一片段自行避開歧義的方式因應，不做進階模糊比對。

## 二、Guardrails（Must NOT）

- **G2（判斷順序不可重排）**：`resolveTargetEvent` 必須逐字依 §4.3 步驟 1–6（= decision #9 判斷
  順序）實作；`candidates.length<=1` 必須**最先**判斷且完全略過 quote/selector 的解析與驗證
  （即便解析了也不使用），不得先解析/驗證 selector 再判活動數——否則單場時仍可能因 selector
  格式錯誤而誤判為需要消歧義。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-023 AC-6] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-6]` 會對不上）。

- [ ] **[D-020 AC-6]（單場時零回歸）**：群組只有 1 場 open 活動時，`+1`（無 selector、無引言）、
  `@隨便打的文字 +1`（selector 存在但與該場地不符）、引用一則與該活動無關訊息的 `+1`，
  三者皆**照常成功報名該場**（`resolveTargetEvent` 回 `single`，完全不驗證 selector/quote 內容）。
- [ ] **[D-020 AC-8]（`@selector` 命中恰一場）**：2 場 open，場地分別為「旭陽」「東方」，
  `@旭陽 +1` → 報名到旭陽那場。
- [ ] **[D-020 AC-11]（`@selector` 場地+日期組合）**：2 場 open 同場地「旭陽」但日期不同，
  `@旭陽 8/15 +1` → 精準命中該日期那場。
- [ ] **[D-020 AC-12]（日期不夠精準時加時間窄化）**：2 場 open 同場地同日期、時間不同，
  `@旭陽 8/15 +1` 命中 >1 場，但同一 selector 若補上時間如 `@旭陽 8/15 07:30 +1` → 命中恰一場。
