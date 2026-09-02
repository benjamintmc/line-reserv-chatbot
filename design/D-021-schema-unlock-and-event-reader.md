# D-021: Schema 解鎖與 `EventReader` 讀取路徑（0006 migration + service 佈線）

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §1／§2／§5.1 **逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——資料 migration + `src/domain/event-service.ts`／`registration-service.ts`（CLAUDE.md §4.5 高風險模組）。
- 來源：D-020 §1／§2／§5.1；內文所有 `§x` 皆指 **D-020 的舊章節編號**（逐字保留，轉址表見 umbrella `D-020`）。同屬 T-033a 的並行文件：D-022、D-023、D-024、D-026。

## errata（2026-09-02，來源 T-033a R2 雙審 architect-reviewer N3；**事實更正，本節生效**）

> **§5.1「`closeEvent`／`cancelEvent` 的雙層授權模式」中「交易內權威重讀（`FOR UPDATE` 再讀一次）」
> 的敘述與程式碼不符。** 經 orchestrator 查證：`EventService` 的 `this.tx` 是 `tx.ts:44-48` 的
> `TransactionRunner`，其 doc 明寫「**不鎖 event**」、走純 `BEGIN`；真正帶
> `SELECT ... FOR UPDATE` 的 `createImmediateRunner`（`tx.ts:92-102`）**只有 `editEvent` 在用**
> （`event-service.ts:698`）。故 `closeEvent`／`cancelEvent` 的交易內重讀**無列鎖**。
>
> **這是 0006 之前就存在的既有狀態**（原 `findActiveByGroup` 同樣在無鎖交易內），T-033a 未引入
> 任何行為回歸；本 errata 只更正文字，**不要求改碼**。
>
> 1. §5.1 該句更正為：「交易外 early-return 授權檢查 + **交易內權威重讀（`getById`，走
>    `TransactionRunner`，無列鎖）**」。
> 2. 「兩次查詢都保留、不得合併」的要求**不變**——兩層各自的鎖前/鎖內重讀語意仍有意義
>    （交易內重讀可看到同交易前段的寫入、並縮短 TOCTOU 窗口），只是**不得**再宣稱有 `FOR UPDATE`
>    等級的併發保證。
> 3. 連帶：`event-service.ts` 中沿用此措辭的註解須一併更正（歸 backend-engineer）。
>
> **本節由 orchestrator 落筆，尚未經 architect 確認。**

## errata E2（2026-09-02，T-033c 動工時執行；**排程內移除，非設計變更**）

> **§2 的「T-033a 開團側過渡條文」與 G1 的「唯一例外」已整段移除。** 該條文自訂的失效條件為
> 「T-033c 落地 §3（D-027）時必須整段移除」，本次即為該時點，故非 APPROVED 設計變更，
> 不走變更流程。連帶更正兩處指涉（§2 升冪依據、AC-2 斷言理由）。
>
> **驗收（沿用原條文第 3 點）**：`grep -n "at(-1)\|length - 1" src/domain/event-service.ts` 應無命中。

## 一、設計內容

### 1. Schema 變更（migration `0006_multi_event_per_group.sql`）

`0001~0005` 為既有／凍結區，只新增不改寫。

```sql
SET LOCAL lock_timeout = '3s';  -- events 為熱表，ALTER/INDEX 需 ACCESS EXCLUSIVE，比照 D-013 防守

-- (1) 解除「同群至多一場 active」：drop 舊單欄索引。
DROP INDEX ux_events_active_group;

-- (2) 新安全網：同群 active 集合內，場地+時間不得重複（decision #9 查重防護的 DB 層）。
--     以 (group_id, location, event_datetime) 唯一，取代原 (group_id) 唯一。
CREATE UNIQUE INDEX ux_events_active_group_venue_time ON events (group_id, location, event_datetime)
  WHERE status IN ('draft', 'open');

-- (3) 機制 A：bot 訊息 → 活動 映射表。
CREATE TABLE message_event_map (
  message_id  TEXT PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_message_event_map_event ON message_event_map (event_id);
```

- 索引改名（非沿用 `ux_events_active_group`）：舊名語意是「同群同時只能一場」，新名語意是
  「同群同時不能有兩場場地+時間相同」，語意不同不得共用名字（否則窄捕捉 catch 邏輯會誤判，G8）。
  **同群 open 數上限（§3.5）不在此新增任何索引/約束**——理由見 §3.5，屬應用層計數判斷。
- `message_event_map` 不設 `ON DELETE CASCADE`——events 從不物理刪除（狀態機終態即可，D-004 G6/G10），
  無需處理刪除連動。`ix_message_event_map_event` 供 Backlog 的「每週清除已結束活動關聯資料」日後使用
  （本輪不實作清除排程，見 §6）。**刻意不存 `group_id`**——B1 修復（見 §4.1／§4.3／G14）已論證
  跨群校驗改在讀取時以 `events.getById` 比對即可，不需要在寫入時多存一個冗餘欄位。
- 風險評估（比照 D-013）：`events` 為熱表但索引變更是**新增/替換索引**，不鎖資料列本身的讀寫路徑
  太久（`lock_timeout` 兜底、逾時即整檔 ROLLBACK、重跑即可）；`message_event_map` 是純新增表，
  零風險。

### 2. `EventReader` 介面變更

```ts
export interface EventReader {
  getById(id: number): Promise<EventRow | undefined>;
  /** 取代 findActiveByGroup：回該群 status ∈ {draft,open} 的「全部」列（依 id 升冪）。 */
  listActiveByGroup(groupId: string): Promise<EventRow[]>;
  findLatestDisplayable(groupId: string): Promise<EventRow | undefined>; // 不變（D-008）
}
```

`listActiveByGroup` 的 SQL **必須**為 `... WHERE group_id = $1 AND status = ANY($2) ORDER BY id ASC`（**不得**沿用現況 `findActiveByGroup` 的 `ORDER BY id DESC`）。升冪為本介面的排序契約（由 AC-2 斷言鎖定），呼叫端不得倚賴其他排序。

**`findActiveByGroup` 整個移除**（不保留 wrapper、不留 deprecated 別名，G1）：它「回傳單一列」的
介面形狀本身就是「同群只有一場」假設的化身，留著就會被日後新代碼誤用而悄悄退回單場語意。
所有原呼叫點改寫為：`listActiveByGroup(groupId)` 取得候選集合 → 消歧義（§4）解出 `eventId` →
`getById(eventId)` 做鎖內權威重讀（既有模式，`getById` 不必新增)。

#### 5.1 通用模式

`EventReader.findActiveByGroup(groupId)` 的每個原呼叫點，改為：**handler 層先解出 `eventId?`
（見 §5.2），再把 `eventId` 放進各 service 的 Input，service 內以 `events.getById(eventId)` 取代
`events.findActiveByGroup(groupId)`**。`eventId === undefined` 語意 = 消歧義判定「候選數為 0」，
service 內沿用各自原本「查無 active」的既有分支（`no_open_event`/`no_active` 等），**行為零改變**。

**跨群防線只設一處（B1 修復，避免文件前後矛盾）**：§4.1／§5.2 已在 dispatch 層對 quote 解出的
`eventId` 做過 `group_id` 校驗（不符即視為未引言），故此處『service 內以 `events.getById(eventId)`
取代 `findActiveByGroup(groupId)`』**不需要再重複比對 `group_id`**——`getById` 單純信任 dispatch
層傳入的 `eventId` 已經過群組範圍過濾（見 G14）。`@selector` 路徑本就安全：`matchSelector` 只在
`listActiveByGroup(groupId)` 回傳的候選集合內比對，天然被 group 限定，不需要額外檢查。

**`closeEvent`／`cancelEvent` 的雙層授權模式維持不變**：現行「交易外 early-return 授權檢查（讀一次
`event` 判 `canManageEvent`）+ 交易內權威重讀（`FOR UPDATE` 再讀一次）」雙層模式
（`src/domain/event-service.ts:563,572,603,612`）**兩次查詢都保留**，只是查詢方式從
`findActiveByGroup(groupId)` 換成 `getById(eventId)`（`eventId` 由消歧義解出）——**不得**因為改成
`getById` 就合併成一次查詢，兩層各自的鎖前/鎖內重讀語意（TOCTOU 防護）不變。

受影響的 Input 型別（新增欄位，其餘既有欄位不變）：

| Input | 新欄位 | 备注 |
|---|---|---|
| `SignupInput` / `CancelInput` | `eventId?: number` | `findOpenEventForSignup` 改吃 `eventId` |
| `ListInput` | `eventId?: number` | `undefined` 時沿用既有 `findLatestDisplayable` 回退（見 §5.4，**不可**與其他 Input 統一處理） |
| `AddCapacityInput` | `eventId?: number` | |
| `LifecycleInput`（close/cancel） | `eventId?: number` | |
| `EditEventInput` | `eventId?: number` | `undefined` 時沿用既有 `findLatestDisplayable` 回退（editEvent 原邏輯本就只在 0 候選時查 closed，不受 §5.4 那個 bug 影響，見附註） |
| `BalancedInput` / `StartRoundsInput` | `eventId?: number` | |

`NextRoundInput`（`下一輪`）**不變**——decision #9 判斷順序清單未列 `下一輪`；它由既有
`conversation_states` 的 grouping session 鎖定活動，session 本身即是消歧義結果，不需重跑（G11）。

## 二、Guardrails（Must NOT）

- **G1（無單值介面殘留）**：`EventReader` 不得保留 `findActiveByGroup` 或任何「回傳單一活動」
  當作預設路徑的方法；所有原呼叫點改用 `listActiveByGroup` + 明確消歧義/查重邏輯，不得以
  wrapper（如 `listActiveByGroup(groupId)[0]`）掩蓋、變相恢復單場假設。**本 Guardrail 現無任何例外**
  ——T-033a~b 期間曾明列的三處內聯 `actives.at(-1)`（`startCreation`／`handleOneline`／`confirm`）
  已隨 T-033c 落地 D-027／D-028 整段移除，見 errata E2。
- **G8（窄捕捉限定新索引名）**：`confirm()` 的窄捕捉判斷式必須比對**新**約束名
  `ux_events_active_group_venue_time`；不得用「任何 `23505` 皆視為重複活動」的寬鬆判斷
  （會誤吞其他未來新增的唯一索引違反，掩蓋真正的錯誤）。
- **G10（不動 conversation_states）**：本設計不得修改 `conversation_states` 的 PK、攔截邏輯或
  開團問答/分組 session 的互斥語意（D-013 既有）；本設計與 D-013 為正交關注點。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-021 AC-1] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-1]` 會對不上）。

> **〔切檔複審新增，2026-09-02 R2 複審 B3〕AC-5 已改隸 D-027（T-033c）**：AC-5 逐字要求回
> `duplicate_event`，而該 result kind 屬 §3（D-027）；依上方過渡條文，T-033a 期間該路徑仍回
> `already_active`。T-033a 對 G8（窄捕捉改比對新索引名）的驗收，由既有 `[D-004 AC-12]` 兩處測試涵蓋
> （須依 umbrella errata 同步改為新索引名），完整的並發 race 驗收隨 AC-5 於 T-033c 進行。

- [ ] **[D-021 AC-1]（migration 結構）**：套用 0006 後，`ux_events_active_group` 不存在；
  `ux_events_active_group_venue_time` 存在且 `pg_get_indexdef` 顯示 predicate 為
  `status IN ('draft','open')`、欄位為 `(group_id, location, event_datetime)`；`message_event_map`
  表存在且 `message_id` 為 PK、`event_id` 有 FK 指向 `events(id)`、`ix_message_event_map_event` 存在。
- [ ] **[D-021 AC-2]（同群多場並存）**：同群連續開兩場「場地或時間不同」的活動皆成功
  （`status='open'` 各一列並存）；`listActiveByGroup` 回傳兩列；且兩列依 id 升冪排列
  （`rows[0].id < rows[1].id`），本斷言鎖定 §2 的排序契約。**驗證層級：repository 層**
  （連續 `events.create` 兩列），非 `開團` 流程——依 D-020 不變式 #1，T-033a 開團側仍拒第二場。
