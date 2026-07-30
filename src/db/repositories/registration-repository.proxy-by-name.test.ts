import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../__tests__/test-db';

/** D-003 §四新增原語 findActiveProxyByName（跨 owner 代報定位，主辦人代取消用）。 */
describe('RegistrationRepository.findActiveProxyByName', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-003 AC-17] 跨 owner 定位同名代報有效列，依 seq 升冪；不含 self、不含已取消', () => {
    const { event } = seedEvent(t, { capacity: 10, groupId: 'G' });
    const a = t.users.upsert('U-a', 'A');
    const b = t.users.upsert('U-b', 'B');

    const insert = (owner: number, name: string, kind: 'self' | 'proxy'): number =>
      t.registrations.runImmediate(
        () =>
          t.registrations.insertSlot({
            eventId: event.id,
            ownerUserId: owner,
            displayName: name,
            kind,
            status: 'confirmed',
          }).id,
      );

    const aChen = insert(a.id, '陳大哥', 'proxy');
    const bChen = insert(b.id, '陳大哥', 'proxy');
    insert(a.id, '陳大哥', 'self'); // self 同名不應納入
    insert(a.id, '林小姐', 'proxy'); // 不同名不應納入

    const rows = t.registrations.findActiveProxyByName(event.id, '陳大哥');
    expect(rows.map((r) => r.id)).toEqual([aChen, bChen]); // seq 升冪、跨 owner
    expect(rows.every((r) => r.kind === 'proxy')).toBe(true);

    // 取消 aChen 後不再列入。
    t.registrations.runImmediate(() => t.registrations.cancelByIds([aChen], a.id));
    expect(t.registrations.findActiveProxyByName(event.id, '陳大哥').map((r) => r.id)).toEqual([
      bChen,
    ]);
  });

  it('[D-003 AC-18] 無相符代報名字 → 回空陣列', () => {
    const { event } = seedEvent(t, { capacity: 10, groupId: 'G' });
    expect(t.registrations.findActiveProxyByName(event.id, '不存在')).toHaveLength(0);
  });
});
