# D-005: 計費模式（Billing Modes：每人固定 / 場地費均攤 + 主辦自動登記 + 關閉結算 + 文案中性化）

- 狀態：APPROVED（2026-07-31）——R2 雙審通過（architect 條件式 APPROVED 零改碼 blocker + design 3 blocker 已修）、OP-1~4 定案、使用者最終核可。條件（D-001 G2 carve-out errata）APPROVED 後由 architect 補寫。
- 撰寫者：backend-engineer
- 風險等級：**R2（高）**——含 **schema migration（0002，events 加欄位）**、金額顯示語意（均攤暫估 vs 最終結算）、以及**影響報名核心的開團自動登記**（於 event 建立交易內插入報名列）。依 CLAUDE.md §5：強制 design-reviewer + architect-reviewer 雙審 + e2e、Guardrails ≥ 3（本文件列 8 條）。
- 關聯：Brief「範圍」FR-3 活動建立 §34 / FR-2 名單查詢（每人價格、預估總金額）§33 / 決策紀錄 #3 同群限一場 §82 ・ 任務 T-009 ・ 設計 D-005
- 相依：
  - **D-001（APPROVED）**：`events` schema（`price_per_person`）、§7 狀態機、§8 migration 策略、`registrations` per-slot（`insertSlot` seq 指派）、repository 原語。**本文件擴充 `events` schema（加 `price_mode`/`venue_fee`），屬 D-001 schema 擴充——需 architect（D-001 owner）於審查時確認並補 D-001 errata 或核可本文件 §1 為擴充來源。本文件不私改 D-001。**
  - **D-002（APPROVED）**：`parseCommand()` 與 `commands/validators.ts`（`validatePrice` 等單一 source of truth）。**本文件擴充一行式開團的計費語法（parser 層擴充，非契約變更；沿用 D-004 OP-9 先例——commands 層擴充由本任務一併補上），需 Orchestrator 確認納入 T-009。**
  - **D-003（APPROVED / 已實作 T-006）**：`registration-service`（signup/cancel/遞補/roster）**完全不動**；`list-formatter`（`eventHeader`/`formatList` 預估總金額）**依 price_mode 擴充顯示**；`RegistrationView`/`buildView` 沿用。
  - **D-004（APPROVED / 已實作 T-008）**：`event-service.confirm`（建立 open event）→ **接上主辦自動登記**；`closeEvent`（open→closed）→ **接上 split 最終結算公告**；`event-formatter`（確認摘要/開團公告/關閉回覆/重複活動摘要）**依 price_mode 擴充顯示**；`create-flow` state machine → **加計費方式分支**。

---

## 一、設計內容

### 0. 定位與前提

D-005 為既有 MVP 的**計費擴充**：在「每人固定價（`per_person`，現行）」之外新增「**固定場地費總額均攤**（`split_venue`）」計費模式，並配套三項語意變更：

1. **均攤估算**：`split_venue` 每人金額 = `ceil(venue_fee / 正取數)`，**當下顯示為暫估**、`關閉報名` 時快照最終攤額並公告。
2. **主辦自動登記**：`確認` 建立 open event 時，自動把主辦人登記為第 1 個正取（名單第 1 位），使均攤分母天然 ≥ 1 並反映現實。
3. **文案中性化**：移除高爾夫專屬用語（球聚→球敘、開球時間→時間、球場→場地），只顯示 場地／日期時間／費用。

**使用者已鎖定的決策（本文件視為已定案輸入，不再開放討論）**：兩種模式、ceil 無條件進位、暫估 vs 關閉結算、主辦自動登記為第一人、維持同群單場（`ux_events_active_group` 不動）、忽略球種（不加 `sport_type`）、付款/最低成行/no-show/多成本拆分/多場並行皆為 future phase（見「範圍外」）。

**架構慣例（沿用 D-003/D-004，不得破壞）**：domain（`registration-service`/`event-service`/`create-flow`）與 formatter（`list-formatter`/`event-formatter`）**只透過 repository 存取、不直接下 SQL、不 import LINE SDK 型別**；金額為整數新台幣元（D-001 §0）；均攤取整一律在 domain/formatter 純函式計算，**不進 DB**。

---

### 1. schema delta（D-001 §2 `events` 擴充）與 migration 0002

#### 1.1 欄位增訂

於 `events` 表新增兩欄（型別對映沿用 D-001 §0）：

| 欄位 | SQLite 型別 | PostgreSQL 型別 | NULL | 預設 | 約束 |
|---|---|---|---|---|---|
| `price_mode` | TEXT | TEXT | NO | `'per_person'` | `CHECK (price_mode IN ('per_person','split_venue'))` |
| `venue_fee` | INTEGER | INTEGER | YES | NULL | `split_venue` 時必填且 `> 0`；`per_person` 時 NULL（一致性見 §1.3） |
| `settled_per_person` | INTEGER | INTEGER | YES | NULL | **OP-3 裁決：持久化**。`關閉報名` 時（split）寫入最終每人攤額；未關閉或 per_person 為 NULL |

**既有 `price_per_person` 欄位語意釐清（不改型別，維持 `INTEGER NOT NULL DEFAULT 0 CHECK (>=0)`）**：

- `per_person` 模式：`price_per_person` = 每人金額（≥ 0），`venue_fee` = NULL。
- `split_venue` 模式：**`price_per_person` = 0**（欄位 NOT NULL 不可為 NULL，故以 0 表達「不適用」），`venue_fee` = 場地費總額（> 0）。每人金額由應用層 `ceil(venue_fee / 正取數)` 動態計算，**不存欄位**。

#### 1.2 migration 0002（SQLite；PG 差異沿用 D-001 §8 型別對映，MVP 先交付 SQLite）

新增 `src/db/migrations/0002_billing_modes.sql`（序號決定套用順序，runner 自動比對 `schema_migrations`，見 `src/db/migrate.ts`；一經合併不得修改本檔）：

```sql
-- 0002_billing_modes.sql — D-005 計費模式：events 加 price_mode / venue_fee。
-- SQLite ALTER TABLE ADD COLUMN：NOT NULL 欄位須帶非 NULL DEFAULT（price_mode 有），
-- 既有列自動以 DEFAULT 回填（backfill 無需額外 UPDATE）。
ALTER TABLE events ADD COLUMN price_mode TEXT NOT NULL DEFAULT 'per_person'
  CHECK (price_mode IN ('per_person', 'split_venue'));
ALTER TABLE events ADD COLUMN venue_fee INTEGER
  CHECK (venue_fee IS NULL OR venue_fee > 0);  -- 單欄 CHECK（architect N1，ADD COLUMN 允許）：攔 <=0 髒寫入；split 時應用層另保證非 NULL
ALTER TABLE events ADD COLUMN settled_per_person INTEGER;  -- OP-3：關閉報名(split)時寫入最終攤額；否則 NULL
```

> **OP-3 裁決（2026-07-31，使用者選持久化）**：最終攤額存 `settled_per_person`。因 0002 尚未實作，三欄一併納入本 migration（不另開 0003）。`關閉報名`(close_event) 於 split 模式計算 `ceil(venue_fee/正取數)` 並於**同交易**寫入該欄（見 §4）。

**backfill（既有列）**：SQLite `ADD COLUMN ... NOT NULL DEFAULT 'per_person'` 會將**所有既有列**（含既有 `status='open'` 活動）的 `price_mode` 自動填為 `'per_person'`、`venue_fee` 填為 NULL——即既有活動一律視為每人固定價，行為零回歸（§8 不動清單、G8）。無需額外 `UPDATE` 語句。

#### 1.3 venue_fee 與 price_mode 的一致性（跨欄位約束）

理想約束為表級 CHECK：
```
CHECK ((price_mode='per_person' AND venue_fee IS NULL)
    OR (price_mode='split_venue' AND venue_fee IS NOT NULL AND venue_fee > 0))
```
但 **SQLite `ALTER TABLE ADD COLUMN` 的欄位級 CHECK 不得跨參照其他欄位**，表級 CHECK 需「建新表→複製→drop→rename」的 table-rebuild（並重建 `ux_events_active_group`/`ix_events_group_status`/FK），較侵入。

- **MVP 建議（本文件採用）**：欄位級只放 `price_mode` 的二值 CHECK（ADD COLUMN 允許）；**跨欄位一致性由應用層（`EventRepository.create` 邊界驗證 + domain 保證 + G4）強制**，並以測試（AC-13）鎖定。`price_per_person` 於 split 恆為 0、per_person 為金額，皆由 domain 於建立時決定。
- **強化選項（交 architect 裁決，OP-4）**：若 D-001 owner 要求 DB 層兜底，0002 改採 table-rebuild 以加上表級 CHECK。**此為 D-001 schema 擴充決策，須 architect 確認**（見回報）。

---

### 2. 計費計算模型（純函式，domain/formatter，不進 DB）

新增 `src/domain/billing.ts`（純函式、對 DB/LINE 零耦合、嚴禁 any、不下 SQL）：

```ts
// 設計說明用（非實作交付）
export type PriceMode = 'per_person' | 'split_venue';

/** 均攤分母 robustness：主辦自動登記已保證 >=1，仍以 max(,1) 防除零（G1）。 */
export function perPersonAmount(event: EventRow, confirmedCount: number): number {
  if (event.price_mode === 'split_venue') {
    const fee = event.venue_fee ?? 0;               // 一致性下 split 恆有 venue_fee>0
    return Math.ceil(fee / Math.max(confirmedCount, 1));   // 無條件進位（G1）
  }
  return event.price_per_person;                    // per_person：每人固定（回歸不變）
}

/** 顯示用預估總額。per_person=正取數×每人；split=venue_fee（固定，與正取數無關）。 */
export function estimatedTotal(event: EventRow, confirmedCount: number): number {
  return event.price_mode === 'split_venue'
    ? (event.venue_fee ?? 0)
    : confirmedCount * event.price_per_person;
}
```

- **ceil 一律無條件進位**（G1）：`ceil(3000/7)=ceil(428.57)=429`。總額 `429×7=3003 ≥ 3000`（多收無妨，寧多不少；不做找零，屬 future 付款 phase）。
- **split 總額固定 = `venue_fee`**（與正取數無關）；per_person 總額 = `正取數 × price_per_person`（沿用 D-003 §8(E) 現行語意）。

---

### 3. 主辦自動登記（`event-service.confirm` 擴充；影響報名核心）

`確認` 建立 open event 後、**於同一 `confirm` 交易內**，插入主辦人的第 1 個正取 self 名額（名單第 1 位＝主辦人）。

**改動點**：`src/domain/event-service.ts` 的 `confirm()`（現 §4 落地於 code L300–341）——在 `this.events.create({... status:'open'})` 成功後、`conversations.delete` 前，加一步：

```ts
// D-005 §3：主辦自動登記為第 1 正取（名單第 1 位；均攤分母天然 >=1）。
this.registrations.insertSlot({
  eventId: event.id,
  ownerUserId: host.id,          // = 建立者（G8 已取得的 host.user）
  displayName: input.hostDisplayName,  // 主辦顯示名快照（沿用 §4 getGroupMemberProfile）
  kind: 'self',
  status: 'confirmed',
});
```

- **走既有 per-slot 交易原語（G3、不繞過）**：直接呼叫 D-001 `RegistrationRepository.insertSlot`（其內 `assertInTransaction()` 守門——`confirm` 的 `runInTransaction`（DEFERRED，D-004）已於首步 `markProcessed`（寫）取得 RESERVED 鎖，`db.inTransaction===true`，守門通過）。`insertSlot` 於空 event 計 `seq = COALESCE(MAX(seq),0)+1 = 1`，故主辦名額 **seq=1、kind='self'、status='confirmed'、cancelled_at=NULL**。
- **無超賣風險**：event 剛建立、無其他報名列、無並行讀寫該 event 的 capacity，DEFERRED 交易於此單筆首列插入安全（不同於 D-003 報名的 read-decide-write 需 IMMEDIATE）。**此點需 architect 於審查確認 DEFERRED 對「建立當下插入第一列」足夠**（見回報、OP 無——architect 裁定點）。
- **依賴**：`EventService` 需注入 `RegistrationRepository`（新增建構子依賴），`server.ts` 組裝時傳入（已有該 repo 實例，D-003 已建）。
- **與 D-003 per-slot/seq 語意一致**：主辦名額與一般 `+N` self 名額結構相同，roster（`buildRoster`）自然把它渲染為第 1 位；主辦之後 `+N` 追加從 seq=2 起。**registration-service 本身零改動**（G5）——主辦登記由 event-service 於建立時完成，非改報名流程。
- **主辦能否 `-1` 移除自己**：見微 OP-1（建議可移除，靠 §2 `max(,1)` 保底）。

---

### 4. 關閉報名結算（`event-service.closeEvent` 擴充）

`關閉報名`（open→closed）時，`split_venue` 模式計算並公告**最終每人攤額**（此刻正取數凍結，因 closed 後 D-003 不再接受 signup/cancel，數字穩定）。

**改動點**：`src/domain/event-service.ts` 的 `closeEvent()`（現 §5.2）——`updateStatus(closed)` 後，於交易內重查正取數，回傳結算資訊給 formatter：

```ts
// closeEvent 成功分支擴充（示意）
this.events.updateStatus(active.id, 'closed');
const confirmedCount = this.registrations.countConfirmed(active.id);   // 有效正取數（G6 過濾）
return { kind: 'ok', event: { ...active, status: 'closed' }, confirmedCount };
```

- `CloseResult` 的 `ok` 分支加欄位 `confirmedCount: number` 與 `settledPerPerson: number | null`（供 formatter 顯示；per_person 為 null）。
- **結算持久化（OP-3 裁決：存欄位）**：`關閉報名`(split) 於**同交易內**計算 `settledPerPerson = ceil(venue_fee / max(正取數,1))` 並 `events` 寫入 `settled_per_person`。**新增專屬 repo 原語 `EventRepository.updateSettledPerPerson(id, amount)`（architect N2：不併入通用 `updateStatus`，避免狀態轉移與結算金額兩種關注點耦合）**。`CloseResult.ok` 帶 `settledPerPerson`，**formatClosed 只認此值為唯一真相來源（architect N3）**，不從 `event` spread 讀（該 spread 為 pre-close 快照、settled_per_person 仍 NULL）。per_person 模式不寫（NULL）、傳 null。此欄位供未來付款結算 phase 複用（G2 仍要求關閉前顯示標「暫估」）。
- `per_person` 模式關閉時**不附結算列**（金額本即固定，維持 D-004 §8(E) 原文案，AC-8）。

---

### 5. formatter 改動（`list-formatter` / `event-formatter`）

所有「費用列」依 `event.price_mode` 顯示；**均攤模式一律標「（暫估，關閉報名後結算）」**（G2）。

#### 5.1 費用列共用渲染（新增 helper，供兩 formatter 複用）

```
per_person：  每人費用：2200 元
split_venue： 場地費：3000 元，平均每人約 429 元（暫估，關閉報名後結算）
             （正取數為分母；confirmedCount 由 view/結算提供）
```

- `src/domain/list-formatter.ts`：
  - `eventHeader(event, forSignup)`：費用列改為呼叫費用列 helper（傳入 `event` 與該情境的 `confirmedCount`）。**注意**：header 現為無正取數版本，split 需 `confirmedCount`——signup/cancel/list 皆有 `view.confirmedCount` 可傳入；helper 簽名改為 `feeLines(event, confirmedCount)`。
  - `formatList`：預估總金額列——per_person 維持 `預估總金額：3 × 2200 = 6600 元`（回歸，AC-1）；split 改為 `預估總金額：場地費 3000 元（固定，暫估）`（總額固定 = venue_fee，AC-2/AC-14）。
  - `formatSignup`/`formatCancel`：透過 `eventHeader` 自動套用新費用列（無其他改動；報名/取消主流程不動）。
- `src/domain/event-formatter.ts`：
  - `formatConfirmSummary(draft)`：確認摘要費用列依 draft 的計費模式顯示（每人 N 元 ／ 場地費 N 元，平均每人約 M 元（暫估））——需 `CreateEventDraft` 帶 `priceMode`/`venueFee` 與 draft 當下的預估正取數（建立前無正取，split 摘要以「主辦 1 人」為分母預估或標「開團後依報名人數均攤」；**建議摘要階段 split 只顯示場地費總額 + 「開團後依實際報名人數均攤」**，不硬算 M，避免建立前分母失真）。
  - `formatOpenAnnouncement(event)`：開團公告費用列——split **只顯示** `費用：場地費 N 元，將依報名人數均攤（暫估，關閉報名後結算）`，**不顯示每人估額**（design-reviewer B2：正取=1 時顯示「平均每人約 3000 元」即使標暫估仍造成價格錯覺）。另於公告或確認摘要明示主辦已佔第 1 正取（architect N4），例：公告尾附「（主辦已自動報名為第 1 位）」。
  - `formatClosed(event, settledPerPerson)`：**參數改為 `settledPerPerson: number | null`（唯一真相來源，architect N3——不再從 `event` spread 讀可能為 NULL 的舊值）**。split 追加最終結算列（design-reviewer 結算 nit：補「多收不找零」）：`本場最終每人費用：M 元（場地費 N 元 ÷ 正取 K 人，除不盡無條件進位；多收部分不另找零）`；per_person 傳 `null`、維持原句不附結算列（AC-7/AC-8）。
  - `formatAlreadyActiveEntry(event)`：重複開團摘要費用列同步 mode-aware。

#### 5.2 型別擴充

- `CloseResult.ok` 加 `confirmedCount`；`formatClosed` 增參數。
- `CreateEventDraft`（`create-flow.ts`）加 `priceMode?: PriceMode`、`venueFee?: number`（`price` 於 split 語意為 0/不填，見 §6）。
- 新增 `billing.ts` 純函式供兩 formatter 與 closeEvent 複用（單一計算 source of truth）。

---

### 6. 開團計費語法（D-002 parser 擴充 + `create-flow` 擴充）

#### 6.1 一行式（`create_event_oneline`）

維持 **5-token arity**（location 仍限單一 token，沿用 D-002 O-5）；**第 5 欄（費用）以關鍵字前綴表達模式**（無空白，保持 arity=5）：

| 第 5 欄樣態（正規化後） | 模式 | 解析 |
|---|---|---|
| `場地費3000元` / `場地費3000` | `split_venue` | venue_fee=3000（> 0） |
| `每人2200元` / `每人2200` | `per_person` | price_per_person=2200 |
| 裸 `2200元` / `2200`（無前綴） | `per_person`（預設） | price_per_person=2200（回歸 D-002 現行） |

- 關鍵字（`場地費` vs `場地` vs `均攤`）之確切選定 → **微 OP-2**（本文件建議 `場地費`）。
- **parser 改動**（`src/commands/`）：
  - `commands/validators.ts` 新增 `validateFee(tok): ValidationResult<{ mode: PriceMode; amount: number }>`——去前綴關鍵字判定 mode → 去尾綴 `元` → `^\d+$` → split 需 `>0`、per_person 需 `>=0`。沿用單一 source of truth（D-004 G7）。
  - `commands/types.ts`：`ParsedCommand.create_event_oneline` 加 `priceMode: PriceMode`；`price` 語意調整為「per_person 金額」，split 時 `price=0`、新增 `venueFee?: number`。新增 `InvalidReason` 值 `'create_bad_venue_fee'`（或複用 `create_bad_price`——建議新增以利精確提示，OP-2 附帶）。
  - `commands/parse.ts` `parseOnelineCreate`：第 5 欄改呼叫 `validateFee`，據 mode 填 `priceMode`/`price`/`venueFee`。
  - 一行式 `create_event_oneline` 消費端 `event-service.handleOneline`：把 `priceMode`/`venueFee` 帶入 draft。

#### 6.2 逐步問答（`create-flow` state machine）

在 `awaiting_price` 前插入**計費方式提問** `awaiting_price_mode`（並據答案分流至 `awaiting_price` 或 `awaiting_venue_fee`）：

```
… awaiting_capacity ──► awaiting_price_mode
awaiting_price_mode ──「每人」──► awaiting_price     ──(合法)──► awaiting_confirm
awaiting_price_mode ──「場地費」──► awaiting_venue_fee ──(合法)──► awaiting_confirm
（非法答案 → 停留該 state 重問）
```

- `create-flow.ts`：`CreateState` 加 `'awaiting_price_mode'`、`'awaiting_venue_fee'`；`FIELD_ORDER` 於 `awaiting_capacity` 後插 `awaiting_price_mode`，其後分岔（`nextState` 依 payload.priceMode 決定進 `awaiting_price` 或 `awaiting_venue_fee`，二者皆前進 `awaiting_confirm`）。
- `applyAnswer`（**design-reviewer B1：行為定死，無效答案一律停留重問，不容錯猜測**）：
  - `awaiting_price_mode`：答案 trim 後**僅接受**「每人」→ `priceMode='per_person'` 前進 `awaiting_price`；「場地費」（或「均攤」同義）→ `priceMode='split_venue'` 前進 `awaiting_venue_fee`。**其餘任何輸入（含裸數字、其他字）→ 停留 `awaiting_price_mode` 重問 (見範本)**（不猜測、不當金額）。
  - `awaiting_venue_fee`：`validateFee` split 分支（`>0`）→ `venueFee`；無效 → 停留重問。
  - `awaiting_price`：沿用 `validatePrice`（per_person）；無效 → 停留重問。
- `isComplete(draft)`：改為「per_person → date/time/location/capacity/price 齊備；split → date/time/location/capacity/venueFee 齊備且 priceMode 已定」。
- `event-formatter` 新增對應提問範本（§7 (A) 擴充）：
  ```
  awaiting_price_mode（提問）    → 請選擇計費方式：輸入「每人」固定每人費用，或「場地費」由場地費總額均攤
  awaiting_price_mode（無效重問）→ 請輸入「每人」或「場地費」：「每人」設定固定每人費用，「場地費」由場地費總額均攤（過程中可輸入「取消」放棄開團）
  awaiting_venue_fee（提問）     → 請輸入場地費總額（元，例：3000；將依報名人數均攤）
  awaiting_venue_fee（無效重問） → 場地費需為正整數（元，例：3000），請重新輸入。
  ```
  （design-reviewer B1：新增 state 一律同時交付「提問 + 無效答案重問範本 + 對應 AC」，比照 D-004 §8(C)；避免「輸入了卻無回覆」的靜默死角。）

> §6 為 parser 層與 create-flow 擴充，**跨 D-002／D-004 兩份 APPROVED 文件**；依 D-004 OP-9 先例（commands validator 擴充納入實作任務），建議由 T-009 一併補上並過 architect/design review。**回報 Orchestrator 確認**。

---

### 7. 文案中性化對照表（涵蓋 D-003 §8 與 D-004 §8 範本 → 對應 code）

移除高爾夫專屬用語，改中性「球敘／時間／場地」。**只改使用者可見文案，不改指令關鍵字**（`開團`/`名單`/`+N` 等不動）。

| 位置（檔案 / 函式） | 現行（golf 用語） | 中性化後 |
|---|---|---|
| `list-formatter.eventHeader` | `[X 球聚報名]` / `[X 球聚]` | `[X 球敘報名]` / `[X 球敘]` |
| `event-formatter.formatFlowPrompt` awaiting_time | 請輸入**開球時間**（格式 HH:MM…） | 請輸入**時間**（格式 HH:MM…） |
| `event-formatter.formatFlowPrompt` awaiting_location | 請輸入**球場地點**（例：東方球場） | 請輸入**場地**（例：○○球場） |
| body 欄位標籤（list-formatter/event-formatter 各摘要） | `地點：東方球場` | `場地：東方球場`（**design-reviewer nit A：body 標籤與提問「場地」統一**，全 formatter 一致改「場地：」）|
| `event-formatter.formatOpenAnnouncement` | `[X 球聚] 開團成功！` | `[X 球敘] 開團成功！` |
| `event-formatter.formatClosed` | `「X」球聚已關閉報名…` | `「X」球敘已關閉報名…` |
| `event-formatter.formatCancelled` | `「X」球聚已取消。` | `「X」球敘已取消。` |
| `event-formatter.formatOnelineFormatHelp` (K) | 例：開團 … 東方**球場** … | **design-reviewer B3：(K) 須涵蓋兩種計費語法 + 範例去高爾夫（nit B）**，改為下方 (K′) 範本 |

- **地點欄本身是使用者輸入的場地名稱**（如「東方球場」），非系統用語——不改使用者輸入，只改**系統標籤/標題**（球聚/開球時間/球場地點 等）。

**(K′) 一行式格式提示（design-reviewer B3：涵蓋兩種計費語法，取代 D-004 (K)）**
```
格式：開團 <日期> <時間> <地點> <人數> <費用>
費用兩種寫法：
・每人固定：直接寫金額，例 2200元（或 每人2200元）
・場地費均攤：場地費+總額，例 場地費3000元
範例：開團 2026/08/15 07:30 東方球場 16人 2200元
　　　開團 2026/08/15 07:30 東方球場 16人 場地費3000元
```
- **跨文件協調點**：以上 code 文案與 **D-003 §8 / D-004 §8 的逐字範本**（design-reviewer 逐字對齊依據）將不一致。D-003/D-004 為 APPROVED 且非本文件所有——**須回報 Orchestrator**：由各 owner 補 errata、或明列「D-005 為此批文案的新權威來源」。本文件不私改 D-003/D-004。

---

### 8. 模組影響清單（改 / 不動）

**改動（T-009 交付）**：

| 檔案 | 改動 |
|---|---|
| `src/db/migrations/0002_billing_modes.sql` | **新增**：events 加 `price_mode`/`venue_fee`（§1.2） |
| `src/db/schema.ts` | `EventRow` 加 `price_mode: PriceMode`、`venue_fee: number \| null`、`settled_per_person: number \| null`；export `PriceMode` 型別 |
| `src/db/repositories/event-repository.ts` | `CreateEventInput` 加 `priceMode`/`venueFee`；`create` INSERT 帶新欄位 + **邊界層強制一致性**（split→venue_fee>0 & price_per_person=0；per_person→venue_fee=NULL）（§1.3、G4）；新增 `updateSettledPerPerson(id, amount)`（OP-3，close 交易內寫入） |
| `src/domain/billing.ts` | **新增**：`perPersonAmount`/`estimatedTotal` 純函式（§2） |
| `src/domain/event-service.ts` | `confirm` 加主辦自動登記（§3）；`closeEvent` 加 `confirmedCount` 結算（§4）；建構子加 `RegistrationRepository` 依賴 |
| `src/domain/create-flow.ts` | `CreateState`/`CreateEventDraft`/`FIELD_ORDER`/`nextState`/`applyAnswer`/`isComplete` 加計費方式分支（§6.2） |
| `src/domain/list-formatter.ts` | 費用列 helper mode-aware（§5.1）；`formatList` 預估總額 mode-aware |
| `src/domain/event-formatter.ts` | 確認摘要/開團公告/關閉回覆/重複活動摘要 費用列 mode-aware（§5.1）；加 `awaiting_price_mode`/`awaiting_venue_fee` 提問；文案中性化（§7） |
| `src/commands/{types,validators,parse}.ts` | 一行式計費語法（§6.1）：`validateFee`、`create_event_oneline` 加 `priceMode`/`venueFee` |
| `src/webhook/handler.ts` | `handleOneline` 帶 `priceMode`/`venueFee`；`renderClose` 傳 `confirmedCount` 給 `formatClosed`；窮舉分派沿用（新 state 由 continueFlow 內部消化，無新 ParsedCommand.type） |
| `src/server.ts` | `EventService` 組裝加傳 `RegistrationRepository` |
| `.env.example` | 無新增 env（計費模式非機密）；本文件不新增秘密 |

**明確不動（G5/G7/G8 保護）**：

| 不動 | 理由 |
|---|---|
| `src/domain/registration-service.ts`（signup/cancel/遞補/去重/授權） | 報名核心零改動（G5）；主辦登記由 event-service 於建立時完成，非改報名流程 |
| `src/domain/roster.ts` | 主辦名額結構同一般 self 列，roster 自然渲染第 1 位，無需改 |
| `RegistrationRepository`（全數原語） | 主辦登記複用既有 `insertSlot`/`countConfirmed`，不新增 registrations 原語 |
| `ux_events_active_group` / `ix_events_group_status` / registrations 索引 | 維持同群單場（G7）；本文件不動任何 index |
| `events.status` 狀態機（D-001 §7 / D-004 §5） | 計費不改狀態轉移；close/cancel 語意不變 |
| 候補 FIFO 遞補、代報名 `+N 名字`、soft-delete 稽核 | 全數不動 |

### 範圍內

- `events` 加 `price_mode`/`venue_fee`（migration 0002 + backfill + 一致性）。
- `billing.ts` 均攤（ceil、分母 max(,1)）與預估總額計算。
- 主辦人於 `確認` 建立時自動登記為第 1 正取（複用 insertSlot per-slot 原語）。
- `關閉報名` split 最終攤額公告（MVP 僅公告、不持久化）。
- list/開團公告/確認摘要/關閉回覆的費用列 mode-aware 與「暫估」標示。
- 一行式與逐步問答的計費語法（parser + create-flow 擴充）。
- 文案中性化（球聚→球敘、開球時間→時間、球場地點→場地）。

### 範圍外（future phase，明確不做）

- **付款/收款結算**（phase3；本文件僅顯示估算/最終攤額，不處理實際收款、找零、對帳）。
- **最低成行人數**（phase2）。
- **no-show 配套**（phase3）。
- **多項成本拆分**（不做；`split_venue` 為單一固定總額，不拆場地+餐費+…）。
- **多場並行**（future；建議「一檔多場次」，本文件不做；維持 `ux_events_active_group` 同群單場）。
- **球種/`sport_type` 欄位**（不加；文案中性化即可）。
- **split 找零/退差**（ceil 多收部分不處理，屬付款 phase）。
- **關閉後 reopen 重算攤額**（無 reopen 指令，D-004 已列範圍外）。

---

## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）

- **G1（均攤 ceil 且不除零）**：`split_venue` 每人金額**一律** `Math.ceil(venue_fee / Math.max(confirmedCount, 1))`；**不得**用四捨五入/無條件捨去，**不得**以未經 `max(,1)` 保底的正取數作分母（即使主辦自動登記已保證 ≥1，仍須保留 `max(,1)` 防禦）。（可 grep `Math.ceil` + 分母 `Math.max(`；AC-2/AC-6/AC-15）
- **G2（split 顯示標暫估、非已定金額）**：`split_venue` 於報名/名單/開團公告/確認摘要階段的每人金額**必須**標「（暫估，關閉報名後結算）」或等義字樣，**不得**呈現為已定案金額；最終金額**只在 `關閉報名` 時**公告。（可逐字檢查 formatter；AC-14）
- **G3（主辦自動登記走既有 per-slot 交易原語，不得繞過）**：主辦第 1 正取**必須**經 `RegistrationRepository.insertSlot`（於 `confirm` 交易內、`db.inTransaction===true`）產生，**不得**在 domain/formatter 裸下 `INSERT INTO registrations` SQL、不得繞過 seq 指派；產出列須 `seq=1`（空 event）、`kind='self'`、`status='confirmed'`、`cancelled_at=NULL`、`owner_user_id=host.id`。（AC-3、沿用 D-003 G10）
- **G4（模式與 venue_fee 一致性）**：`price_mode` 僅 `'per_person'`/`'split_venue'`（DB CHECK）；`EventRepository.create` **必須**強制：`per_person` → `venue_fee=NULL` 且 `price_per_person` 為每人金額（≥0）；`split_venue` → `venue_fee` 為整數且 `>0` 且 `price_per_person=0`。**不得**寫入不一致組合（如 split 但 venue_fee NULL、或 per_person 但 venue_fee 有值）。（AC-13）
- **G5（報名核心不得被改動）**：**不得**修改 `src/domain/registration-service.ts` 的 signup/cancel/遞補/授權/去重邏輯，**不得**改 `roster.ts` 分組後綴規則，**不得**改 `RegistrationRepository` 既有原語行為；主辦登記僅由 `event-service` 於建立時新增一步 insertSlot。（可 diff 這兩檔為零/近零改動；AC-16）
- **G6（禁 any；domain/formatter 不下 SQL、不觸 LINE）**：新增/改動的 `billing.ts`/formatter/create-flow/event-service **不得**使用 `any`、**不得**出現 SQL 字串或直接存取 `db`、**不得** import `@line/bot-sdk`；`PriceMode`、擴充後 `CreateEventDraft`/`CloseResult` 皆具名定型。（沿用 D-003 G10/G11、D-004 G5/G6；AC-16）
- **G7（同群單場不變）**：**不得**改動 `ux_events_active_group`、不得因計費擴充新增/放寬同群多場活動；migration 0002 **不得**觸碰任何既有 index 或 `status` CHECK。（AC-12）
- **G8（既有 per_person 行為零回歸）**：migration 0002 對既有列 backfill 一律 `price_mode='per_person'`/`venue_fee=NULL`；per_person 模式的每人費用列、預估總金額列、關閉回覆**必須與 D-003 §8 / D-004 §8 現行輸出等義**（除文案中性化 §7 外無語意變更）。（AC-1/AC-8）

---

## 三、Acceptance Checks（每條可轉測試；條件 → 預期 → 驗證方式；標記 `[D-005 AC-n]`）

- [ ] **[D-005 AC-1]（per_person 顯示回歸）**：`price_mode='per_person'`、`price_per_person=2200`、正取 3 → `名單` 費用列 `每人費用：2200 元`、預估總金額 `3 × 2200 = 6600 元`（與 D-003 §8(E) 等義，除標題中性化）。（驗證：unit test，list-formatter / G8）
- [ ] **[D-005 AC-2]（split ceil 估算）**：`split_venue`、`venue_fee=3000`、正取 7 → `perPersonAmount=ceil(3000/7)=429`；名單顯示 `場地費：3000 元，平均每人約 429 元（暫估，關閉報名後結算）`；預估總額顯示 `場地費 3000 元（固定，暫估）`。（驗證：unit test，billing + list-formatter / G1、G2）
- [ ] **[D-005 AC-3]（主辦自動登記為第 1 正取）**：白名單 host 走 `確認` 建立 open event → registrations 產生 1 列 `seq=1`、`kind='self'`、`status='confirmed'`、`owner_user_id=host.id`、`display_name=主辦快照名`、`cancelled_at=NULL`；名單第 1 位為主辦。（驗證：unit/整合 test，event-service.confirm + repo / G3）
- [ ] **[D-005 AC-4]（+N 後均攤重算）**：`split_venue venue_fee=3000`，主辦自動登記後正取=1（估 3000）；成員 `+3` → 正取=4 → `ceil(3000/4)=750`；名單費用列顯示每人約 750 元（暫估）。（驗證：unit/整合 test / G1）
- [ ] **[D-005 AC-5]（-N 後均攤重算）**：承上正取=4（每人 750），一成員 `-1` → 正取=3 → `ceil(3000/3)=1000`；名單重算為每人約 1000 元（暫估）。（驗證：unit/整合 test / G1）
- [ ] **[D-005 AC-6]（正取=1 僅主辦時均攤=venue_fee）**：`split_venue venue_fee=3000`、僅主辦自動登記（正取=1）→ `ceil(3000/1)=3000`；顯示每人約 3000 元（暫估）。（驗證：unit test / G1）
- [ ] **[D-005 AC-7]（關閉報名公告 + 持久化最終攤額，split）**：`split_venue venue_fee=3000`、正取 7，白名單 host `關閉報名` → **交易內 `events.settled_per_person` 寫入 429**、回覆含 `本場最終每人費用：429 元（場地費 3000 元 ÷ 正取 7 人，無條件進位）`；formatClosed 以持久化值顯示；per_person 模式 `settled_per_person` 維持 NULL。（驗證：unit/整合 test，closeEvent + repo + event-formatter / §4、OP-3、G2）
- [ ] **[D-005 AC-8]（關閉報名 per_person 維持原文案）**：`per_person price=2200`，`關閉報名` → 回覆維持 D-004 §8(E) 句型（中性化後 `「X」球敘已關閉報名，不再接受新報名。`），**不附最終攤額列**。（驗證：unit test / G8）
- [ ] **[D-005 AC-9]（一行式計費語法解析）**：`開團 2026/08/15 07:30 東方球場 16人 場地費3000元` → `create_event_oneline` 含 `priceMode='split_venue'`、`venueFee=3000`、`price=0`；`… 每人2200元` 與 `… 2200元` 皆 → `priceMode='per_person'`、`price=2200`。（驗證：unit test，parse + validateFee / §6.1）
- [ ] **[D-005 AC-10]（逐步問答計費方式分支）**：`開團`→…→`awaiting_price_mode` 提問；答「場地費」→ `awaiting_venue_fee`→輸入 `3000`→ payload `priceMode='split_venue'`/`venueFee=3000`→`awaiting_confirm`；答「每人」→ `awaiting_price`→`2200`→ per_person。（驗證：整合 test，create-flow 逐訊息推進 / §6.2）
- [ ] **[D-005 AC-11]（文案中性化）**：名單標題為 `[X 球敘]`（非「球聚」）；逐步問答提問為「請輸入時間」「請輸入場地」（非「開球時間」「球場地點」）；關閉/取消回覆為「球敘」。（驗證：unit test，formatter 逐字 / §7）
- [ ] **[D-005 AC-12]（migration 0002 backfill）**：對已含 per_person 活動的既有 DB 套用 0002 → 既有 events 列 `price_mode='per_person'`、`venue_fee=NULL`；`ux_events_active_group`/`ix_events_group_status`/status CHECK 不變；既有 open 活動報名行為零回歸。（驗證：整合 test，migrate + 既有列查詢 / G7、G8）
- [ ] **[D-005 AC-13]（split price_per_person 語意與一致性）**：`EventRepository.create({priceMode:'split_venue', venueFee:3000})` → 寫入列 `venue_fee=3000`、`price_per_person=0`；`create({priceMode:'per_person', pricePerPerson:2200})` → `venue_fee=NULL`、`price_per_person=2200`；寫入不一致組合（split 但 venue_fee 缺/≤0，或 per_person 帶 venue_fee）→ 邊界層拒絕。（驗證：unit test，event-repository / G4）
- [ ] **[D-005 AC-14]（split 標「暫估」不呈現已定金額）**：`split_venue` 於 signup/名單/開團公告/確認摘要的每人金額字樣**必含**「暫估」與「關閉報名後結算」（或摘要階段「開團後依報名人數均攤」）；不得出現無標示的「每人 M 元」定型句。（驗證：unit test，formatter 逐字 / G2）
- [ ] **[D-005 AC-15]（分母 max(,1) 不除零）**：`split_venue venue_fee=3000`、`confirmedCount=0`（防禦性極端，理論上主辦登記後不發生）→ `perPersonAmount=3000`（不 NaN/Infinity/throw）。（驗證：unit test，billing / G1）
- [ ] **[D-005 AC-16]（守則回歸：報名核心不動、禁 any、domain 不下 SQL/不觸 LINE）**：diff 顯示 `registration-service.ts`/`roster.ts` 邏輯零改動；`billing.ts`/formatter/create-flow/event-service 無 `any`、無 SQL 字串、無 `@line/bot-sdk` import；主辦登記經 `insertSlot`（非裸 SQL）。（驗證：靜態審查 / grep / diff，G3/G5/G6）
- [ ] **[D-005 AC-17]（新 state 無效答案重問，design-reviewer B1）**：`awaiting_price_mode` 輸入非「每人/場地費」（含裸數字 `2200`、其他字）→ 回無效重問範本、**停留 awaiting_price_mode、不前進、不猜測當金額**；`awaiting_venue_fee` 輸入非正整數 → 回重問、停留。皆單則、不迴圈。隨後輸入合法值正常前進。（驗證：unit test，create-flow / §6.2、G2/FR-5）
- [ ] **[D-005 AC-18]（格式提示涵蓋計費語法，design-reviewer B3）**：一行式格式錯（`create_bad_*`）→ 回 (K′)，內容**同時含**「每人固定：…2200元」與「場地費均攤：…場地費3000元」兩種寫法範例。（驗證：unit test，event-formatter / §7）
- [ ] **[D-005 AC-19]（開團公告不顯示每人估額，design-reviewer B2）**：`split_venue` 開團成立（正取=1）→ 公告費用列為 `費用：場地費 N 元，將依報名人數均攤（暫估，關閉報名後結算）`，**不含**「平均每人約 N 元」字樣；且明示主辦已佔第 1 正取。（驗證：unit test，event-formatter 逐字 / §5.1、G2、architect N4）

---

## 四、微 OP（附建議，交 Orchestrator 與使用者裁決）

> 只列真正未定、需使用者拍板者；backend 附建議但不自行定案。

- **OP-1（主辦自動登記後能否 `-1` 移除自己）**：主辦第 1 正取（seq=1、self）可否被主辦本人 `-1` 取消？
  - 建議：**可移除**（維持 per-slot 一致性、不對 registration-service 加特例）；靠 §2 `Math.max(confirmedCount,1)` 保底避免除零（正取歸 0 時 split 估算 = venue_fee）。代價：名單可能無人。備選：**主辦首槽保護**（`-N` 略過 seq=1 self 或拒絕），但需在 registration-service 加特例（觸及 G5「報名核心不動」），故**不建議**。請裁決。
- **OP-2（一行式計費關鍵字 + InvalidReason）**：split 前綴關鍵字用 `場地費` / `場地` / `均攤`？逐步問答同用該詞。且 venue_fee 格式錯的原因碼新增 `create_bad_venue_fee` 或複用 `create_bad_price`？
  - 建議：一行式與逐步皆用 **`場地費`**（語意最直白，`每人` 對稱）；per_person 前綴 `每人`（可省略）。原因碼**新增 `create_bad_venue_fee`**（精確提示「場地費需為正整數」）。請裁決關鍵字。
- **OP-3（關閉報名最終攤額是否持久化）**：`關閉報名` 的 split 最終攤額**僅公告當下計算**，還是**持久化**（加 `events.settled_per_person` 欄位）？
  - 建議：**MVP 僅公告**（closed 凍結正取數，事後等值重算；持久化屬 future 付款 phase）。若使用者要求持久化 → 另開 migration 0003 加 `settled_per_person INTEGER NULL`，close 交易內寫入。請裁決。
- **OP-4（venue_fee 一致性是否要 DB 層 CHECK）**：跨欄位一致性以**應用層強制**（MVP 建議，migration 輕量），還是 migration 0002 改 **table-rebuild** 加表級 CHECK（DB 兜底、較侵入）？此為 D-001 schema 擴充決策。
  - 建議：**MVP 應用層強制 + G4 + AC-13**；DB 層 CHECK 交 **architect（D-001 owner）裁決**是否值得 table-rebuild。請 architect 於審查表態。

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-07-31 | D-005 DRAFT 提交（backend） | 待 design-reviewer + architect-reviewer 雙審（R2）、OP-1~OP-4 待使用者/architect 裁決 |
| 2026-07-31 | OP-1 主辦可否 -1 移除自己 | **可移除**（使用者裁決；靠 max(正取,1) 保底，不對 registration-service 加特例、不動 G5）|
| 2026-07-31 | OP-2 計費關鍵字 | **`場地費`**（使用者裁決；一行式與逐步共用）；原因碼新增 `create_bad_venue_fee` |
| 2026-07-31 | OP-3 最終攤額持久化 | **存欄位**（使用者裁決）：migration 0002 加 `settled_per_person`，close(split) 同交易寫入；供未來付款 phase |
| 2026-07-31 | OP-4 venue_fee 一致性 DB CHECK | orchestrator 採 **MVP 應用層強制 + G4 + AC-13**；**DB 層 table-rebuild CHECK 交 architect-reviewer 審時裁定** |

> **OP-1~OP-4 定案（2026-07-31）**。設計正文已據 OP-3 調整（settled_per_person 併入 0002、close 寫入）。

### R2 雙審結果（2026-07-31）
| reviewer | 結論 | 處置 |
|---|---|---|
| architect-reviewer | **建議 APPROVED（條件式）**，零改碼 blocker | 三裁定全過：schema 核可、OP-4 接受應用層強制（不 rebuild）、主辦登記 DEFERRED 足夠。**條件 A-B1（文件層）**：需補 **D-001 G2 carve-out errata**（write-first 交易內盲插首列為 IMMEDIATE 要求的合理例外）——APPROVED 後由 orchestrator 派 architect 補寫。nit 全採納：N1 venue_fee 單欄 CHECK（已加 §1.2）、N2 專屬 updateSettledPerPerson（已改 §4）、N3 formatClosed 唯一真相來源（已改 §4/§5.1）、N4 公告明示主辦佔首位（已加 §5.1）。 |
| design-reviewer | **需修正（3 blocker）→ 已修正** | B1 新 state 無效重問範本（已補 §6.2 + AC-17）；B2 公告不顯示每人估額（已改 §5.1 + AC-19）；B3 (K′) 涵蓋計費語法（已補 §7 + AC-18）。nit 採納：結算補「多收不找零」（§4/AC-7）、body 標籤「地點→場地」統一（§7）、範例去高爾夫（§7）。 |

> **兩 blocker 群已於設計正文補齊。** 待使用者最終 APPROVED 即派 T-009 實作。
> **APPROVED 後 orchestrator 分派（errata 批次，不阻擋）**：①派 architect 補 D-001 errata（schema 三欄擴充 + G2 carve-out）②D-002/D-003/D-004 §8 文案由 D-005 §7 為新權威來源（各 owner 補一句指向 D-005 或 errata）。
> **LESSONS 待登記**：新增對話 state 須同時交付「提問+無效重問範本+AC」（第 2 次，checklist 候選）、D-001 G2「IMMEDIATE 無條件」措辭過寬（區分 read-decide-write vs write-first 盲插）、APPROVED 文件反覆 errata 的治理（第 3 次）。
