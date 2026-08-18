# D-010: 開團後加開名額（Add Capacity：`加開 N` 鎖內加開 + 立即遞補）

- 狀態：APPROVED（2026-08-17，使用者最終核可；R2 雙審 PASS、design blocker「球聚→球敘」已修）——解鎖 T-019 實作
- 撰寫者：backend-engineer
- 風險等級：**R2（高）**——直接改 `events.capacity`，觸碰 `registration-service` 超賣防護（CLAUDE.md §4.5 預設高風險模組）；capacity 變更須於 `FOR UPDATE` 鎖內。依 §5：雙 reviewer（design + architect）+ e2e + Guardrails ≥3。
- 關聯：Backlog H1（使用者 2026-08-05 裁決）／任務 T-019（實作，待 orchestrator 於 task-board 編號）／相依 **D-001**（events schema、狀態機、repo 原語）、**D-003**（FIFO 遞補、`promotionQuota` 語意、複用 T-015 鎖內重算路徑）、**D-004**（`canManageEvent`、event 狀態機）。

## 一、設計內容

### 0. 定位與範圍
開團者對**已開放報名**（`status='open'` ∧ 未過期）的活動**只加開、不縮減**名額。加開後於**同一鎖內**立即依 FIFO 遞補候補者。動機：現況無編輯指令，唯一 workaround「取消活動再開團」會產生全新一場、報名歸零、候補 FIFO 全毀。

### 範圍內
- 新指令 `加開 N`（語法待裁決 §討論-1）：授權者對 open 活動增加名額。
- 併發：於既有 `ImmediateRunner`（`src/db/tx.ts` `FOR UPDATE`）鎖內 `UPDATE events SET capacity=fresh.capacity+N`，**同一交易**內複用 D-003 遞補路徑（`promotionQuota = fresh.capacity(新) − countConfirmed()` → `pickWaitlistForPromotion` → `promoteByIds`），額度上界為新容量 ⇒ 不超賣。
- 授權 `canManageEvent`（`event.host_user_id` ∪ super-admin，同「關閉報名」，D-004/D-006）。
- 加開公告 + 遞補 @ 通知（複用 D-003 §4 mention 描述子）。

### 範圍外（明確不做）
- **縮減 capacity**（`confirmed→waitlist` 降級）、改時間/地點/費用（Backlog H1 裁決僅加開）。
- 對 `closed`/`done`/`cancelled`/`draft`（未物化）活動加開（一律拒絕）。
- 整批原子遞補（quota < 候補隊首批次時沿用 D-003 允許拆批，記 Backlog）。

### 1. 指令與解析（協調 D-002；handler dispatch 增列）
- 提案 `ParsedCommand` 新增 `{ type: 'add_capacity'; count: number }`；`count` 為正整數、`1 ≤ N ≤ MAX_COUNT`（沿用 §討論-3 上限）。`加開 0`/負數/非數字 → `unknown`（不回覆，防洗版）；`加開 <過大>` → `invalid(command:'add_capacity', reason:'count_out_of_range')`（政策同 signup：靜默）。**解析屬 D-002 parser 擴充，非契約回應結構變更；須回報 Orchestrator 與 api-contract-designer 協調，本文件不私改。**
- handler 分派：`add_capacity` → `registrationService.addCapacity(...)`；`switch` union 窮舉（`default: never`）。

### 2. domain 放置與流程（`src/domain/registration-service.ts` 新增 `addCapacity()`）
放於 registration-service：其已持有 `ImmediateRunner` 與 T-015 鎖內遞補重算路徑（`countConfirmed`/`pickWaitlistForPromotion`/`promoteByIds`），複用最省、避免另開交易競態。授權沿用 `canManageEvent` 規則——**實作應共用 event-service 既有謂詞（抽為共享 authz helper），避免 R2 授權邏輯重複**；此為架構考量，交 architect-reviewer（R2 雙審已強制）。

**交易外前置（early-return，不 mark、無 DB 變更，仿 close/cancel）**：
1. `event = findActiveByGroup(groupId)`；`undefined` 或非 `open`（draft/closed 不在 active 集或非 open）→ `no_open_event`。
2. `isExpired(event)` → `event_ended`（活動已結束）。
3. `!canManageEvent(event, executorLineUserId)`（唯讀 `getByLineUserId`，不 upsert）→ `not_authorized`。

**交易內（`runImmediate(event.id, repos => …)`，`FOR UPDATE` 鎖）**：
1. `markProcessed(messageId)` 為第一步；`false` → `duplicate`（原子回滾）。
2. `fresh = getById(event.id)`；`undefined` 或非 open 或 `isExpired` → `event_ended`（鎖內權威重讀，非 stale）。
3. `newCapacity = fresh.capacity + N`；`newCapacity > MAX_CAPACITY` → `over_limit`（§討論-3）。
4. `updateCapacity(event.id, newCapacity)`（**新 repo 原語**，client-bound `TxRepos.events`，見文末清單）。
5. **複用 T-015 遞補**：`promotionQuota = newCapacity − countConfirmed()`；`>0` → `pickWaitlistForPromotion(event.id, promotionQuota)` → `promoteByIds`；`promoted` 供 @ 通知。
6. 回 `{ kind:'ok', added:N, newCapacity, promoted, view }`。

### 3. 回覆文案（繁中；純文字 + mention 描述子）
- 成功（**單一則**，裁決 #2，2026-08-17）：`「{地點}」球敘已加開 {N} 個名額（上限 {newCapacity}）。`＋更新後名單摘要 + 剩餘名額；`promoted.length>0` 時**同一則內**追加 `恭喜由候補遞補為正取：@…`（複用 D-003 §4 mention）。（用語「球敘」沿用既有 formatter，不用「球聚」——design-reviewer blocker，2026-08-17）
- 拒絕：`not_authorized`→「只有開團的人（或系統管理員）可以加開名額。」；`no_open_event`→「目前沒有開放報名的活動」；`event_ended`→「活動已結束，無法加開名額」；`over_limit`→「加開後將超過人數上限（{MAX_CAPACITY}），無法加開」。

## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）
- **G1（只加不減）**：不得使 `capacity` 減少；`addCapacity` 一律 `newCapacity = fresh.capacity + N` 且 `N ≥ 1`；任何導致 `newCapacity ≤ fresh.capacity` 的請求須被拒（不 UPDATE）。
- **G2（鎖內改 capacity + 遞補）**：不得在 `runImmediate`（`FOR UPDATE`）交易外執行 `UPDATE events.capacity` 或遞補寫入；capacity 與遞補須於**同一交易**，`fresh.capacity`/`countConfirmed` 皆鎖內取值，不得用交易外快照。不得繞過 `src/db/tx.ts` runner 另開交易。
- **G3（僅 open 可加開）**：不得對非 `open`（draft/closed/cancelled/done）或已過期活動加開；交易內須以 `getById` 重讀 re-check，非 open/過期一律不 UPDATE、不遞補。
- **G4（授權）**：非 `canManageEvent`（`host_user_id` ∪ super-admin）者不得改 capacity、不得 mark、不得寫任何 users 列（唯讀 `getByLineUserId` 解析）。
- **G5（不超賣／守恆）**：遞補數不得超過 `promotionQuota = newCapacity − 鎖內有效正取數`；遞補一律 `pickWaitlistForPromotion`（最小 seq）→ `promoteByIds`，遞補後有效正取數 ≤ `newCapacity`。不得直接 `DELETE` registrations、不得自拼 SQL（domain 一律經 repo 原語，沿用 D-003 G6/G10）。

## 三、Acceptance Checks（每條可轉測試）
- [ ] **[D-010 AC-1]（加開後容量增加）**：open 活動 capacity=16、confirmed=16、waitlist=[w1,w2]，host `加開 3` → capacity=19、w1/w2 遞補為 confirmed（共 18）、剩餘 1；回覆含加開公告 + 2 人遞補通知。（unit + e2e）
- [ ] **[D-010 AC-2]（立即遞補正確數量）**：capacity=10、confirmed=10、waitlist 5 人，`加開 2` → 恰遞補最小 seq 之 2 人為 confirmed（12/12）、餘 3 候補；`promotionQuota` 上界為新容量。（unit）
- [ ] **[D-010 AC-3]（鎖內原子不超賣）**：兩則不同 messageId 的 `加開 1` 對同 event 真並行 → 序列化後 capacity 增 2、有效正取數 ≤ 最終 capacity，無兩列越界 confirmed。（PG 真並行整合測試）
- [ ] **[D-010 AC-4]（僅 open 可加開）**：`closed`/`cancelled`/過期 open/無活動 分別 `加開 2` → 各回對應拒絕文案（no_open_event/event_ended）、capacity 不變、無遞補。（unit）
- [ ] **[D-010 AC-5]（授權）**：非 host 且非 super-admin 成員 `加開 2` → `not_authorized`、capacity 不變、無 DB 變更（含 users 無新列）；host 與 super-admin 皆可加開。（unit）
- [ ] **[D-010 AC-6]（只加不減）**：`加開 0`/`加開 -1` → `unknown` 不回覆、capacity 不變；正常 `加開 N` 後 capacity 嚴格增加，任何路徑不產生 `capacity` 減少或 confirmed→waitlist 降級。（unit）
- [ ] **[D-010 AC-7]（指令解析/邊界/上限）**：`加開 3`／全形『加開　３』／`加開 20`(MAX_COUNT) → `add_capacity{count}`；`加開 21` → `invalid(count_out_of_range)` 靜默；`加開`(無參數) → `unknown`；`加開 N` 使 `newCapacity > MAX_CAPACITY` → `over_limit` 拒絕文案。（unit）
- [ ] **[D-010 AC-8]（冪等去重）**：同 `message_id` 的 `加開 2` 連續兩次 → 第二次交易內 `markProcessed` 回 false 中止 → capacity 只增一次、只回覆一次。（unit/整合）

### 需新增的 repository 方法（供 T-019 於 D-001 資料層補上）
- `EventRepository.updateCapacity(id: number, capacity: number): Promise<number>`（client-bound `TxRepos.events` 寫方法；`UPDATE events SET capacity=$1, updated_at=$2 WHERE id=$3`，回受影響列數）。屬資料層原語，本文件僅提需求與簽名。

## 討論紀錄（Orchestrator 維護，待使用者裁決）
| # | 議題 | backend 建議預設 | 使用者裁決 |
|---|---|---|---|
| 1 | 指令語法 + N 語意（新增量 vs 新總量） | `加開 N`，N=新增量 | **裁決：`加開 N`，N=新增量**（與 `+N` 加法一致）。 |
| 2 | 加開公告與遞補通知：同一則 vs 兩則 | 兩則 | **裁決：單一則**（加開公告 + 遞補 @ 同一則）。 |
| 3 | capacity 上限值 | 沿用 `MAX_CAPACITY=1000`，套用於新總量 | **裁決：採建議**（MAX_CAPACITY=1000 套新總量；如需調整再議）。 |
| 4 | 僅 open 可加開之確認 + 各拒絕狀態文案 | 見 §3 拒絕文案 | **裁決：採建議**（僅 open 可加開 + §3 拒絕文案）。 |
