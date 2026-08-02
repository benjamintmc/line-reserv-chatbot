import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../__tests__/test-db';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('ProcessedEventRepository', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-001 AC-7] 同一 message_id 連續兩次，第二次影響 0 列而略過', async () => {
    const firstNew = await t.processed.markProcessed('msg-1');
    const secondNew = await t.processed.markProcessed('msg-1');
    expect(firstNew).toBe(true);
    expect(secondNew).toBe(false);
    expect(await t.processed.has('msg-1')).toBe(true);

    const count = await t.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM processed_events WHERE message_id = $1',
      ['msg-1'],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it('[D-001 AC-7] 去重擋掉重複副作用：第二次不產生重複有效 registrations', async () => {
    // 補強：把 markProcessed 當作報名副作用的守門——重複 message_id 不得再報名一次。
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G-dedup' });
    const member = await t.users.upsert('U-dd', '阿明');

    const handleRegisterOnce = async (messageId: string): Promise<void> => {
      if (!(await t.processed.markProcessed(messageId))) return; // 已處理 → 略過副作用
      await t.runImmediate(event.id, (repos) =>
        repos.registrations.insertSlots(
          { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
          1,
        ),
      );
    };

    await handleRegisterOnce('msg-reg');
    await handleRegisterOnce('msg-reg'); // 同一事件重送

    expect(await t.registrations.countConfirmed(event.id)).toBe(1); // 只報名一次
  });

  it('[D-001 AC-13] created_at 為 UTC ISO-8601', async () => {
    await t.processed.markProcessed('msg-iso');
    const row = await t.pool.query<{ created_at: string }>(
      'SELECT created_at FROM processed_events WHERE message_id = $1',
      ['msg-iso'],
    );
    expect(row.rows[0]!.created_at).toMatch(ISO_RE);
  });
});
