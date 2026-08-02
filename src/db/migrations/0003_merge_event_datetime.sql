-- 0003_merge_event_datetime.sql — D-008 §7（PostgreSQL 方言；post-T-012，獨立 0003，OP-1）
--
-- 合併 event_date + event_time（台灣本地顯示文字兩欄）→ 單一 event_datetime（UTC ISO-8601 TEXT），
-- 並重定義 ux_events_active_group 的 active 集合（移除 closed，釋放條件 a）。
-- 一經合併不得修改本檔；不動 0001/0002（D-001 §8、D-008 G4）。
--
-- G4 四步俱全：(a) 等義 backfill、(b) NOT NULL、(c) drop 舊兩欄、(d) 重定義索引 {draft,open}。
-- greenfield（尚無 prod 資料）下 backfill 影響 0 列，但仍寫對以防未來有資料的環境。

-- (1) 加欄（先可空，供 backfill）。
ALTER TABLE events ADD COLUMN event_datetime TEXT;

-- (2) backfill：event_date+event_time（台灣本地）→ UTC ISO-8601（含 Z）。
--     語意須與應用層 taipeiToUtcIso 等義（台灣本地 → 減 8h → UTC）；未來球敘日期無 1980 前歷史 DST 交集（nit-3）。
UPDATE events SET event_datetime = to_char(
  ((event_date || 'T' || event_time || ':00')::timestamp AT TIME ZONE 'Asia/Taipei')
    AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"'
) WHERE event_datetime IS NULL;

-- (3) 收斂為 NOT NULL。
ALTER TABLE events ALTER COLUMN event_datetime SET NOT NULL;

-- (4) 移除舊兩欄。
ALTER TABLE events DROP COLUMN event_date;
ALTER TABLE events DROP COLUMN event_time;

-- (5) 重定義單一 active 索引：active 集合移除 closed（釋放條件 a；G4 (d)）。
--     其餘索引/約束（ix_events_group_status、status CHECK、FK、0002 計費欄、registrations 索引）一律不動。
DROP INDEX ux_events_active_group;
CREATE UNIQUE INDEX ux_events_active_group ON events (group_id)
  WHERE status IN ('draft', 'open');
