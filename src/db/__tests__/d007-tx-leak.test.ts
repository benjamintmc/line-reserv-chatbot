import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from './test-db';

// 覆蓋缺口補強（unit-tester，T-012 覆核）：交易 runner 的連線洩漏防治。
// 移植常見靜默 bug：work 拋錯時若未於 finally release() checked-out client，
// pool（max=2）在數次失敗交易後即耗盡，後續 connect() 永久阻塞（prod 表現為 hang / 逾時）。
// tx.ts withTransaction 於 finally 內 release，本測試以「多於 pool.max 筆失敗交易後仍可正常查詢」把關。

describe('D-007 交易 runner 連線洩漏防治（ROLLBACK 路徑 release）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-007 AC-7] runImmediate work 連續拋錯（> pool.max 次）後 pool 不耗盡、仍可交易（無連線洩漏）', async () => {
    const { event, host } = await seedEvent(t, { capacity: 4, groupId: 'G-leak' });
    // pool max=2；跑 5 筆會拋錯的交易。若 ROLLBACK 路徑未 release，第 3 筆起 connect() 即阻塞 → 逾時。
    for (let i = 0; i < 5; i += 1) {
      await expect(
        t.runImmediate(event.id, async () => {
          throw new Error(`boom-${i}`);
        }),
      ).rejects.toThrow(`boom-${i}`);
    }
    // pool 未洩漏 → 後續正常交易仍可 checkout client 並提交。
    const [reg] = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'H', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    expect(reg!.id).toBeGreaterThan(0);
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
    // 失敗交易均已 ROLLBACK：無任何殘留寫入（只有最後一筆成功的）。
    const all = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1', [event.id]);
    expect(Number(all.rows[0]!.n)).toBe(1);
  });

  it('[D-007 AC-7] runInTransaction work 連續拋錯後 pool 不耗盡（DEFERRED 路徑同守 release）', async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(
        t.runInTransaction(async () => {
          throw new Error(`boom-tx-${i}`);
        }),
      ).rejects.toThrow(`boom-tx-${i}`);
    }
    const r = await t.runInTransaction(async (repos) => repos.processed.markProcessed('after-leak'));
    expect(r).toBe(true);
  });
});
