-- 0002_billing_modes.sql — D-005 計費模式：events 加 price_mode / venue_fee / settled_per_person（PostgreSQL 方言，D-007 §6）。
-- 由 SQLite 版轉出，語意 1:1 等義（G5）。PG ALTER TABLE ADD COLUMN 支援 NOT NULL+DEFAULT+CHECK，
-- 既有列自動以 DEFAULT 回填（backfill 無需額外 UPDATE：既有列 price_mode='per_person'、venue_fee/settled_per_person 為 NULL）。
-- 一經合併不得修改本檔；schema 演進以新序號檔新增（D-001 §8）。
ALTER TABLE events ADD COLUMN price_mode TEXT NOT NULL DEFAULT 'per_person'
  CHECK (price_mode IN ('per_person', 'split_venue'));
ALTER TABLE events ADD COLUMN venue_fee INTEGER
  CHECK (venue_fee IS NULL OR venue_fee > 0);  -- 單欄 CHECK（architect N1）：攔 <=0 髒寫入；split 時應用層另保證非 NULL
ALTER TABLE events ADD COLUMN settled_per_person INTEGER;  -- OP-3：關閉報名(split)時寫入最終攤額；否則 NULL
