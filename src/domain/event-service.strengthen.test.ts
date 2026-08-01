import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { EventService } from './event-service';
import { EventRepository } from '../db/repositories/event-repository';

/**
 * unit-tester 獨立補強（T-008 覆核）。
 * 針對 backend 交付中「真覆蓋但斷言留有縫隙」的兩處：
 *   - AC-12 窄捕捉的 **constraint 判別分支**（PG：既有 re-throw 測試只用不同 code，
 *     從未觸發 code=23505 但命中其他 constraint（非 ux_events_active_group）的路徑）。
 *   - AC-9 稽核欄保留（既有測試僅驗列數不變，未驗 cancelled_at/cancelled_by_user_id 存活）。
 */

const HOST = 'U-host';
const G = 'G-1';

function makeSvc(t: TestDb, hostIds: string[] = [HOST]): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds: hostIds,
    logError: () => {},
  });
}

async function seedAwaitingConfirm(t: TestDb): Promise<void> {
  await t.conversations.upsert({
    lineUserId: HOST,
    groupId: G,
    state: 'awaiting_confirm',
    payload: JSON.stringify({
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
      priceMode: 'per_person',
    }),
  });
}

describe('EventService 補強：AC-12 窄捕捉 constraint 判別 + AC-9 稽核欄', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-004 AC-12] confirm 遇 23505 但命中其他 constraint（非 ux_events_active_group）→ 必須 re-throw，不吞成 already_active', async () => {
    const svc = makeSvc(t);
    await seedAwaitingConfirm(t);
    // 關鍵：code 命中 23505，但 constraint 指向 ux_users_line_user_id（非 ux_events_active_group）。
    // 若窄捕捉退化為「只看 code」，此錯誤會被誤吞成 already_active。正確行為：向上拋。
    const boom = Object.assign(new Error('duplicate key value violates unique constraint "ux_users_line_user_id"'), {
      code: '23505',
      constraint: 'ux_users_line_user_id',
    });
    const spy = vi.spyOn(EventRepository.prototype, 'create').mockRejectedValue(boom);

    await expect(
      svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' }),
    ).rejects.toThrow('ux_users_line_user_id');
    spy.mockRestore();

    // 交易回滾：未 mark、conversation 未被清（不得走 already_active 的清除路徑）。
    expect(await t.processed.has('m')).toBe(false);
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm');
  });

  it('[D-004 AC-12] confirm 撞 ux_events_active_group（23505 + constraint）→ 仍窄捕捉為 already_active', async () => {
    const svc = makeSvc(t);
    await seedAwaitingConfirm(t);
    const dup = Object.assign(
      new Error('duplicate key value violates unique constraint "ux_events_active_group"'),
      { code: '23505', constraint: 'ux_events_active_group' },
    );
    const spy = vi.spyOn(EventRepository.prototype, 'create').mockRejectedValue(dup);

    const r = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('already_active');
    spy.mockRestore();
    expect(await t.conversations.get(HOST)).toBeUndefined(); // 清落敗者流程
  });

  it('[D-004 AC-9] cancel_event 後 soft-delete 列的稽核欄（cancelled_at / cancelled_by_user_id）完整保留，有效列仍有效', async () => {
    const svc = makeSvc(t);
    const host = await t.users.upsert(HOST, '主辦人');
    const created = await t.events.create({
      groupId: G,
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
      location: '東方球場',
      capacity: 16,
      status: 'open',
    });

    const member = await t.users.upsert('U-m', '成員');
    const cancelledSlotId = await t.runImmediate(created.id, async (repos) => {
      const slots = await repos.registrations.insertSlots(
        { eventId: created.id, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        3,
      );
      await repos.registrations.cancelByIds([slots[0]!.id], member.id); // soft-delete 第一列
      return slots[0]!.id;
    });

    // 取消前：稽核欄快照（cancelled_at 非空、cancelled_by=member.id）。
    const beforeRes = await t.pool.query<{ cancelled_at: string | null; cancelled_by_user_id: number | null }>(
      'SELECT cancelled_at, cancelled_by_user_id FROM registrations WHERE id = $1',
      [cancelledSlotId],
    );
    const before = beforeRes.rows[0]!;
    expect(before.cancelled_at).not.toBeNull();
    expect(before.cancelled_by_user_id).toBe(member.id);

    const r = await svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z' });
    expect(r.kind).toBe('ok');

    // G10：取消活動為狀態轉移，不得動 registrations——稽核欄逐欄不變。
    const afterRes = await t.pool.query<{ cancelled_at: string | null; cancelled_by_user_id: number | null }>(
      'SELECT cancelled_at, cancelled_by_user_id FROM registrations WHERE id = $1',
      [cancelledSlotId],
    );
    const after = afterRes.rows[0]!;
    expect(after.cancelled_at).toBe(before.cancelled_at);
    expect(after.cancelled_by_user_id).toBe(before.cancelled_by_user_id);

    // 其餘兩列仍為有效報名（cancelled_at 保持 NULL，未被連帶清除）。
    const stillActive = await t.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1 AND cancelled_at IS NULL',
      [created.id],
    );
    expect(Number(stillActive.rows[0]!.n)).toBe(2);
  });
});
