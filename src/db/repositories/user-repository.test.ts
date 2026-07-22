import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../__tests__/test-db';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('UserRepository', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('upsert 以 line_user_id 為鍵：更新 display_name/updated_at，created_at 不變', () => {
    const first = t.users.upsert('U-1', '舊名');
    const again = t.users.upsert('U-1', '新名');
    expect(again.id).toBe(first.id); // 未新增列
    expect(again.display_name).toBe('新名');
    expect(again.created_at).toBe(first.created_at);
  });

  it('[D-001 AC-13] 新寫入 user 的 created_at/updated_at 為 UTC ISO-8601', () => {
    const u = t.users.upsert('U-iso', '甲');
    expect(u.created_at).toMatch(ISO_RE);
    expect(u.updated_at).toMatch(ISO_RE);
  });

  it('[D-001 AC-8] user 改名不回溯既有 registrations 的 display_name 快照', () => {
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-ac8' });
    const member = t.users.upsert('U-m', '原名');
    const [row] = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        {
          eventId: event.id,
          ownerUserId: member.id,
          displayName: member.display_name,
          kind: 'self',
          status: 'confirmed',
        },
        1,
      ),
    );
    // 模擬改名。
    const renamed = t.users.upsert('U-m', '改後名');
    expect(renamed.display_name).toBe('改後名');
    // registrations 快照維持報名當下值。
    expect(t.registrations.getById(row!.id)!.display_name).toBe('原名');
  });

  it('[D-001 AC-8] proxy 代報名快照亦不隨代報者改名而變動', () => {
    // 補強：proxy 列的 display_name 為輸入名字快照，與 owner 改名無關。
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-ac8b' });
    const messenger = t.users.upsert('U-proxy', '傳訊人原名');
    const [row] = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        {
          eventId: event.id,
          ownerUserId: messenger.id,
          displayName: '陳大哥',
          kind: 'proxy',
          status: 'confirmed',
        },
        1,
      ),
    );
    t.users.upsert('U-proxy', '傳訊人改名');
    expect(t.registrations.getById(row!.id)!.display_name).toBe('陳大哥');
  });
});
