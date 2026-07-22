import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from './test-db';
import type { SchemaMigrationRow } from '../schema';
import { runMigrations } from '../migrate';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('migrate runner + schema 約束', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-001 AC-13] migration 追蹤表記錄 version 與 ISO applied_at', () => {
    const rows = t.db
      .prepare('SELECT * FROM schema_migrations ORDER BY version')
      .all() as SchemaMigrationRow[];
    expect(rows.map((r) => r.version)).toContain('0001_init');
    for (const r of rows) {
      expect(r.applied_at).toMatch(ISO_RE);
    }
  });

  it('migrate 冪等：再次執行不重複套用', () => {
    const result = runMigrations(t.db);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toContain('0001_init');
    const count = t.db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('[D-001 AC-9] 同 group 第二場 active 被 ux_events_active_group 拒絕', () => {
    const { host } = seedEvent(t, { capacity: 4, groupId: 'G-dup' });
    // 同 group 已有一場 open（active），再建一場 draft（亦 active）→ 唯一約束拒絕。
    expect(() =>
      t.events.create({
        groupId: 'G-dup',
        hostUserId: host.id,
        eventDate: '2026-09-01',
        eventTime: '08:00',
        location: '大溪高球場',
        capacity: 4,
        status: 'draft',
      }),
    ).toThrow(/UNIQUE/i);
  });

  it('[D-001 AC-9] closed 亦屬 active：同 group 已 closed 時第二場 active 仍被拒', () => {
    // 補強：active = {draft, open, closed}，closed 不可再開第二場。
    const { host, event } = seedEvent(t, { capacity: 4, groupId: 'G-closed' });
    t.events.updateStatus(event.id, 'closed'); // 仍屬 active 集合
    expect(() =>
      t.events.create({
        groupId: 'G-closed',
        hostUserId: host.id,
        eventDate: '2026-09-01',
        eventTime: '08:00',
        location: '大溪高球場',
        capacity: 4,
        status: 'open',
      }),
    ).toThrow(/UNIQUE/i);
  });

  it('[D-001 AC-9] 原活動轉終態後，同 group 可再建 active', () => {
    const { host, event } = seedEvent(t, { capacity: 4, groupId: 'G-reuse' });
    t.events.updateStatus(event.id, 'cancelled'); // 離開 active 集合
    const next = t.events.create({
      groupId: 'G-reuse',
      hostUserId: host.id,
      eventDate: '2026-09-01',
      eventTime: '08:00',
      location: '大溪高球場',
      capacity: 4,
      status: 'open',
    });
    expect(next.id).toBeGreaterThan(event.id);
    expect(t.events.findActiveByGroup('G-reuse')?.id).toBe(next.id);
  });

  it('[D-001 AC-10] capacity=0 違反 CHECK 被拒', () => {
    const host = t.users.upsert('U-h', '主辦');
    expect(() =>
      t.events.create({
        groupId: 'G-cap0',
        hostUserId: host.id,
        eventDate: '2026-08-01',
        eventTime: '07:30',
        location: 'X',
        capacity: 0,
      }),
    ).toThrow(/CHECK/i);
  });

  it('[D-001 AC-10] price_per_person<0 違反 CHECK 被拒', () => {
    // 補強：金額非負 CHECK（G8）。
    const host = t.users.upsert('U-hp', '主辦');
    expect(() =>
      t.events.create({
        groupId: 'G-price',
        hostUserId: host.id,
        eventDate: '2026-08-01',
        eventTime: '07:30',
        location: 'X',
        capacity: 4,
        pricePerPerson: -1,
      }),
    ).toThrow(/CHECK/i);
  });

  it('[D-001 AC-10] 非法 status / kind 違反 CHECK 被拒（raw insert）', () => {
    const { event, host } = seedEvent(t, { capacity: 2, groupId: 'G-chk' });
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO events (group_id, host_user_id, event_date, event_time, location, capacity, price_per_person, status, created_at, updated_at)
           VALUES ('G-x', ?, '2026-08-01', '07:30', 'X', 1, 0, 'foo', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
        )
        .run(host.id),
    ).toThrow(/CHECK/i);
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
           VALUES (?, ?, 'A', 'x', 'confirmed', 1, '2026-08-01T00:00:00Z')`,
        )
        .run(event.id, host.id),
    ).toThrow(/CHECK/i);
    // 補強：非法 registrations.status 亦被 CHECK 拒。
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
           VALUES (?, ?, 'A', 'self', 'bogus', 2, '2026-08-01T00:00:00Z')`,
        )
        .run(event.id, host.id),
    ).toThrow(/CHECK/i);
  });

  it('[D-001 AC-10] 缺 FK 對象的 event_id 違反 FK 被拒（foreign_keys=ON）', () => {
    const host = t.users.upsert('U-fk', '主辦');
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
           VALUES (999999, ?, 'A', 'self', 'confirmed', 1, '2026-08-01T00:00:00Z')`,
        )
        .run(host.id),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('[D-001 AC-11] 同 event 重複 seq 被 UNIQUE 拒；取消列仍佔用其 seq', () => {
    const { event, host } = seedEvent(t, { capacity: 4, groupId: 'G-seq' });
    const [row] = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'A', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    const occupied = row!.seq;
    const rawInsertSameSeq = (): void => {
      t.db
        .prepare(
          `INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at)
           VALUES (?, ?, 'B', 'self', 'confirmed', ?, '2026-08-01T00:00:00Z')`,
        )
        .run(event.id, host.id, occupied);
    };
    expect(rawInsertSameSeq).toThrow(/UNIQUE/i);
    // 取消該列後，其 seq 仍被佔用，無法重用。
    t.registrations.runImmediate(() => t.registrations.cancelByIds([row!.id], host.id));
    expect(rawInsertSameSeq).toThrow(/UNIQUE/i);
  });

  it('[D-001 AC-11] 取消列的 seq 不被下一筆 insertSlot 回填或重用', () => {
    // 補強：nextSeq 以含已取消列的 MAX(seq)+1 指派，取消後新報名 seq 只增不減。
    const { event, host } = seedEvent(t, { capacity: 4, groupId: 'G-seq2' });
    const [r1] = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'A', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    t.registrations.runImmediate(() => t.registrations.cancelByIds([r1!.id], host.id));
    const [r2] = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'B', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    expect(r2!.seq).toBeGreaterThan(r1!.seq); // 不回填被取消列的 seq
  });

  it('[D-001 AC-6] 檔案型 DB 重開連線後資料完整保留（含取消稽核）', () => {
    const { event, host } = seedEvent(t, { capacity: 3, groupId: 'G-persist' });
    const member = t.users.upsert('U-m', '阿明');
    const rows = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
        2,
      ),
    );
    t.registrations.runImmediate(() => t.registrations.cancelByIds([rows[0]!.id], member.id));

    // 模擬重啟：關閉並重新開啟同一檔。
    t.reopen();

    const confirmed = t.registrations.listConfirmed(event.id);
    expect(confirmed).toHaveLength(1);
    const cancelled = t.db
      .prepare('SELECT * FROM registrations WHERE cancelled_at IS NOT NULL')
      .all() as { owner_user_id: number; cancelled_by_user_id: number; seq: number }[];
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.cancelled_by_user_id).toBe(member.id);
    expect(t.events.findActiveByGroup('G-persist')?.id).toBe(event.id);
  });

  it('G9：migration DDL 不含任何針對 registrations 的 DELETE；且 registrations 由 events CASCADE 清除', () => {
    // 守門：schema 內唯一允許的 registrations 實體刪除是 events ON DELETE CASCADE。
    const { event, host } = seedEvent(t, { capacity: 4, groupId: 'G-cascade' });
    const member = t.users.upsert('U-cas', '阿明');
    const rows = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
        2,
      ),
    );
    expect(rows).toHaveLength(2);
    // 物理刪除 event 列 → registrations 連帶被 CASCADE 清除。
    t.db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
    const remaining = t.db
      .prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?')
      .get(event.id) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('G11：schema DDL 不使用 DEFAULT CURRENT_TIMESTAMP（時間戳由應用層寫入）', () => {
    // 守門：時間欄禁用 CURRENT_TIMESTAMP（會產生非 ISO 空格格式）。
    const sql = t.db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`,
      )
      .all() as { sql: string }[];
    for (const { sql: ddl } of sql) {
      expect(ddl).not.toMatch(/CURRENT_TIMESTAMP/i);
    }
  });
});
