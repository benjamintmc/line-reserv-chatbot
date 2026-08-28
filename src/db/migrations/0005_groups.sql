-- 0005_groups.sql — D-018 §1（PostgreSQL 方言；migration runner 單檔單交易）
--
-- 新增 `groups`：機器人「觸及了哪些 LINE 群組」的第一手紀錄。
-- 在此之前 group_id 只在有人**成功開團**時才進資料庫（events.group_id）⇒「加了機器人卻從未
-- 開團的群」在資料上完全不存在，機器人何時進出某群亦無紀錄。本表補齊這層觀測資料。
--
-- 0001~0004 為凍結區（已於 PROD 執行）——只新增、不改寫（D-018 G3 / CLAUDE.md §4.5）。
--
-- 刻意**不對 events.group_id 建 FK**（D-018 §範圍內 1）：groups 可先於任何 event 存在
-- （加了機器人但沒開團正是要觀測的情境），加 FK 會讓 backfill 與首見寫入順序互相耦合。
--
-- 時間欄一律「應用層寫入」UTC ISO-8601 TEXT，不使用 DEFAULT CURRENT_TIMESTAMP
-- （D-001 §0 G11；本檔的 backfill 為唯一例外——它抄的是 events 既有的應用層時間戳，非時鐘讀值）。

CREATE TABLE groups (
  group_id       TEXT NOT NULL PRIMARY KEY,
  -- 群組名稱快照（best-effort）；取不到或未接線時為 NULL，純供人辨識，不參與任何邏輯。
  group_name     TEXT,
  -- 機器人加入該群的時間。**discovered_via='backfill' 時此值僅為上限保守估計**
  -- （取該群最早一場活動的建立時間；實際加入時間更早且不可考）。
  joined_at      TEXT NOT NULL,
  -- 本列的來源：'join'=收到加入事件（時間精確）／'message'=功能上線前已在群、由訊息首見補登
  -- ／'backfill'=本 migration 自 events 回填。
  discovered_via TEXT NOT NULL CHECK (discovered_via IN ('join', 'message', 'backfill')),
  -- 機器人被移出該群的時間；NULL = 仍在群。重新加入時清回 NULL（joined_at 保留首次值）。
  left_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 主力查詢：現存群組數／依加入時間排序的擴散曲線。
CREATE INDEX ix_groups_active ON groups (joined_at) WHERE left_at IS NULL;

-- backfill：所有曾出現過活動的群組，以該群最早一場活動的 created_at 作為 joined_at 下限。
-- ON CONFLICT DO NOTHING 使本檔在任何情況下重跑皆無副作用（runner 本身亦冪等，D-001 §8）。
INSERT INTO groups (group_id, joined_at, discovered_via, created_at, updated_at)
SELECT group_id, MIN(created_at), 'backfill', MIN(created_at), MIN(created_at)
FROM events
GROUP BY group_id
ON CONFLICT (group_id) DO NOTHING;
