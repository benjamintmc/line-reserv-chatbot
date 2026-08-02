-- 0001_init.sql — D-001 資料模型初始 schema（PostgreSQL 方言，D-007 §6）
--
-- 由 SQLite 版轉出，語意 1:1 等義（G5）。與 SQLite 檔的差異僅方言處：
--   * 代理主鍵：INTEGER GENERATED ALWAYS AS IDENTITY（int4；B2 定案）。
--     不採 BIGINT——pg 預設把 int8(OID 20) 解析為 string，會使 schema.ts 的 id:number/FK 執行期實為 string（G6）。
--     int4 由 pg 天然回 number，Row number 前提成立。MVP 值域永不觸 int4 上限（~21 億）。
--   * 布林 is_host：SMALLINT 0/1 + CHECK（OP-7；保 UserRow number 型別）。
-- 其餘一律不變：
--   * 時間欄一律「應用層寫入」UTC ISO-8601 TEXT，**不使用 DEFAULT CURRENT_TIMESTAMP**（G11、OP-4）。
--   * 金額 price_per_person 為整數新台幣元（D-001 §0）。
--   * FK 與 CHECK 約束不得省略（G8）；列舉一律 TEXT + CHECK（不用原生 ENUM，利遷移）。
-- 一經合併不得修改本檔；schema 演進以新序號檔新增（D-001 §8）。

-- migration 追蹤表（runner 亦以 IF NOT EXISTS 保證存在，D-001 §8）。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT NOT NULL PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 1. users：一位 LINE 使用者一列；display_name 為最近互動快照（D-001 §1）。
CREATE TABLE users (
  id           INTEGER  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_user_id TEXT     NOT NULL,
  display_name TEXT     NOT NULL,
  is_host      SMALLINT NOT NULL DEFAULT 0 CHECK (is_host IN (0, 1)),
  created_at   TEXT     NOT NULL,
  updated_at   TEXT     NOT NULL
);
CREATE UNIQUE INDEX ux_users_line_user_id ON users (line_user_id);

-- 2. events：一場球聚一列；同 group 至多一場 active（D-001 §2、G3）。
CREATE TABLE events (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id         TEXT    NOT NULL,
  host_user_id     INTEGER NOT NULL REFERENCES users (id),
  event_date       TEXT    NOT NULL, -- 顯示文字 YYYY-MM-DD（Q2 裁決）
  event_time       TEXT    NOT NULL, -- 顯示文字 HH:MM（24h）
  location         TEXT    NOT NULL,
  capacity         INTEGER NOT NULL CHECK (capacity > 0),
  price_per_person INTEGER NOT NULL DEFAULT 0 CHECK (price_per_person >= 0),
  status           TEXT    NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'open', 'closed', 'cancelled', 'done')),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
-- 單一進行中活動：active = {draft, open, closed}（partial unique index，G3）。
CREATE UNIQUE INDEX ux_events_active_group ON events (group_id)
  WHERE status IN ('draft', 'open', 'closed');
-- 查某群目前活動用。
CREATE INDEX ix_events_group_status ON events (group_id, status);

-- 3. registrations：一名額一列（per-slot，ADR-001）；取消採 soft-delete（Q3、G9）。
CREATE TABLE registrations (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id             INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  owner_user_id        INTEGER NOT NULL REFERENCES users (id),
  display_name         TEXT    NOT NULL, -- 報名當下快照；proxy 時為輸入名字（NFR-4、G5）
  kind                 TEXT    NOT NULL DEFAULT 'self' CHECK (kind IN ('self', 'proxy')),
  status               TEXT    NOT NULL CHECK (status IN ('confirmed', 'waitlist')),
  seq                  INTEGER NOT NULL, -- event 內單調遞增；取消列仍佔用（G7）
  cancelled_at         TEXT,             -- NULL=有效；非 NULL=已取消（soft-delete 唯一有效性依據）
  cancelled_by_user_id INTEGER REFERENCES users (id), -- 執行取消者，供稽核
  created_at           TEXT    NOT NULL  -- FIFO 次要排序依據（單一 ISO 格式確保字典序）
);
-- 序號唯一（含已取消列），競態最後防線（G7、AC-11）。
CREATE UNIQUE INDEX ux_reg_event_seq ON registrations (event_id, seq);
-- 主力查詢索引：名單/計數/遞補選取，僅涵蓋有效列（G10）。
CREATE INDEX ix_reg_active ON registrations (event_id, status, seq)
  WHERE cancelled_at IS NULL;
-- -N 取消時定位某人未取消名額。
CREATE INDEX ix_reg_active_owner ON registrations (event_id, owner_user_id)
  WHERE cancelled_at IS NULL;

-- 4. conversation_states：逐步開團問答暫存（D-001 §4）。
CREATE TABLE conversation_states (
  line_user_id TEXT PRIMARY KEY,
  group_id     TEXT,
  state        TEXT NOT NULL,
  payload      TEXT, -- JSON 字串
  updated_at   TEXT NOT NULL
);

-- 5. processed_events：webhook 冪等去重（D-001 §5、G6）。
CREATE TABLE processed_events (
  message_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
