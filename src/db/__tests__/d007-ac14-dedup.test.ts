import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './test-db';
import { EventService } from '../../domain/event-service';

// [D-007 AC-14] 為設計文中對 D-004 AC-14（webhook 去重）之交叉引用（AC-8 述「等義 D-001 AC-7 / D-004 AC-14」）。
// 此處於 PG 下驗證該去重等義不退化：逐步答案相同 message_id 重送 → 交易首步 markProcessed
// （ON CONFLICT DO NOTHING）判為已處理 → duplicate、不重複推進。

const G = 'G14';
const H = 'U-h';

describe('D-007 去重等義（PG）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-007 AC-14] 逐步答案相同 message_id 重送 → duplicate、狀態不再前進（等義 D-004 AC-14 於 PG）', async () => {
    const evt = new EventService({
      events: t.events,
      users: t.users,
      conversations: t.conversations,
      runInTransaction: t.runInTransaction,
      superAdminUserIds: [],
      logError: () => {},
    });
    await evt.startCreation({ groupId: G, executorLineUserId: H, messageId: 's0' });
    await evt.continueFlow({ groupId: G, executorLineUserId: H, messageId: 'd1', text: '2026/08/15', hostDisplayName: 'H' });
    const first = await evt.continueFlow({ groupId: G, executorLineUserId: H, messageId: 'tm', text: '07:30', hostDisplayName: 'H' });
    expect(first.kind).toBe('advanced');
    const stateAfterFirst = (await t.conversations.get(G, H))?.state;

    // 重送相同 message_id 'tm' → 去重（不把 '07:30' 誤當下一題答案）。
    const resend = await evt.continueFlow({ groupId: G, executorLineUserId: H, messageId: 'tm', text: '07:30', hostDisplayName: 'H' });
    expect(resend.kind).toBe('duplicate');
    expect((await t.conversations.get(G, H))?.state).toBe(stateAfterFirst); // 未再前進
  });
});
