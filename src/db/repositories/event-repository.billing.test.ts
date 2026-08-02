import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, type Pool, type PoolClient } from '../index';
import { createTestDb, type TestDb } from '../__tests__/test-db';

const TEST_URL = process.env.DATABASE_URL_TEST ?? 'postgres://golf:golf@localhost:5433/golf_test';

describe('EventRepository 計費一致性（D-005 §1.3 / G4）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-005 AC-13] split_venue → venue_fee=3000、price_per_person=0', async () => {
    const host = await t.users.upsert('U-h', '主辦');
    const row = await t.events.create({
      groupId: 'G-split',
      hostUserId: host.id,
      eventDatetime: '2026-08-14T23:30:00Z',
      location: '東方球場',
      capacity: 16,
      priceMode: 'split_venue',
      venueFee: 3000,
      status: 'open',
    });
    expect(row.price_mode).toBe('split_venue');
    expect(row.venue_fee).toBe(3000);
    expect(row.price_per_person).toBe(0);
    expect(row.settled_per_person).toBeNull();
  });

  it('[D-005 AC-13] per_person → venue_fee=NULL、price_per_person=2200', async () => {
    const host = await t.users.upsert('U-h', '主辦');
    const row = await t.events.create({
      groupId: 'G-pp',
      hostUserId: host.id,
      eventDatetime: '2026-08-14T23:30:00Z',
      location: '東方球場',
      capacity: 16,
      priceMode: 'per_person',
      pricePerPerson: 2200,
      status: 'open',
    });
    expect(row.price_mode).toBe('per_person');
    expect(row.venue_fee).toBeNull();
    expect(row.price_per_person).toBe(2200);
  });

  it('[D-005 AC-13] 預設 priceMode 為 per_person（回歸；venue_fee=NULL）', async () => {
    const host = await t.users.upsert('U-h', '主辦');
    const row = await t.events.create({
      groupId: 'G-def',
      hostUserId: host.id,
      eventDatetime: '2026-08-14T23:30:00Z',
      location: '東方球場',
      capacity: 16,
      pricePerPerson: 1800,
      status: 'open',
    });
    expect(row.price_mode).toBe('per_person');
    expect(row.venue_fee).toBeNull();
  });

  it('[D-005 AC-13] 不一致組合被邊界層拒絕（split 缺/≤0 venue_fee、per_person 帶 venue_fee）', async () => {
    const host = await t.users.upsert('U-h', '主辦');
    const base = {
      groupId: 'G-bad',
      hostUserId: host.id,
      eventDatetime: '2026-08-14T23:30:00Z',
      location: '東方球場',
      capacity: 16,
      status: 'open' as const,
    };
    // split 缺 venue_fee
    await expect(t.events.create({ ...base, priceMode: 'split_venue' })).rejects.toThrow(/venue_fee/);
    // split venue_fee<=0
    await expect(
      t.events.create({ ...base, priceMode: 'split_venue', venueFee: 0 }),
    ).rejects.toThrow(/venue_fee/);
    // per_person 帶 venue_fee
    await expect(
      t.events.create({ ...base, priceMode: 'per_person', pricePerPerson: 2200, venueFee: 5000 }),
    ).rejects.toThrow(/venue_fee/);
  });

  it('[D-005 AC-13] settled_per_person 由 updateSettledPerPerson 寫入（split close）', async () => {
    const host = await t.users.upsert('U-h', '主辦');
    const row = await t.events.create({
      groupId: 'G-set',
      hostUserId: host.id,
      eventDatetime: '2026-08-14T23:30:00Z',
      location: '東方球場',
      capacity: 16,
      priceMode: 'split_venue',
      venueFee: 3000,
      status: 'open',
    });
    expect(await t.events.updateSettledPerPerson(row.id, 429)).toBe(1);
    expect((await t.events.getById(row.id))?.settled_per_person).toBe(429);
  });
});

describe('migration 0002 backfill（D-005 §1.2 / AC-12 / G7 / G8）', () => {
  // PG 下以獨立 schema（search_path）模擬「僅套用 0001 的舊 schema」→ 插入既有列 → 套 0002 驗 backfill。
  let pool: Pool;
  let client: PoolClient;
  const migrations = join(__dirname, '..', 'migrations');
  const NOW = '2026-08-01T00:00:00Z';

  beforeEach(async () => {
    pool = createPool(TEST_URL);
    client = await pool.connect();
    await client.query('DROP SCHEMA IF EXISTS backfill_test CASCADE');
    await client.query('CREATE SCHEMA backfill_test');
    await client.query('SET search_path TO backfill_test');
  });
  afterEach(async () => {
    await client.query('DROP SCHEMA IF EXISTS backfill_test CASCADE');
    client.release();
    await pool.end();
  });

  it('[D-005 AC-12] 既有 per_person 列套用 0002 後 backfill：price_mode=per_person、venue_fee=NULL；index/CHECK 不變', async () => {
    // 1. 僅套用 0001（舊 schema，events 無計費欄）。
    await client.query(readFileSync(join(migrations, '0001_init.sql'), 'utf8'));
    const h = await client.query<{ id: number }>(
      `INSERT INTO users (line_user_id, display_name, is_host, created_at, updated_at)
       VALUES ('U-old', '舊主辦', 0, $1, $1) RETURNING id`,
      [NOW],
    );
    const hostId = h.rows[0]!.id;
    // 舊 schema 直接插入一場 open 活動（無 price_mode 欄）。
    await client.query(
      `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, status, created_at, updated_at)
       VALUES ('G-old', $1, '2026-08-15', '07:30', '東方球場', 16, 2200, 'open', $2, $2)`,
      [hostId, NOW],
    );

    // 2. 套用 0002（ALTER TABLE ADD COLUMN，backfill DEFAULT）。
    await client.query(readFileSync(join(migrations, '0002_billing_modes.sql'), 'utf8'));

    // 3. 既有列被 backfill 為 per_person / NULL。
    const row = await client.query<{
      price_mode: string;
      venue_fee: number | null;
      settled_per_person: number | null;
      price_per_person: number;
    }>(`SELECT * FROM events WHERE group_id = 'G-old'`);
    expect(row.rows[0]!.price_mode).toBe('per_person');
    expect(row.rows[0]!.venue_fee).toBeNull();
    expect(row.rows[0]!.settled_per_person).toBeNull();
    expect(row.rows[0]!.price_per_person).toBe(2200); // 既有金額不動（零回歸）

    // 4. ux_events_active_group 仍在（同群第二場 active 被拒）。
    await expect(
      client.query(
        `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, price_mode, venue_fee, status, created_at, updated_at)
         VALUES ('G-old', $1, '2026-09-01', '08:00', 'Y', 8, 0, 'per_person', NULL, 'draft', $2, $2)`,
        [hostId, NOW],
      ),
    ).rejects.toThrow(/unique/i);

    // 5. price_mode CHECK 生效（非法值被拒）。
    await expect(
      client.query(
        `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, price_mode, venue_fee, status, created_at, updated_at)
         VALUES ('G-chk', $1, '2026-09-01', '08:00', 'Y', 8, 0, 'bogus', NULL, 'draft', $2, $2)`,
        [hostId, NOW],
      ),
    ).rejects.toThrow(/check/i);

    // 6. status CHECK 仍為原 5 值（未被 0002 觸碰）——查 events 的 CHECK 約束定義涵蓋 5 個狀態。
    const defs = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'backfill_test' AND rel.relname = 'events' AND c.contype = 'c'`,
    );
    const allDefs = defs.rows.map((r) => r.def).join(' | ');
    for (const status of ['draft', 'open', 'closed', 'cancelled', 'done']) {
      expect(allDefs).toContain(`'${status}'`);
    }
  });
});
