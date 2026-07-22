import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../__tests__/test-db';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('ConversationRepository', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('upsert/get/delete 以 line_user_id 為鍵，updated_at 為 ISO', () => {
    const created = t.conversations.upsert({
      lineUserId: 'U-c',
      groupId: 'G-1',
      state: 'awaiting_date',
      payload: null,
    });
    expect(created.state).toBe('awaiting_date');
    expect(created.updated_at).toMatch(ISO_RE);

    const updated = t.conversations.upsert({
      lineUserId: 'U-c',
      groupId: 'G-1',
      state: 'awaiting_time',
      payload: JSON.stringify({ eventDate: '2026-08-01' }),
    });
    expect(updated.state).toBe('awaiting_time');
    expect(JSON.parse(updated.payload ?? '{}')).toEqual({ eventDate: '2026-08-01' });

    expect(t.conversations.delete('U-c')).toBe(true);
    expect(t.conversations.get('U-c')).toBeUndefined();
    expect(t.conversations.delete('U-c')).toBe(false);
  });
});
