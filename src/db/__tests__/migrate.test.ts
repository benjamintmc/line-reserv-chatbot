import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from './test-db';
import { createPool } from '../index';
import type { SchemaMigrationRow } from '../schema';
import { runMigrations } from '../migrate';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TEST_URL = process.env.DATABASE_URL_TEST ?? 'postgres://golf:golf@localhost:5433/golf_test';

describe('migrate runner + schema 約束（PG）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-001 AC-13] migration 追蹤表記錄 version 與 ISO applied_at', async () => {
    const res = await t.pool.query<SchemaMigrationRow>(
      'SELECT * FROM schema_migrations ORDER BY version',
    );
    expect(res.rows.map((r) => r.version)).toContain('0001_init');
    for (const r of res.rows) {
      expect(r.applied_at).toMatch(ISO_RE);
    }
  });

  it('[D-007 AC-5 / D-008 AC-8] migrate 冪等：再次執行不重複套用（含 0003，applied 空、skipped 全部）', async () => {
    const client = await t.pool.connect();
    try {
      const result = await runMigrations(client);
      expect(result.applied).toHaveLength(0);
      expect(result.skipped).toContain('0001_init');
      expect(result.skipped).toContain('0002_billing_modes');
      // D-008：新增獨立 0003（合併 event_datetime + 重定義 ux_events_active_group）。
      expect(result.skipped).toContain('0003_merge_event_datetime');
      // D-013 T-022：0004（conversation_states 改複合 PK）。
      expect(result.skipped).toContain('0004_conversation_scope_pk');
    } finally {
      client.release();
    }
    const count = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM schema_migrations');
    expect(Number(count.rows[0]!.n)).toBe(4);
  });

  it('[D-007 AC-5] 建表等義：5 表 + schema_migrations 齊備、partial unique index 存在', async () => {
    const tables = await t.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = new Set(tables.rows.map((r) => r.table_name));
    for (const expected of [
      'users',
      'events',
      'registrations',
      'conversation_states',
      'processed_events',
      'schema_migrations',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    const idx = await t.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const idxNames = new Set(idx.rows.map((r) => r.indexname));
    for (const expected of [
      'ux_events_active_group',
      'ux_reg_event_seq',
      'ix_reg_active',
      'ix_reg_active_owner',
      'ix_events_group_status',
      'ux_users_line_user_id',
    ]) {
      expect(idxNames.has(expected)).toBe(true);
    }
  });

  it('[D-008 AC-8] 0003 後 events 有 event_datetime（NOT NULL）、無 event_date/event_time；ux predicate = {draft,open}', async () => {
    // event_datetime 存在且 NOT NULL。
    const cols = await t.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'events'`,
    );
    const colMap = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));
    expect(colMap.get('event_datetime')).toBe('NO'); // NOT NULL
    expect(colMap.has('event_date')).toBe(false); // 已 drop
    expect(colMap.has('event_time')).toBe(false); // 已 drop
    // ux_events_active_group 的 predicate 已移除 closed。
    const idxdef = await t.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_events_active_group'`,
    );
    const def = idxdef.rows[0]!.indexdef;
    expect(def).toMatch(/status = ANY|draft.*open|status IN/); // 含 draft/open
    expect(def).not.toContain('closed'); // closed 已移除（釋放條件 a）
  });

  it('[D-001 AC-9] 同 group 第二場 active（draft）被 ux_events_active_group 拒絕（PG 23505）', async () => {
    const { host } = await seedEvent(t, { capacity: 4, groupId: 'G-dup' });
    // 同 group 已有一場 open（active），再建一場 draft（亦 active）→ 唯一約束拒絕。
    await expect(
      t.events.create({
        groupId: 'G-dup',
        hostUserId: host.id,
        eventDatetime: '2026-09-01T00:00:00Z',
        location: '大溪高球場',
        capacity: 4,
        status: 'draft',
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('[D-001 AC-9 / D-008 AC-1] closed 已釋放：closed 旁可再開一場 open（不擋團）', async () => {
    // D-008 反轉：closed 移出 active 集合 → 不再擋新開團（原「closed 亦屬 active」失效）。
    const { host, event } = await seedEvent(t, { capacity: 4, groupId: 'G-closed' });
    await t.events.updateStatus(event.id, 'closed'); // closed 已離開 active 集合
    const next = await t.events.create({
      groupId: 'G-closed',
      hostUserId: host.id,
      eventDatetime: '2026-09-01T00:00:00Z',
      location: '大溪高球場',
      capacity: 4,
      status: 'open',
    });
    expect(next.id).toBeGreaterThan(event.id);
    // findActiveByGroup 只回 open（closed 不在集合）；顯示集 latest-by-id 取較新 open。
    expect((await t.events.findActiveByGroup('G-closed'))?.id).toBe(next.id);
    expect((await t.events.findLatestDisplayable('G-closed'))?.id).toBe(next.id);
  });

  it('[D-001 AC-9] 原活動轉終態後，同 group 可再建 active', async () => {
    const { host, event } = await seedEvent(t, { capacity: 4, groupId: 'G-reuse' });
    await t.events.updateStatus(event.id, 'cancelled'); // 離開 active 集合
    const next = await t.events.create({
      groupId: 'G-reuse',
      hostUserId: host.id,
      eventDatetime: '2026-09-01T00:00:00Z',
      location: '大溪高球場',
      capacity: 4,
      status: 'open',
    });
    expect(next.id).toBeGreaterThan(event.id);
    expect((await t.events.findActiveByGroup('G-reuse'))?.id).toBe(next.id);
  });

  it('[D-001 AC-10] capacity=0 違反 CHECK 被拒', async () => {
    const host = await t.users.upsert('U-h', '主辦');
    await expect(
      t.events.create({
        groupId: 'G-cap0',
        hostUserId: host.id,
        eventDatetime: '2026-07-31T23:30:00Z',
        location: 'X',
        capacity: 0,
      }),
    ).rejects.toThrow(/check/i);
  });

  it('[D-001 AC-10] price_per_person<0 違反 CHECK 被拒', async () => {
    // 補強：金額非負 CHECK（G8）。
    const host = await t.users.upsert('U-hp', '主辦');
    await expect(
      t.events.create({
        groupId: 'G-price',
        hostUserId: host.id,
        eventDatetime: '2026-07-31T23:30:00Z',
        location: 'X',
        capacity: 4,
        pricePerPerson: -1,
      }),
    ).rejects.toThrow(/check/i);
  });

  it('[D-001 AC-10] 非法 status / kind 違反 CHECK 被拒（raw insert）', async () => {
    const { event, host } = await seedEvent(t, { capacity: 2, groupId: 'G-chk' });
    await expect(
      t.pool.query(
        `INSERT INTO events (group_id, host_user_id, event_datetime, location, capacity, price_per_person, status, created_at, updated_at)
         VALUES ('G-x', $1, '2026-08-14T23:30:00Z', 'X', 1, 0, 'foo', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
        [host.id],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      t.pool.query(
        `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
         VALUES ($1, $2, 'A', 'x', 'confirmed', 1, '2026-08-01T00:00:00Z')`,
        [event.id, host.id],
      ),
    ).rejects.toThrow(/check/i);
    // 補強：非法 registrations.status 亦被 CHECK 拒。
    await expect(
      t.pool.query(
        `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
         VALUES ($1, $2, 'A', 'self', 'bogus', 2, '2026-08-01T00:00:00Z')`,
        [event.id, host.id],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('[D-001 AC-10] 缺 FK 對象的 event_id 違反 FK 被拒', async () => {
    const host = await t.users.upsert('U-fk', '主辦');
    await expect(
      t.pool.query(
        `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
         VALUES (999999, $1, 'A', 'self', 'confirmed', 1, '2026-08-01T00:00:00Z')`,
        [host.id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('[D-001 AC-11] 同 event 重複 seq 被 UNIQUE 拒；取消列仍佔用其 seq', async () => {
    const { event, host } = await seedEvent(t, { capacity: 4, groupId: 'G-seq' });
    const [row] = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'A', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    const occupied = row!.seq;
    const rawInsertSameSeq = (): Promise<unknown> =>
      t.pool.query(
        `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
         VALUES ($1, $2, 'B', 'self', 'confirmed', $3, '2026-08-01T00:00:00Z')`,
        [event.id, host.id, occupied],
      );
    await expect(rawInsertSameSeq()).rejects.toThrow(/unique/i);
    // 取消該列後，其 seq 仍被佔用，無法重用。
    await t.runImmediate(event.id, (repos) => repos.registrations.cancelByIds([row!.id], host.id));
    await expect(rawInsertSameSeq()).rejects.toThrow(/unique/i);
  });

  it('[D-001 AC-11] 取消列的 seq 不被下一筆 insertSlot 回填或重用', async () => {
    // 補強：nextSeq 以含已取消列的 MAX(seq)+1 指派，取消後新報名 seq 只增不減。
    const { event, host } = await seedEvent(t, { capacity: 4, groupId: 'G-seq2' });
    const [r1] = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'A', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    await t.runImmediate(event.id, (repos) => repos.registrations.cancelByIds([r1!.id], host.id));
    const [r2] = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'B', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    expect(r2!.seq).toBeGreaterThan(r1!.seq); // 不回填被取消列的 seq
  });

  it('[D-001 AC-6] 資料完整保留：另開連線讀回已提交列（含取消稽核）', async () => {
    const { event } = await seedEvent(t, { capacity: 3, groupId: 'G-persist' });
    const member = await t.users.upsert('U-m', '阿明');
    const rows = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
        2,
      ),
    );
    await t.runImmediate(event.id, (repos) =>
      repos.registrations.cancelByIds([rows[0]!.id], member.id),
    );

    // 模擬重啟：另開一個獨立連線池讀回同一 DB 的已提交資料。
    const pool2 = createPool(TEST_URL);
    try {
      const confirmed = await pool2.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1 AND status = 'confirmed' AND cancelled_at IS NULL`,
        [event.id],
      );
      expect(Number(confirmed.rows[0]!.n)).toBe(1);
      const cancelled = await pool2.query<{ cancelled_by_user_id: number }>(
        'SELECT cancelled_by_user_id FROM registrations WHERE cancelled_at IS NOT NULL',
      );
      expect(cancelled.rows).toHaveLength(1);
      expect(cancelled.rows[0]!.cancelled_by_user_id).toBe(member.id);
    } finally {
      await pool2.end();
    }
  });

  it('G9：registrations 由 events ON DELETE CASCADE 清除（唯一允許的實體刪除）', async () => {
    // 守門：取消一律 soft-delete；schema 內唯一允許的 registrations 實體刪除是 events CASCADE。
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G-cascade' });
    const member = await t.users.upsert('U-cas', '阿明');
    const rows = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
        2,
      ),
    );
    expect(rows).toHaveLength(2);
    // 物理刪除 event 列 → registrations 連帶被 CASCADE 清除。
    await t.pool.query('DELETE FROM events WHERE id = $1', [event.id]);
    const remaining = await t.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1',
      [event.id],
    );
    expect(Number(remaining.rows[0]!.n)).toBe(0);
  });

  it('G11：schema 時間欄不使用 DEFAULT CURRENT_TIMESTAMP（時間戳由應用層寫入）', async () => {
    // 守門：時間欄 column_default 須為 NULL（不得 now()/CURRENT_TIMESTAMP，否則產生非 ISO 格式）。
    const cols = await t.pool.query<{ table_name: string; column_name: string; column_default: string | null }>(
      `SELECT table_name, column_name, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('created_at', 'updated_at', 'cancelled_at', 'applied_at')`,
    );
    expect(cols.rows.length).toBeGreaterThan(0);
    for (const c of cols.rows) {
      expect(c.column_default).toBeNull();
    }
  });
});
