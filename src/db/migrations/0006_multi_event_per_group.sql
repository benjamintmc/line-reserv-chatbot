-- 0006_multi_event_per_group.sql — D-021 §1（PostgreSQL 方言；migration runner 單檔單交易）
--
-- T-033a：解除「同群至多一場 active」的 DB 層硬限制，換上「同群 active 集合內，場地+時間不得
-- 重複」的新安全網，並建立機制 A（bot 訊息 → 活動）的映射表。
--
-- 0001~0005 為既有／凍結區（已於 PROD 執行）——只新增、不改寫（CLAUDE.md §4.5 / D-001 §8）。
--
-- 索引**改名**（非沿用 ux_events_active_group）：舊名語意是「同群同時只能一場」，新名語意是
-- 「同群同時不能有兩場場地+時間相同」，語意不同不得共用名字（否則 confirm() 的窄捕捉 catch
-- 邏輯會誤判，D-021 G8）。
--
-- 同群 open 數上限（D-028）**不在此新增任何索引/約束**——屬應用層計數判斷。

SET LOCAL lock_timeout = '3s';  -- events 為熱表，ALTER/INDEX 需 ACCESS EXCLUSIVE，比照 D-013 防守

-- (1) 解除「同群至多一場 active」：drop 舊單欄索引。
DROP INDEX ux_events_active_group;

-- (2) 新安全網：同群 active 集合內，場地+時間不得重複（decision #9 查重防護的 DB 層）。
--     以 (group_id, location, event_datetime) 唯一，取代原 (group_id) 唯一。
CREATE UNIQUE INDEX ux_events_active_group_venue_time ON events (group_id, location, event_datetime)
  WHERE status IN ('draft', 'open');

-- (3) 機制 A：bot 訊息 → 活動 映射表。
--     刻意**不存 group_id**：跨群校驗改在讀取時以 events.getById 比對即可（D-021 §4.1／G14）。
--     不設 ON DELETE CASCADE——events 從不物理刪除（狀態機終態即可，D-004 G6/G10）。
CREATE TABLE message_event_map (
  message_id  TEXT PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  created_at  TEXT NOT NULL
);
-- 供 Backlog 的「每週清除已結束活動關聯資料」日後使用（本輪不實作清除排程）。
CREATE INDEX ix_message_event_map_event ON message_event_map (event_id);
