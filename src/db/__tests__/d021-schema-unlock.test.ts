import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from './test-db';

/**
 * D-021 §1／§2（T-033a）：0006 解除「同群至多一場 active」的 DB 硬限制。
 *
 * **驗證層級為 repository 層**（AC-2 明文）：T-033a 期間開團側仍拒第二場（D-020 不變式 #1），
 * 走 `開團` 流程構造第二場必然假紅，故一律以連續 `events.create` 兩列構造。
 */
describe('D-021 schema 解鎖與 EventReader（T-033a）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-021 AC-1] 0006 後：舊索引不存在；新索引 predicate/欄位正確；message_event_map 齊備', async () => {
    const idx = await t.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const idxNames = new Set(idx.rows.map((r) => r.indexname));

    // (1) 舊的「同群至多一場」索引已 DROP。
    expect(idxNames.has('ux_events_active_group')).toBe(false);

    // (2) 新索引存在，且 pg_get_indexdef 顯示欄位為 (group_id, location, event_datetime)、
    //     predicate 為 status IN ('draft','open')。
    expect(idxNames.has('ux_events_active_group_venue_time')).toBe(true);
    const def = await t.pool.query<{ def: string }>(
      `SELECT pg_get_indexdef(c.oid) AS def
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'ux_events_active_group_venue_time'`,
    );
    const indexdef = def.rows[0]!.def;
    expect(indexdef).toContain('UNIQUE');
    expect(indexdef).toMatch(/\(group_id, location, event_datetime\)/);
    expect(indexdef).toContain('draft');
    expect(indexdef).toContain('open');
    expect(indexdef).not.toContain('closed');

    // (3) message_event_map：message_id 為 PK、event_id 有 FK 指向 events(id)、輔助索引存在。
    const tbl = await t.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'message_event_map'`,
    );
    expect(tbl.rows).toHaveLength(1);

    const pk = await t.pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = 'message_event_map'
          AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(pk.rows.map((r) => r.column_name)).toEqual(['message_id']);

    const fk = await t.pool.query<{ column_name: string; foreign_table: string; foreign_column: string }>(
      `SELECT kcu.column_name,
              ccu.table_name  AS foreign_table,
              ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = 'message_event_map'
          AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(fk.rows).toHaveLength(1);
    expect(fk.rows[0]!.column_name).toBe('event_id');
    expect(fk.rows[0]!.foreign_table).toBe('events');
    expect(fk.rows[0]!.foreign_column).toBe('id');

    expect(idxNames.has('ix_message_event_map_event')).toBe(true);
  });

  it('[D-021 AC-2] 同群多場並存：場地或時間不同的兩場皆成功；listActiveByGroup 回兩列且依 id 升冪', async () => {
    // **repository 層**構造（連續 events.create 兩列）——非 `開團` 流程：依 D-020 不變式 #1，
    // T-033a 期間開團側仍拒第二場。
    const { host, event: a } = await seedEvent(t, { capacity: 8, groupId: 'G-multi' });
    expect(a.status).toBe('open');

    // (a) 同場地、不同時間 → 成功。
    const b = await t.events.create({
      groupId: 'G-multi',
      hostUserId: host.id,
      eventDatetime: '2999-02-02T00:00:00Z',
      location: a.location,
      capacity: 8,
      status: 'open',
    });
    expect(b.status).toBe('open');

    // (b) 同時間、不同場地 → 亦成功。
    const c = await t.events.create({
      groupId: 'G-multi',
      hostUserId: host.id,
      eventDatetime: a.event_datetime,
      location: '大溪高球場',
      capacity: 8,
      status: 'open',
    });
    expect(c.status).toBe('open');

    // 三場 open 並存於同一群。
    const openRows = await t.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM events WHERE group_id = 'G-multi' AND status = 'open'",
    );
    expect(Number(openRows.rows[0]!.n)).toBe(3);

    // listActiveByGroup 回全部三列，且**依 id 升冪**——此斷言是 D-021 §1 過渡條文
    // 「開團側取 actives.at(-1)（最新一場）」的保護網：若 SQL 誤寫成 ORDER BY id DESC，
    // 取末列會靜默取到最舊一場。
    const actives = await t.events.listActiveByGroup('G-multi');
    expect(actives.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    expect(actives[0]!.id).toBeLessThan(actives[1]!.id);
    expect(actives[1]!.id).toBeLessThan(actives[2]!.id);
    expect(actives.at(-1)!.id).toBe(c.id); // 末列 = id 最大者 = 最新一場
  });
});
