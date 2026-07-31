import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../index';
import { EventRepository } from './event-repository';
import { UserRepository } from './user-repository';
import { createTestDb, type TestDb } from '../__tests__/test-db';

describe('EventRepository 計費一致性（D-005 §1.3 / G4）', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-005 AC-13] split_venue → venue_fee=3000、price_per_person=0', () => {
    const host = t.users.upsert('U-h', '主辦');
    const row = t.events.create({
      groupId: 'G-split',
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
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

  it('[D-005 AC-13] per_person → venue_fee=NULL、price_per_person=2200', () => {
    const host = t.users.upsert('U-h', '主辦');
    const row = t.events.create({
      groupId: 'G-pp',
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
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

  it('[D-005 AC-13] 預設 priceMode 為 per_person（回歸；venue_fee=NULL）', () => {
    const host = t.users.upsert('U-h', '主辦');
    const row = t.events.create({
      groupId: 'G-def',
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
      location: '東方球場',
      capacity: 16,
      pricePerPerson: 1800,
      status: 'open',
    });
    expect(row.price_mode).toBe('per_person');
    expect(row.venue_fee).toBeNull();
  });

  it('[D-005 AC-13] 不一致組合被邊界層拒絕（split 缺/≤0 venue_fee、per_person 帶 venue_fee）', () => {
    const host = t.users.upsert('U-h', '主辦');
    const base = {
      groupId: 'G-bad',
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
      location: '東方球場',
      capacity: 16,
      status: 'open' as const,
    };
    // split 缺 venue_fee
    expect(() => t.events.create({ ...base, priceMode: 'split_venue' })).toThrow(/venue_fee/);
    // split venue_fee<=0
    expect(() => t.events.create({ ...base, priceMode: 'split_venue', venueFee: 0 })).toThrow(/venue_fee/);
    // per_person 帶 venue_fee
    expect(() =>
      t.events.create({ ...base, priceMode: 'per_person', pricePerPerson: 2200, venueFee: 5000 }),
    ).toThrow(/venue_fee/);
  });

  it('[D-005 AC-13] settled_per_person 由 updateSettledPerPerson 寫入（split close）', () => {
    const host = t.users.upsert('U-h', '主辦');
    const row = t.events.create({
      groupId: 'G-set',
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
      location: '東方球場',
      capacity: 16,
      priceMode: 'split_venue',
      venueFee: 3000,
      status: 'open',
    });
    expect(t.events.updateSettledPerPerson(row.id, 429)).toBe(1);
    expect(t.events.getById(row.id)?.settled_per_person).toBe(429);
  });
});

describe('migration 0002 backfill（D-005 §1.2 / AC-12 / G7 / G8）', () => {
  let dir: string;
  let db: Db;
  const migrations = join(__dirname, '..', 'migrations');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'golf-0002-'));
    db = openDb(join(dir, 'test.db'));
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[D-005 AC-12] 既有 per_person 列套用 0002 後 backfill：price_mode=per_person、venue_fee=NULL；index/CHECK 不變', () => {
    // 1. 僅套用 0001（舊 schema，events 無計費欄）。
    db.exec(readFileSync(join(migrations, '0001_init.sql'), 'utf8'));
    const users = new UserRepository(db);
    const host = users.upsert('U-old', '舊主辦');
    // 舊 schema 直接插入一場 open 活動（無 price_mode 欄）。
    db.prepare(
      `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, status, created_at, updated_at)
       VALUES ('G-old', ?, '2026-08-15', '07:30', '東方球場', 16, 2200, 'open', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    ).run(host.id);

    // 2. 套用 0002（ALTER TABLE ADD COLUMN，backfill DEFAULT）。
    db.exec(readFileSync(join(migrations, '0002_billing_modes.sql'), 'utf8'));

    // 3. 既有列被 backfill 為 per_person / NULL。
    const events = new EventRepository(db);
    const row = events.findActiveByGroup('G-old');
    expect(row?.price_mode).toBe('per_person');
    expect(row?.venue_fee).toBeNull();
    expect(row?.settled_per_person).toBeNull();
    expect(row?.price_per_person).toBe(2200); // 既有金額不動（零回歸）

    // 4. ux_events_active_group 仍在（同群第二場 active 被拒）。
    expect(() =>
      db.prepare(
        `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, price_mode, venue_fee, status, created_at, updated_at)
         VALUES ('G-old', ?, '2026-09-01', '08:00', 'Y', 8, 0, 'per_person', NULL, 'draft', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
      ).run(host.id),
    ).toThrow(/UNIQUE/i);

    // 5. price_mode CHECK 生效（非法值被拒）。
    expect(() =>
      db.prepare(
        `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, price_mode, venue_fee, status, created_at, updated_at)
         VALUES ('G-chk', ?, '2026-09-01', '08:00', 'Y', 8, 0, 'bogus', NULL, 'draft', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
      ).run(host.id),
    ).toThrow(/CHECK/i);

    // 6. status CHECK 仍為原 5 值（未被 0002 觸碰）。
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`).get() as { sql: string }).sql;
    expect(ddl).toContain("status IN ('draft', 'open', 'closed', 'cancelled', 'done')");
  });
});
