import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../__tests__/test-db';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('ProcessedEventRepository', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-001 AC-7] 同一 message_id 連續兩次，第二次影響 0 列而略過', () => {
    const firstNew = t.processed.markProcessed('msg-1');
    const secondNew = t.processed.markProcessed('msg-1');
    expect(firstNew).toBe(true);
    expect(secondNew).toBe(false);
    expect(t.processed.has('msg-1')).toBe(true);

    const count = t.db
      .prepare('SELECT COUNT(*) AS n FROM processed_events WHERE message_id = ?')
      .get('msg-1') as { n: number };
    expect(count.n).toBe(1);
  });

  it('[D-001 AC-7] 去重擋掉重複副作用：第二次不產生重複有效 registrations', () => {
    // 補強：把 markProcessed 當作報名副作用的守門——重複 message_id 不得再報名一次。
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-dedup' });
    const member = t.users.upsert('U-dd', '阿明');

    const handleRegisterOnce = (messageId: string): void => {
      if (!t.processed.markProcessed(messageId)) return; // 已處理 → 略過副作用
      t.registrations.runImmediate(() =>
        t.registrations.insertSlots(
          { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
          1,
        ),
      );
    };

    handleRegisterOnce('msg-reg');
    handleRegisterOnce('msg-reg'); // 同一事件重送

    expect(t.registrations.countConfirmed(event.id)).toBe(1); // 只報名一次
  });

  it('[D-001 AC-13] created_at 為 UTC ISO-8601', () => {
    t.processed.markProcessed('msg-iso');
    const row = t.db
      .prepare('SELECT created_at FROM processed_events WHERE message_id = ?')
      .get('msg-iso') as { created_at: string };
    expect(row.created_at).toMatch(ISO_RE);
  });
});
