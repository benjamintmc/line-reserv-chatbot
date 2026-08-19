import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../__tests__/test-db';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('ConversationRepository', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('upsert/get/delete 以 (group_id, line_user_id) 為鍵，updated_at 為 ISO', async () => {
    const created = await t.conversations.upsert({
      lineUserId: 'U-c',
      groupId: 'G-1',
      state: 'awaiting_date',
      payload: null,
    });
    expect(created.state).toBe('awaiting_date');
    expect(created.updated_at).toMatch(ISO_RE);

    const updated = await t.conversations.upsert({
      lineUserId: 'U-c',
      groupId: 'G-1',
      state: 'awaiting_time',
      payload: JSON.stringify({ eventDate: '2026-08-01' }),
    });
    expect(updated.state).toBe('awaiting_time');
    expect(JSON.parse(updated.payload ?? '{}')).toEqual({ eventDate: '2026-08-01' });

    expect(await t.conversations.delete('G-1', 'U-c')).toBe(true);
    expect(await t.conversations.get('G-1', 'U-c')).toBeUndefined();
    expect(await t.conversations.delete('G-1', 'U-c')).toBe(false);
  });

  // ── D-013（migration 0004）：PK 改為 (group_id, line_user_id) ────────────────
  it('[D-013 AC-3a] 0004 後結構斷言：PK=(group_id, line_user_id)、group_id NOT NULL、無孤兒索引', async () => {
    const pk = await t.pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'conversation_states'::regclass AND contype = 'p'`,
    );
    expect(pk.rows).toHaveLength(1);
    expect(pk.rows[0]!.conname).toBe('conversation_states_pkey');
    expect(pk.rows[0]!.def).toBe('PRIMARY KEY (group_id, line_user_id)');

    const col = await t.pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conversation_states'
          AND column_name = 'group_id'`,
    );
    expect(col.rows[0]!.is_nullable).toBe('NO');

    // 舊 PK 的隱含索引隨 DROP CONSTRAINT 一併消滅 → 本表只剩新 PK 的那一個索引（無孤兒）。
    const idx = await t.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'conversation_states'
        ORDER BY indexname`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(['conversation_states_pkey']);
  });

  it('[D-013 AC-3a] upsert 對同一人不同群各自成列、同一 (群, 人) 則覆寫；delete 只刪該群那列', async () => {
    await t.conversations.upsert({ lineUserId: 'U-x', groupId: 'G-A', state: 'awaiting_date', payload: null });
    await t.conversations.upsert({ lineUserId: 'U-x', groupId: 'G-B', state: 'grouping', payload: '{}' });

    // 兩列並存、互不影響。
    expect((await t.conversations.get('G-A', 'U-x'))?.state).toBe('awaiting_date');
    expect((await t.conversations.get('G-B', 'U-x'))?.state).toBe('grouping');

    // 同一 (群, 人) 再 upsert → 覆寫該列（不新增列）。
    await t.conversations.upsert({ lineUserId: 'U-x', groupId: 'G-A', state: 'awaiting_time', payload: null });
    expect((await t.conversations.get('G-A', 'U-x'))?.state).toBe('awaiting_time');
    expect((await t.conversations.get('G-B', 'U-x'))?.state).toBe('grouping');
    const cnt = await t.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM conversation_states WHERE line_user_id = $1',
      ['U-x'],
    );
    expect(Number(cnt.rows[0]!.n)).toBe(2);

    // delete 亦以複合鍵為準（G2）。
    expect(await t.conversations.delete('G-A', 'U-x')).toBe(true);
    expect(await t.conversations.get('G-A', 'U-x')).toBeUndefined();
    expect((await t.conversations.get('G-B', 'U-x'))?.state).toBe('grouping');
  });
});
