# 成長指標查詢（D-018）

> 直接對 Neon 連線執行（`psql "$DATABASE_URL"` 或 Neon SQL Editor）。
> **本檔的每個 SQL 程式碼區塊，皆由 `src/db/__tests__/metrics-sql.test.ts` 逐段對測試 DB 實跑**（D-018 AC-9）——
> 改動 SQL 後 `npm test` 會擋下語法錯誤與欄位改名，避免文件與 schema 悄悄脫節。

## 口徑定義（先讀，否則數字會誤讀）

| 名詞 | 定義 | 為何這樣定 |
|---|---|---|
| **實際使用者** | 有過**未取消**且 `kind='self'` 報名的人 | 被代報名者（`kind='proxy'`）沒有 LINE 帳號紀錄、從未與機器人互動，不算使用者 |
| **活動** | `events.status <> 'draft'` | `draft` 是開團問答開到一半的半成品，不是真的有辦成 |
| **再次使用** | 參加過 **2 場以上不同活動** | 2026-08-28 使用者裁決 |
| **觸及的群組** | `groups` 中 `left_at IS NULL` 者 | 含「加了機器人但從未開團」的群——這是舊資料完全看不到的一塊 |

**兩個必須知道的限制**：

1. `discovered_via='backfill'` 的列，其 `joined_at` 是**上限保守估計**（取自該群最早一場活動的建立
   時間，實際加入時間更早且不可考）。算「加入到首次開團要多久」時務必排除這批。
2. 「非我主動建立的群組」**無法精確計算**——LINE 平台不提供群組建立者資訊，且已裁決不做人工標記。
   下方 `groups_organic_est` 是以「我從未在其中開過團」推估，會把「我開了第一團之後放手的群」
   誤判成非我建立。**它是估計值，不是精確數字。**

## 一、實際使用者數（目標 100）

```sql
SELECT COUNT(DISTINCT owner_user_id) AS real_users
FROM registrations
WHERE kind = 'self' AND cancelled_at IS NULL;
```

## 二、辦成的活動數 / 有開過團的群組數（目標 30）

```sql
SELECT
  (SELECT COUNT(*) FROM events WHERE status <> 'draft')                 AS events_created,
  (SELECT COUNT(DISTINCT group_id) FROM events WHERE status <> 'draft') AS groups_with_events;
```

## 三、重複開團主（目標 10 位）

開過 2 場以上的人數。

```sql
SELECT COUNT(*) AS repeat_hosts
FROM (
  SELECT host_user_id
  FROM events
  WHERE status <> 'draft'
  GROUP BY host_user_id
  HAVING COUNT(*) >= 2
) h;
```

## 四、回訪率（目標 40%）

```sql
WITH per_user AS (
  SELECT owner_user_id, COUNT(DISTINCT event_id) AS n
  FROM registrations
  WHERE kind = 'self' AND cancelled_at IS NULL
  GROUP BY owner_user_id
)
SELECT COUNT(*) FILTER (WHERE n >= 2)                                      AS returning_users,
       COUNT(*)                                                            AS total_users,
       ROUND(100.0 * COUNT(*) FILTER (WHERE n >= 2) / NULLIF(COUNT(*), 0), 1) AS returning_pct
FROM per_user;
```

## 五、擴散：非我主動建立的群組（目標 5，**推估值**）

`$1` = 你自己的 LINE userId（在群組裡輸入 `我的ID` 可取得）。

- `groups_reached`：機器人目前所在的群組總數。
- `groups_activated`：其中真的開過團的。**`reached - activated` 就是「加了不用」的群數**——
  這是本次新增觀測前完全看不到的數字，通常比擴散數更值得看。
- `groups_organic_est`：我從未在其中開過團的群數，即第 5 項指標的推估值（限制見上）。

```sql
SELECT COUNT(*)                                   AS groups_reached,
       COUNT(*) FILTER (WHERE has_event)          AS groups_activated,
       COUNT(*) FILTER (WHERE never_hosted_by_me) AS groups_organic_est
FROM (
  SELECT g.group_id,
         EXISTS (
           SELECT 1 FROM events e
           WHERE e.group_id = g.group_id AND e.status <> 'draft'
         ) AS has_event,
         NOT EXISTS (
           SELECT 1 FROM events e JOIN users u ON u.id = e.host_user_id
           WHERE e.group_id = g.group_id AND u.line_user_id = $1
         ) AS never_hosted_by_me
  FROM groups g
  WHERE g.left_at IS NULL
) s;
```
