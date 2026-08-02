import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../__tests__/test-db';

/** D-003 §四新增原語 findActiveProxyByName（跨 owner 代報定位，主辦人代取消用）。 */
describe('RegistrationRepository.findActiveProxyByName', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-003 AC-17] 跨 owner 定位同名代報有效列，依 seq 升冪；不含 self、不含已取消', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G' });
    const a = await t.users.upsert('U-a', 'A');
    const b = await t.users.upsert('U-b', 'B');

    const insert = (owner: number, name: string, kind: 'self' | 'proxy'): Promise<number> =>
      t.runImmediate(event.id, async (repos) => {
        const row = await repos.registrations.insertSlot({
          eventId: event.id,
          ownerUserId: owner,
          displayName: name,
          kind,
          status: 'confirmed',
        });
        return row.id;
      });

    const aChen = await insert(a.id, '陳大哥', 'proxy');
    const bChen = await insert(b.id, '陳大哥', 'proxy');
    await insert(a.id, '陳大哥', 'self'); // self 同名不應納入
    await insert(a.id, '林小姐', 'proxy'); // 不同名不應納入

    const rows = await t.registrations.findActiveProxyByName(event.id, '陳大哥');
    expect(rows.map((r) => r.id)).toEqual([aChen, bChen]); // seq 升冪、跨 owner
    expect(rows.every((r) => r.kind === 'proxy')).toBe(true);

    // 取消 aChen 後不再列入。
    await t.runImmediate(event.id, (repos) => repos.registrations.cancelByIds([aChen], a.id));
    expect((await t.registrations.findActiveProxyByName(event.id, '陳大哥')).map((r) => r.id)).toEqual([
      bChen,
    ]);
  });

  it('[D-003 AC-18] 無相符代報名字 → 回空陣列', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G' });
    expect(await t.registrations.findActiveProxyByName(event.id, '不存在')).toHaveLength(0);
  });
});
