# D-008: 單場名額自動釋放（closed／過期條件釋放 + event_datetime 合併）

狀態：DRAFT

- 撰寫者：architect
- 風險等級：R2（高）——資料 migration（合併 `event_date`+`event_time` → `event_datetime`）+ `ux_events_active_group` 唯一約束變更 + 狀態機/併發相鄰。依 CLAUDE.md §5：強制 design-reviewer + architect-reviewer 雙審 + e2e，Guardrails ≥ 3（本文件列 5 條）。
- 實作目標環境：T-012（PG 移植，D-007 APPROVED）落地**之後**的 PostgreSQL 版（不併入 T-012；migration 於 T-014 實作階段才寫）。時間欄採 TEXT ISO UTC（D-007 OP-4，不用 timestamptz）、防超賣 `FOR UPDATE`（D-007 §3 路線 A）、serverless 無 cron（D-007 §4）、int4 IDENTITY（D-007 §6 B2）。本文件判定式與這些前提自洽。
- 關聯：Brief 決策 #8 / FR-6 §35·§93–97、資料模型 events §54、指令表 §68–69 ・ 任務 T-013/T-014（待建） ・ 設計 D-008
- 相依（先讀後寫，皆 APPROVED，本文件**只組合、不私改**）：
  - D-001（資料模型）：§2 `events` schema、§7 狀態機、`ux_events_active_group`、`ACTIVE_EVENT_STATUSES`、§0 型別對映、G11（時間 UTC ISO）、「draft 不物化」澄清註記。
  - D-004（開團流程）：`confirm` 建立 open、`runInTransaction`（DEFERRED，開團生命週期）、`關閉報名`/`取消活動`、窄捕捉 `already_active`、入口 `findActiveByGroup` fail-fast。
  - D-007（PG 移植）：§3 `FOR UPDATE`/路線 A、§4 serverless、§6 方言/int4、OP-4 TEXT ISO；本文件與 D-007「無 0003」相衝突處以本文件 §7 為準（D-008 新增 0003，post-T-012），列入 errata。
  - 現行程式：`src/db/schema.ts`、`src/domain/event-service.ts`、`src/domain/registration-service.ts`、`src/domain/create-flow.ts`、`src/domain/event-formatter.ts`、`src/domain/list-formatter.ts`、`src/db/repositories/event-repository.ts`、`src/db/time.ts`、`src/db/migrations/0001_init.sql`、`0002_billing_modes.sql`。

> 本文件是設計文件、**不寫實作程式碼**。文中少量 SQL / TS 片段僅用於說明「約束語意 / 介面形狀」，非交付碼。
> 7 個 OP 皆已定案（見 §四），設計正文（§on-read、§migration、§formatter、Guardrails、AC）與定案自洽。

---

## 一、設計內容

### 0. 定位與判定式（權威）

Brief 決策 #8／FR-6 把同群單場「唯一進行中活動」限制由**手動釋放**（必先 `取消活動`）改為**條件自動釋放**。使用者拍板三點：

1. **`關閉報名`（status `closed`）即釋放**——closed 不再擋新開團（但名單仍可查，標「報名已截止」，OP-4 定案）。
2. **合併 `event_date`+`event_time` → 單一 `event_datetime`**（UTC ISO-8601），判定式：
   - 一場活動**仍擋新團** ⟺ `status IN ('draft','open') AND event_datetime >= NOW()`；
   - 等價「釋放」⟺ `NOW() > event_datetime OR status IN ('closed','cancelled','done')`。
   - 使用者明確選「**超過開始時間即過期**」（strict：`NOW() > event_datetime`；**非**當天結束寬限）。
3. **過期／結束活動於名單顯示「活動已結束」（logical status `done`）**（OP-3 定案）。

**單一判定原語（domain 純函式，全讀取點共用）**：因 `event_datetime` 與 `nowIso()` 皆為同格式 UTC ISO-8601（`YYYY-MM-DDTHH:MM:SSZ`，固定 20 字元），**字典序 == 時序**（同 D-001 G11 對 `created_at` FIFO 的既有不變式），故過期判定可純字串比較：

```ts
// 說明用；nowIso() 見 src/db/time.ts（UTC 秒精度 ...Z）
function isExpired(event: EventRow, now: string /* = nowIso() */): boolean {
  return now > event.event_datetime;          // NOW() > event_datetime
}
function isOpenForSignup(event: EventRow, now: string): boolean {
  return event.status === 'open' && event.event_datetime >= now; // 未過期的 open
}
```

- **draft 於 MVP 不物化**（D-001 §2/§4/§7 澄清註記，OP-5 定案：無需特別處理）→ `{draft,open}` 實務等同 `{open}`；draft 保留於索引僅為向前相容（不會過期，因無 draft 列）。下文以 `{draft,open}` 表示索引 active 集合、以「open」代稱實務唯一可能的 active 列。

### 1. 核心難點：唯一索引無法引用 NOW() → 拆兩半處理

`ux_events_active_group` 是 **partial unique index**，其 `WHERE` predicate **不能**含 `event_datetime >= NOW()`——`NOW()` 非 immutable，PG 不允許用於 index predicate（且即使允許，索引也無法隨時間自動「放行」過期列）。因此把「兩種釋放條件」拆開處理：

#### 1a. closed 釋放 —— 由索引定義移除 `closed`（靜態、無需寫入）

migration 0003 **重定義** `ux_events_active_group` 的 active 集合，將 `closed` **移出**：

```sql
-- 舊：WHERE status IN ('draft','open','closed')
-- 新：WHERE status IN ('draft','open')
```

同步把 `ACTIVE_EVENT_STATUSES`（`src/db/schema.ts`）改為 `['draft','open']`（驅動索引 + `findActiveByGroup` 的**阻擋/生命週期**查詢與型別）。closed 事件**自然不再落入索引** → 不擋新團、**無需任何額外寫入**即釋放（釋放條件 (a) 落地為純 schema 變更）。
（注意：closed 事件雖釋放**擋團**，但名單仍可查——用**另一組**顯示查詢集，見 §2、§4。）

#### 1b. 過期 open 釋放 —— 惰性 flip（於 `開團` 交易內、insert 前）

索引仍視 `open` 為 active（無法用 NOW() 排除過期列），故**過期的 open 仍會佔索引槽**。以**惰性 on-read + 寫入語境 flip** 釋放：於 `開團`→`確認` 的 `runInTransaction`（D-004 §4，DEFERRED）內、**insert 新 open 之前**：

```
runInTransaction:
  markProcessed(messageId) 為第一步（G4 去重，D-004 不變）
  active = events.findActiveByGroup(groupId)      // 交易內權威重讀（現只回 {draft,open}）
  if active !== undefined:
      if !isExpired(active, now):  return { already_active }        // 未過期 open → 仍擋團
      else:                        events.updateStatus(active.id, 'done')   // 過期 open → flip done（釋放索引槽）
  host = users.upsert(...)
  event = events.create({ ..., status:'open' })   // done 已離開索引 → INSERT 不撞約束
  registrations.insertSlot(主辦首列)              // D-005 §3 不變
  conversations.delete(...)
  return { created, event }
```

- flip（`UPDATE status='done'`）與新 open 的 INSERT 在**同一交易**內原子完成 → 中途無「零 active」或「雙 active」窗口。
- `done ∉ {draft,open}` → flip 後索引槽空出，同交易的 INSERT open 直接通過。
- **入口早退（`startCreation`/`handleOneline`）**：僅把 D-004 現行 `if (active !== undefined) return already_active` 放寬為 `if (active !== undefined && !isExpired(active, now)) return already_active`；過期 open 於入口**放行**（不 flip、不建立 event，僅寫 conversation / 回摘要），實際 flip 延到 `確認` 交易（唯一需要原子釋放索引槽的寫入點）。

### 2. on-read 判定：三個取用語意（報名用 / 顯示用 / 阻擋生命週期用）

決策 #8 + OP-4 後，「同群的當前活動」有**三種讀取語意**，不得共用一個 accessor：

| 用途 | accessor（domain） | 底層查詢集 | 行為 |
|---|---|---|---|
| **阻擋/生命週期**（`開團` 入口/`確認` 重讀、`關閉報名`、`取消活動`） | `events.findActiveByGroup` | `ACTIVE_EVENT_STATUSES = {draft,open}` | 回過期或未過期 open（**不回 closed**）；由 `isExpired` 決定擋團/flip（§1b、§5） |
| **報名用**（`+N`/`-N`） | `findOpenEventForSignup` | `findActiveByGroup`（{draft,open}） | 要求 `isOpenForSignup`（open ∧ 未過期）；否則 `undefined`：過期 open → **拒絕**回 `event_ended`（OP-2 文案）；closed/無 → 現行 `no_open_event` |
| **顯示用**（`名單`） | `findEventForDisplay` | `DISPLAYABLE_EVENT_STATUSES = {draft,open,closed}`，latest by id（新 repo 原語 `findLatestDisplayable`） | 回**最新一場**未取消/未被取代之活動，交 formatter；domain 帶 `phase` 分類（見下） |

**顯示分類 `phase`（domain 依 `isExpired`/`status` 判定後傳 formatter；formatter 純函式不持時鐘）**：

- `live`：`open ∧ 未過期` → 正常名單（報名方式 + 剩餘名額，現行 D-003/D-005 表現）。
- `ended`：`open ∧ 已過期` → 標「**活動已結束**」（OP-3）+ 最終名單 + 結算（+ `split_venue` 最終攤額）；不顯示報名方式。
- `closed`：`status='closed'` → 標「**報名已截止**」（OP-4）+ 最終名單 + 結算；不顯示報名方式。
- 無（latest 為 `cancelled`/無活動，或 `findLatestDisplayable` 回 `undefined`）→ `no_open_event`（「目前沒有開放報名的活動」）。

**為何顯示用另設查詢集（OP-4 定案的實質變更）**：closed 已釋放**擋團**（不在 `{draft,open}`），但名單仍需可查（closed = 報名截止、球敘照常）。故顯示用查詢 `{draft,open,closed}` 取 latest-by-id：
- closed 與新 open 可並存（closed 已釋放）→ latest-by-id 取到**較新**者（新 open live），符合「當前活動」直覺；
- 僅有 closed（未開新團）→ 取到 closed → 標「報名已截止」+ 名單；
- **物理 `done` 不納入顯示集**：`done` 僅由 §1b flip 產生，而 flip 必同交易插入**更新的 open** → 該 done 永遠被更新列取代、非 latest；「活動已結束」一律由**過期 open**（status 仍 `open`）承載，非物理 done。故顯示集 `{draft,open,closed}` 不含 done 亦不遺漏 ended 場。

### 3. `event_datetime` 合併 + 時區轉換

- **儲存**：`event_datetime` 存 **UTC ISO-8601**（`YYYY-MM-DDTHH:MM:SSZ`，秒精度；輸入 `HH:MM` → 秒段 `00`）。與 G11 一致；跨 DB 一致（TEXT ISO，D-007 OP-4）。
- **輸入**：使用者輸入為**台灣本地**（Asia/Taipei，UTC+8，**無 DST**）日期 `YYYY-MM-DD` + 時間 `HH:MM`。開團問答**仍可分別問日期/時間**（`create-flow` 不變，payload 續存本地 `date`/`time` 字串）；**合併 + 轉 UTC 於 `確認` 建立時**（`event-service.confirm` 呼叫 `events.create` 前）發生，`create-flow`/一行式解析（D-002）皆不需改。
- **顯示**：formatter 由 `event.event_datetime`（UTC）**轉回台灣本地** `YYYY-MM-DD HH:MM` 顯示（`formatOpenAnnouncement`、`list-formatter.eventHeader`、`formatAlreadyActiveEntry` 等）。因輸入為本地、顯示轉回本地 → **顯示字面值與 D-004/D-005 現行一致**（既有訊息斷言值多數不變，僅欄位來源改變）。
- **轉換原語（純函式，新模組 `src/domain/datetime.ts` 或擴充 `src/db/time.ts`）**：Asia/Taipei 無 DST → 採**固定 +8 偏移**算術（OP-6 定案），免時區函式庫、確定性、可純測：

```ts
// 說明用；固定 UTC+8（台灣無 DST）
function taipeiToUtcIso(date: string /* 'YYYY-MM-DD' */, time: string /* 'HH:MM' */): string;
// 台灣本地 wall time → 減 8h → UTC ISO 'YYYY-MM-DDTHH:MM:00Z'
function utcIsoToTaipei(iso: string): { date: string; time: string };
// UTC ISO → 加 8h → 台灣本地 { 'YYYY-MM-DD', 'HH:MM' }
```

- 與既有 `nowIso()` 的關係：`nowIso()`（UTC 秒精度）續作「當下 UTC」來源供 `isExpired` 字串比較；`taipeiToUtcIso`/`utcIsoToTaipei` 為新增的**本地↔UTC** 轉換，不改 `nowIso()`。
- **邊界正確性**：台灣 `2026-08-15 07:30` → `2026-08-14T23:30:00Z`（跨 UTC 日界）；台灣 `2026-08-15 00:30` → `2026-08-14T16:30:00Z`。過期判定於 UTC 空間進行，跨台灣午夜/UTC 邊界皆正確（AC-7）。

### 4. schema.ts / 型別變更與影響面

| 變更 | 內容 | 影響面 |
|---|---|---|
| `EventRow` | **移除** `event_date`、`event_time`；**新增** `event_datetime: string` | `event-repository`（`create`/`RETURNING *`）、`list-formatter.eventHeader`、`event-formatter`（D/I/B 之 event 顯示改衍生自 `event_datetime`）、既有測試對 `event.event_date` 的存取 |
| `ACTIVE_EVENT_STATUSES` | `['draft','open','closed']` → **`['draft','open']`** | `ux_events_active_group`（§7 同步重定義）、`findActiveByGroup`（阻擋/生命週期，不再回 closed）、D-004 close/cancel 對 closed 之行為（見 §五 errata） |
| `DISPLAYABLE_EVENT_STATUSES` | **新增** `['draft','open','closed']`（顯示用查詢集） | 新 repo 原語 `EventReader.findLatestDisplayable`；`registration-service.findEventForDisplay` |
| `CreateEventInput`（`event-repository`） | `eventDate`/`eventTime` → **`eventDatetime`** | `event-service.confirm` 改傳合併後 UTC 值 |
| `EventStatus` | 不變（仍含 `done`）；MVP **開始物化 `done`**（過期 open flip，僅內部釋放槽用，不顯示） | D-004 原「done 非本文件範圍」由本文件補齊物化路徑 |

- `create-flow.CreateEventDraft` 的 `date`/`time`（台灣本地字串）**維持不變**（payload 續存本地值）；`formatConfirmSummary`（確認摘要 B）仍以 `draft.date`/`draft.time` 顯示，**不改**。
- 型別對映（D-001 §0）新增 `event_datetime`（語意：UTC ISO TEXT，同 `created_at`）；移除 `event_date`/`event_time`（原「顯示文字」列）——列入 D-001 errata（§五）。

### 5. 模組劃分（改哪些檔；post-T-012 PG 版）

| 檔案 | 類型 | 變更摘要 |
|---|---|---|
| `src/db/migrations/0003_merge_event_datetime.sql` | ➕ 新增（獨立 0003，OP-1 定案） | 加 `event_datetime` + backfill + NOT NULL + drop 舊兩欄 + 重定義 `ux_events_active_group`（§7）；**不動 0001/0002** |
| `src/db/schema.ts` | 🔧 改 | `EventRow`（event_datetime）、`ACTIVE_EVENT_STATUSES`（移除 closed）、新增 `DISPLAYABLE_EVENT_STATUSES`（§4） |
| `src/domain/datetime.ts` | ➕ 新增（純函式） | `taipeiToUtcIso`/`utcIsoToTaipei`（固定 +8，§3）；不觸 DB/LINE、嚴禁 any |
| `src/db/repositories/event-repository.ts` | 🔧 改 | `CreateEventInput.eventDatetime`；INSERT 欄位 `event_date/event_time` → `event_datetime`；`findActiveByGroup` 隨 `ACTIVE_EVENT_STATUSES` 變更（不再回 closed）；**新增** 唯讀原語 `findLatestDisplayable(groupId)`（`status = ANY(DISPLAYABLE_EVENT_STATUSES) ORDER BY id DESC LIMIT 1`）於 `EventReader` |
| `src/domain/event-service.ts` | 🔧 改 | 入口早退加 `!isExpired`；`confirm` 交易內過期 open → `updateStatus('done')` flip（§1b）；`confirm` 建立前 `taipeiToUtcIso` 合併；close/cancel 遇過期 open → `no_active`（OP-7 定案，不 flip） |
| `src/domain/registration-service.ts` | 🔧 改 | `findOpenEvent` 拆為 `findOpenEventForSignup`（+過期排除）/ `findEventForDisplay`（用 `findLatestDisplayable`，含 closed/過期，回 `phase`）；signup/cancel 新增 `event_ended` 結果；`runImmediate` **交易內 re-check** status/過期（§6）；`getListView` 帶 `phase`（live/closed/ended） |
| `src/domain/event-formatter.ts` | 🔧 改（純函式） | D/I 的 event 日期顯示改 `utcIsoToTaipei(event.event_datetime)`；（B 摘要不改，用 draft 本地值） |
| `src/domain/list-formatter.ts` | 🔧 改（純函式） | `eventHeader` 日期顯示改 `utcIsoToTaipei`；新增「已釋放但可顯示」名單變體：`closed`→「報名已截止」、`ended`→「活動已結束」（§8） |
| `src/webhook/handler.ts` | 🔧 改 | signup/cancel 的 `event_ended` → formatter 拒絕文案；名單 `phase` → 對應 live/closed/ended 顯示 |

> 分層不變（D-003/D-004 慣例）：domain 判定過期/phase（持 `nowIso()`）、formatter 純函式收 `phase` 與布林旗標。

### 6. 併發分析（R2 核心）

**目標**：`ux_events_active_group`（partial unique on `{draft,open}`）仍是「同群單一 active」的**最終保證**；過期 open 的釋放（flip done + 新 open insert）必**原子**；與 signup 的 `FOR UPDATE` 交互不得超賣。

#### 6a. 兩並行 `開團`（flip + insert）
沿用 D-004 §4/§6 的併發安全網，加入 flip：

- 兩筆並行 `確認` 皆針對同一過期 open（id=5）：各自 `runInTransaction`（DEFERRED）。
  - T1：`UPDATE events SET status='done' WHERE id=5`（取得 id=5 列鎖）→ `INSERT open`（id=6）→ COMMIT。
  - T2：`UPDATE ... WHERE id=5` **阻塞**於 id=5 列鎖至 T1 COMMIT；解鎖後 UPDATE 生效（id=5 已 done、再寫 done 無害）→ `INSERT open`（id=7）→ **撞 `ux_events_active_group`**（id=6 為 open、同 group）→ `23505` → 窄捕捉（`constraint==='ux_events_active_group'`，D-004 現行 `isActiveGroupUniqueViolation`）→ `already_active`。
- 結論：**僅一場 open 建立**，另一場 `already_active`；**無雙 open**。單一 active 由 DB 唯一約束強制（不退化，G1）。flip 的 `UPDATE` 在舊列上以列鎖序列化，避免 lost update。
- **不需 `FOR UPDATE`**：開團走 `runInTransaction`（DEFERRED，D-004/D-007 §3）；INSERT 唯一約束即最終防線（flip 的列鎖處理舊列並行寫）。與 D-004 現行語意一致，僅多一步 flip。

#### 6b. `開團` flip × `signup`（`FOR UPDATE`）交互
- signup/cancel 走 `runImmediate(eventId, work)`：`SELECT id FROM events WHERE id=$1 FOR UPDATE` 鎖住該 event 列後 count→決策→insert（D-007 §3 路線 A）。
- **過期 open 被 signup 命中**：`findOpenEventForSignup` 於**進交易前**判 `isExpired` 為真 → 回 `undefined` → signup 回 `event_ended`、**根本不進 `runImmediate`** → 與 flip **無交易競態、無超賣面**。
- **邊界（read 與 tx 之間跨過 event_datetime）**：signup 於 T 讀到「未過期 open」→ 進 `runImmediate`；同時 `開團` 於稍後讀到「已過期」→ flip。兩者對同一 event 列（id=5）：flip 的 `UPDATE id=5` 與 signup 的 `SELECT id=5 FOR UPDATE` **在該列鎖上序列化**：
  - signup 先取鎖 → 插槽（於 id=5 容量內，**無超賣**）、COMMIT → flip 後續 done；該人落在「剛結束的活動」最終名單，良性。
  - flip 先取鎖 → id=5→done、insert 新 open、COMMIT → signup 的 `FOR UPDATE` 解鎖後續行。**為使 on-read 判定滴水不漏**：signup/cancel 的 `runImmediate` work **交易內 re-read event.status/過期**，若非 open 或已過期 → 回 `event_ended`、**不插槽**（AC-9）。此 re-check 使「過期/被 flip」在鎖內權威判定，杜絕「往已 done 事件插槽」。
- **無超賣保證**：任一情形下 `FOR UPDATE` 序列化同 event 的並行報名；插槽恆在 id 列容量內；過期/被 flip 於鎖內 re-check 阻止插入 → **既不超賣、也不雙開**（G1/G2）。

### 7. migration 0003（PG，post-T-012；獨立檔，OP-1 定案）

**前提**：0001/0002 已是 D-007 §6 產出的 **PG 版**（int4 IDENTITY、TEXT ISO）且 **T-012 已提交+測試通過**——0003 在其上演進、**不動 0001/0002**（符 D-001 §8「一經合併不得修改既有檔／一事一檔」）。DDL（說明語意，非交付碼）：

```sql
-- 0003_merge_event_datetime.sql（PostgreSQL；D-008）
-- (1) 加欄（先可空，供 backfill）
ALTER TABLE events ADD COLUMN event_datetime TEXT;

-- (2) backfill：event_date+event_time（台灣本地）→ UTC ISO-8601（含 Z）
--     greenfield 無列 → 影響 0 列；有列時語意須與應用層 taipeiToUtcIso 等義（台灣本地 → 減 8h → UTC）。
UPDATE events SET event_datetime = to_char(
  ((event_date || 'T' || event_time || ':00')::timestamp AT TIME ZONE 'Asia/Taipei')
    AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"'
) WHERE event_datetime IS NULL;

-- (3) 收斂為 NOT NULL
ALTER TABLE events ALTER COLUMN event_datetime SET NOT NULL;

-- (4) 移除舊兩欄
ALTER TABLE events DROP COLUMN event_date;
ALTER TABLE events DROP COLUMN event_time;

-- (5) 重定義單一 active 索引：active 集合移除 closed（釋放條件 a）
DROP INDEX ux_events_active_group;
CREATE UNIQUE INDEX ux_events_active_group ON events (group_id)
  WHERE status IN ('draft', 'open');
```

- **等義要點（G4）**：backfill 的時區轉換須與應用層 `taipeiToUtcIso` **等義**（同一「台灣本地→UTC」語意）；greenfield（尚未部署、無 prod 資料）下 backfill 幾乎 no-op，但仍須寫對以防未來有資料的環境。
- **不觸碰其他索引/約束**：`ix_events_group_status`、`status` CHECK、FK、0002 三計費欄、`registrations` 全部索引一律不動（僅動 events 的兩日期欄 + `ux_events_active_group`）。
- **顯示查詢用既有索引**：`findLatestDisplayable`（`group_id` + `status IN (...)` + `ORDER BY id DESC`）由既有 `ix_events_group_status` 支撐；**不新增** `event_datetime` 索引（過期判定於 ≤1 列應用層字串比較完成，不過度設計）。
- runner（`migrate.ts`）沿用 D-007 §6 機制（`schema_migrations`、逐檔單交易、直連跑 migrate、`applied_at` UTC ISO）。

### 8. 訊息 / 顯示（繁中純文字；文案細節見 OP-2/OP-3/OP-4）

- **過期 open 的 `+N`/`-N` 拒絕（`event_ended`，OP-2）**：擬「這場活動已結束，無法再報名／取消。」（使用者最終 APPROVED 可微調）。
- **名單 `phase='ended'`（過期 open，OP-3）**：標題擬「[○○ 球敘]（活動已結束）」+ 最終名單 + 結算（split 最終攤額）；移除「報名方式」列。
- **名單 `phase='closed'`（closed，OP-4）**：標題擬「[○○ 球敘]（報名已截止）」+ 最終名單 + 結算；移除「報名方式」列。
- **名單 `phase='live'`**：現行 D-003/D-005 表現不變（含報名方式 + 剩餘名額）。
- formatter 依 domain 傳入之 `phase` 選標題與是否附報名方式；日期一律 `utcIsoToTaipei(event.event_datetime)` 還原台灣本地顯示。

### 範圍內
- 釋放判定式（closed 索引移除 + 過期 open 惰性 flip）、三取用語意（阻擋/報名/顯示）拆分、過期 open 拒報名 + 名單 `ended`/closed 名單 `closed` 顯示、`event_datetime` 合併 + 台灣本地↔UTC 轉換、schema.ts/`ACTIVE_EVENT_STATUSES`/`DISPLAYABLE_EVENT_STATUSES` 型別變更、migration 0003、併發（flip+insert 原子、signup FOR UPDATE re-check）、done 於 MVP 物化路徑（僅內部釋放槽）。

### 範圍外
- 背景排程/cron 主動翻 done（serverless 無 cron，D-007 §4；一律 on-read）——過期 open 物理 flip 僅於下次 `開團` 交易發生，其餘時刻以 on-read `phase` 呈現「活動已結束」。
- 同群多場並行活動（Brief 決策 #3 不變，仍限一場進行中）。
- 「已結束/報名已截止」活動的重開/複製、歷史活動查詢介面（v2）。
- DST/跨時區使用者（MVP 固定 Asia/Taipei UTC+8，OP-6）。
- signup 對 **closed** 事件的訊息細化（現行回 `no_open_event`；名單走 closed 顯示；signup 訊息未特別區分，屬既有行為，非本次擴充）。

---

## 二、Guardrails（Must NOT；R2）

- **G1（單一 active／併發不得雙開，正確性不得退化）**：`ux_events_active_group`（partial unique on `{draft,open}`）為同群單一 active 的最終保證，**不得**放寬到允許兩筆 `{draft,open}` 並存。過期 open 的釋放**必須**在**同一 `runInTransaction`** 內「先 `UPDATE status='done'`（flip）再 `INSERT` 新 open」**原子**完成；**不得**以「先於一交易 flip/DELETE、後於另一交易 INSERT」等非原子方式釋放（會出現雙 open 或零 active 窗口）。兩並行開團**必**僅一成功、另一撞 `23505` → `already_active`（窄捕捉僅認 `constraint==='ux_events_active_group'`，其餘 re-throw）。
- **G2（on-read 判定一致，報名/顯示不得漏點或混淆）**：所有「是否開放報名」判定點——`+N`/`-N` 的 `findOpenEventForSignup`（進交易前）**與** signup/cancel `runImmediate` 交易內 re-check——**必須同時**要求 `status='open' AND event_datetime >= NOW()`；過期 open **不得**被 `+N`/`-N` 接受（防在已結束活動上報名/超賣）。顯示（名單）**必須**依 `phase` 正確標示：`ended`（過期 open）→「活動已結束」、`closed`→「報名已截止」、`live`→可報名；**不得**把過期 open 或 closed 呈現為可報名，**不得**把 closed 誤標為「活動已結束」或反之。三讀取點（報名/顯示/阻擋生命週期）**不得**共用同一查詢集而混淆語意（阻擋用 `{draft,open}`、顯示用 `{draft,open,closed}`）。
- **G3（時間一律 UTC 儲存，不得退化 G11）**：`event_datetime` **一律**以 UTC ISO-8601（`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`）儲存；台灣本地輸入**必**於寫入前 `taipeiToUtcIso` 轉 UTC，顯示時**必**由 UTC `utcIsoToTaipei` 轉回本地。**不得**把台灣本地 wall time 直接存入 `event_datetime`（會破壞 `NOW() > event_datetime` 過期判定與字典序時序等價）。**不得**改用 `timestamptz`（D-007 OP-4；破壞 TEXT ISO 不變式）。
- **G4（合併欄位 migration 語意等義，不得漏索引/約束）**：0003 **必須**完成 (a) 台灣本地→UTC **等義** backfill `event_datetime`、(b) `event_datetime NOT NULL`、(c) drop `event_date`/`event_time`、(d) **重定義** `ux_events_active_group` 的 `WHERE` 由 `{draft,open,closed}` 為 `{draft,open}`（移除 `closed`）。**不得**遺漏 (d)（否則 closed 仍擋團，釋放條件 (a) 失效）；**不得**改動 `ix_events_group_status`／`status` CHECK／FK／0002 計費欄／`registrations` 任何索引之語意；**不得**修改已凍結的 0001/0002（獨立 0003，OP-1）。backfill 轉換須與應用層 `taipeiToUtcIso` 同語意。
- **G5（唯讀不寫；flip 僅於寫入語境）**：`名單`／`+N`／`-N` 等**唯讀讀取路徑不得**對過期 open 或 closed 執行任何狀態寫入（避免唯讀路徑產生寫入、serverless 下無謂併發寫）。`done` 的**物理** flip **只**於 `開團` `確認` 交易（已是寫入語境、需原子釋放索引槽）內發生；其餘時刻「活動已結束」為 **on-read `phase`**，不倚賴物理 `done`。**不得**因追求物理狀態一致而在讀取點加寫入。

---

## 三、Acceptance Checks（`[D-008 AC-n]`，可轉測試）

- [ ] **[D-008 AC-1]（closed 後可開新團）**：群組僅有一場 `closed` 事件（無 open），`開團`→`確認` → 成功建立新 `open`（**不**回 `already_active`）。（closed ∉ `{draft,open}` → 索引槽已釋放）
- [ ] **[D-008 AC-2]（過期 open 開團自動 flip done 並放行）**：群組有一場 `open` 且 `event_datetime < NOW()`，`開團`→`確認` → 舊事件 `status` 變 `done`、新 `open` 建立成功且同交易插入主辦首列；`名單` 顯示新事件（live）。
- [ ] **[D-008 AC-3]（未過期 open 仍擋團）**：群組有 `open` 且 `event_datetime >= NOW()`，`開團` → `already_active`（**不** flip、**不**建立、**不**寫 conversation 於入口早退）。
- [ ] **[D-008 AC-4]（過期 open 的 +N/-N 被拒）**：`open` 但過期，`+N`（及 `-N`）→ 回 `event_ended`（OP-2 文案），**無**新 `registrations` 列、**無** flip、**不**進 `runImmediate`。
- [ ] **[D-008 AC-5]（名單顯示活動已結束）**：`open` 但過期，`名單` → `phase='ended'`，顯示「活動已結束」標題 + 最終名單（+ `split_venue` 最終攤額）；**不**呈現「報名方式」/可報名剩餘名額語氣。
- [ ] **[D-008 AC-6]（兩並行開團僅一成功）**：兩筆並行 `確認`（皆針對同一過期 open，或皆針對空群）→ **僅一**建立 `open`，另一撞 `ux_events_active_group`（`23505`）→ `already_active`；結束後該 group 至多一場 `{draft,open}`（無雙 open）。
- [ ] **[D-008 AC-7]（event_datetime 存 UTC + 過期判定跨邊界正確）**：輸入台灣 `2026-08-15 07:30` → 存 `2026-08-14T23:30:00Z`；`NOW()='2026-08-14T23:29:00Z'` → 未過期（擋團 + 可報名），`'2026-08-14T23:31:00Z'` → 過期（釋放 + 拒報名）。跨台灣午夜案例：`2026-08-15 00:30` → `2026-08-14T16:30:00Z`。
- [ ] **[D-008 AC-8]（migration 0003 等義）**：對含舊 schema（`event_date`/`event_time` + 舊索引 `WHERE ... IN ('draft','open','closed')`）的 PG 跑 0003 → `event_datetime NOT NULL` 存在且 backfill 值等義（台灣本地→UTC）、`event_date`/`event_time` 已 drop、`ux_events_active_group` predicate = `{draft,open}`；同群第二場 `{draft,open}` INSERT 被拒（`23505`），而在一場 `closed` 事件旁 INSERT `open` **成功**（closed 不擋）；0001/0002 未被修改。
- [ ] **[D-008 AC-9]（signup 交易內 re-check）**：事件於 `findOpenEventForSignup` 後、`runImmediate` 交易內被並行 flip 為 `done`（或已過期），signup 交易內 re-read 見非 open/過期 → 回 `event_ended`、**不插槽**、無超賣。
- [ ] **[D-008 AC-10]（顯示時區還原一致）**：`event_datetime`（UTC）→ `名單`/開團公告顯示為台灣本地 `YYYY-MM-DD HH:MM`，與輸入字面一致（例：存 `2026-08-14T23:30:00Z` → 顯示 `2026-08-15 07:30`）。
- [ ] **[D-008 AC-11]（closed 名單顯示報名已截止；OP-4 定案，取代原「維持 no_open_event」）**：群組僅有一場 `closed` 事件（未開新團），`名單` → `phase='closed'`，顯示「報名已截止」標題 + 最終名單（+ `split_venue` 最終攤額）；**非** `no_open_event`。
- [ ] **[D-008 AC-12]（顯示取 latest-by-id，closed 與新 open 並存時顯示新 open）**：群組先 `關閉報名`（closed #A）再 `開團`（open #B，因 closed 已釋放）→ `findEventForDisplay` 回 `#B`（latest），`名單` 顯示 `#B`（live）、非 `#A`；且 `#A` 名單資料仍在（未刪，稽核保留）。

---

## 四、開放問題 OP（**全數定案**，2026-08-01 使用者裁決）

- **OP-1（migration 策略）＝定案：獨立 0003（post-T-012）**。理由：T-012 的 0001/0002 已提交+測試通過，另立 `0003_merge_event_datetime.sql` 符 D-001 §8「一經合併不得修改既有檔／一事一檔」、可審且不回退既有測試。
- **OP-2（過期 open 的 +N/-N 拒絕文案）＝定案：採簡潔繁中「這場活動已結束，無法再報名／取消」**。理由：明確告知已結束、避免與「沒有活動」混淆；最終 APPROVED 時可微調。
- **OP-3（過期/done 名單措辭）＝定案：「活動已結束」**。理由：與 OP-4「報名已截止」區分 done（時間到）vs closed（主辦關閉報名）兩種語意。
- **OP-4（closed 名單顯示）＝定案：顯示最終名單並標「報名已截止」**。理由：closed 已釋放擋團但球敘照常，名單仍需可查；`findEventForDisplay` 納入 closed（顯示集 `{draft,open,closed}`），與過期 open 的「活動已結束」以 `phase` 區分。（對原 DRAFT 之實質變更，已反映於 §2/§4/§5/§8、AC-11/AC-12。）
- **OP-5（draft）＝定案：無需特別處理**。理由：MVP draft 不物化（D-001 澄清），`{draft,open}` 實務等同 `{open}`、draft 不會過期；索引保留 draft 為向前相容。
- **OP-6（時區）＝定案：固定 UTC+8 偏移算術**。理由：Asia/Taipei 無 DST，固定偏移無相依、確定性、可純測，符「不過度設計」。
- **OP-7（close/cancel 遇過期 open）＝定案：回 `no_active`、不 flip**。理由：讀寫最小、reads 不寫（G5）；物理 flip 延到下次 `開團`（唯一需原子釋放索引槽的寫入點）。

---

## 五、預列 errata 清單（本設計牽動之既有 APPROVED 文件；**不私改**，走 errata / 回報 Orchestrator）

> 依 harness/LESSONS「R2 跨多文件功能主動盤點」。下列為 D-008 落地時**需為既有文件補 errata 或回報**之處，非本文件逕改。已依 OP-1/OP-4 定案更新。

- **D-001（資料模型）**：
  - §2 events schema：`event_date`/`event_time`（顯示文字兩欄）→ 單一 `event_datetime`（UTC ISO TEXT）；§0 型別對映新增 `event_datetime`、移除舊兩欄；ERD events 欄位。
  - §0 Q2 裁決（date/time 維持文字、跨時區排序非 MVP 需求）**被決策 #8 取代**（改存 UTC 供過期判定）。
  - §2/§7：`ux_events_active_group` 的 `WHERE`/active 集合 `{draft,open,closed}` → `{draft,open}`；`ACTIVE_EVENT_STATUSES` 移除 closed；**新增** `DISPLAYABLE_EVENT_STATUSES = {draft,open,closed}`（顯示用）；G3「active = {draft,open,closed}」定義；§7 狀態機「active 集合」；`done` 由「終態、非開團範圍」增訂**過期 open 惰性 flip 物化 done** 路徑（僅內部釋放槽、不顯示）。
  - AC-9（同群第二場 active 被拒，前提列 draft/open/closed）→ 前提改 `{draft,open}` + closed 不擋（新增 closed 旁可開 open）。
- **D-004（開團流程）**：
  - §4 confirm step 3：`if (active && status∈{open,closed}) already_active` → 改「未過期 open → already_active；過期 open → flip done 後續建」。
  - §5.1 轉移表：`closed → cancelled`（cancel_event）、`closed → open`(reopen) 及 `close_event` 的 `already_closed` 路徑——因 `findActiveByGroup` 不再回 closed → **不可達**；`關閉報名` 二次 → `no_active`（原 `already_closed`）。
  - §5.2 close/cancel：closed 事件不再由 `findActiveByGroup` 返回之影響；過期 open 處置＝`no_active`（OP-7）。
  - §6 同群 active：active `{open,closed}` → `{draft,open}`；**closed 釋放**（原「closed 仍擋、需 `取消活動` 才釋放」反轉）。
  - §8 訊息：(I) `formatAlreadyActiveEntry` 的 N2 註「`關閉報名` 不釋放名額，故不必先關閉」**反轉**（closed 現會釋放擋團）；(I)/(D) event 日期顯示改衍生 `event_datetime`；(E)/(J) `formatAlreadyClosed` 於 close 路徑不可達（保留供防禦）。
  - `CreateEventInput` `eventDate`/`eventTime` → `eventDatetime`；相關 AC（already_closed / closed 生命週期 / 日期顯示斷言欄位來源）。
- **D-005（計費）**：`formatClosed`/`feeLine` 金額邏輯不變；event 日期顯示改由 `event_datetime` 衍生（顯示字面台灣本地一致 → 訊息斷言值多不變，僅欄位存取改動）。closed／過期 open 名單（`phase`）下 split 最終攤額顯示語意（closed→報名已截止、ended→活動已結束）。
- **D-003（報名核心）**：`findOpenEvent` **拆分**為 `findOpenEventForSignup`（+過期排除，供 `+N`/`-N`）與 `findEventForDisplay`（用新 repo 原語 `findLatestDisplayable`，顯示集 `{draft,open,closed}`、含 closed 與過期 open，回 `phase`，供 `名單`）；signup/cancel 新增 `event_ended` 結果 + `runImmediate` 交易內 re-check；`getListView` 帶 `phase`；`list-formatter.eventHeader` 日期欄改衍生 `event_datetime`、新增 `closed`/`ended` 名單變體。既有 AC 於 `live`（未過期 open）下仍成立。
- **D-007（PG 移植）**：§6「**無 0003**（D-006 作廢 group_admins）」→ **新增 `0003_merge_event_datetime.sql`（post-T-012，D-008）**；§2「schema.ts 幾乎不改」→ `EventRow` 改 `event_datetime`、migration 0001 含 `event_date`/`event_time` 之欄位由 0003 演進；AC-5（建表等義）涵蓋 events 欄位/索引變更；新增 `EventReader.findLatestDisplayable` 唯讀原語（符 N-new-2「pool-bound 只曝讀方法」）。ADR-004 若述「無 0003」同步註記。

---

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 裁決 |
|---|---|---|
| 2026-08-01 | D-008 DRAFT 產出 | 待 design-reviewer + architect-reviewer（R2 雙審）與使用者最終 APPROVED 後解鎖實作任務（T-013/T-014，待建）。實作於 T-012（PG 移植）落地後。 |
| 2026-08-01 | OP-1~7 使用者裁決 | OP-1 獨立 0003；OP-2 拒絕文案「這場活動已結束，無法再報名／取消」；OP-3 過期/done 措辭「活動已結束」；**OP-4 closed 名單顯示最終名單標「報名已截止」（實質變更：`findEventForDisplay` 納入 closed、formatter 兩種 `phase`）**；OP-5 draft 無需特別處理；OP-6 固定 UTC+8；OP-7 close/cancel 遇過期 open 回 `no_active` 不 flip。設計正文（§2/§4/§5/§8、Guardrails G2、AC-5/AC-11/AC-12）已依定案更新自洽。 |
