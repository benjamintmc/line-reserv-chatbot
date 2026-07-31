import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { createTransactionRunner } from '../db/tx';
import { EventService } from './event-service';

/**
 * unit-tester 獨立補強（T-008 覆核）。
 * 針對 backend 交付中「真覆蓋但斷言留有縫隙」的兩處：
 *   - AC-12 窄捕捉的 **message 判別分支**（既有 re-throw 測試只用不同 code=SQLITE_IOERR，
 *     從未觸發 code=SQLITE_CONSTRAINT_UNIQUE 但命中其他 column/index 的路徑）。
 *   - AC-9 稽核欄保留（既有測試僅驗列數不變，未驗 cancelled_at/cancelled_by_user_id 存活）。
 */

const HOST = 'U-host';
const G = 'G-1';

function makeSvc(t: TestDb, hostIds: string[] = [HOST]): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: createTransactionRunner(t.db),
    hostUserIds: hostIds,
    logError: () => {},
  });
}

function seedAwaitingConfirm(t: TestDb): void {
  t.conversations.upsert({
    lineUserId: HOST,
    groupId: G,
    state: 'awaiting_confirm',
    payload: JSON.stringify({
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
    }),
  });
}

describe('EventService 補強：AC-12 窄捕捉 message 判別 + AC-9 稽核欄', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-004 AC-12] confirm 遇 SQLITE_CONSTRAINT_UNIQUE 但命中其他 column（非 events.group_id）→ 必須 re-throw，不吞成 already_active', () => {
    const svc = makeSvc(t);
    seedAwaitingConfirm(t);
    // 關鍵：code 命中 UNIQUE，但 message 指向 users.line_user_id（非 events.group_id / ux_events_active_group）。
    // 若窄捕捉退化為「只看 code」，此錯誤會被誤吞成 already_active。正確行為：向上拋。
    const boom = Object.assign(new Error('UNIQUE constraint failed: users.line_user_id'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const spy = vi.spyOn(t.events, 'create').mockImplementation(() => {
      throw boom;
    });

    expect(() =>
      svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' }),
    ).toThrow('UNIQUE constraint failed: users.line_user_id');

    // 交易回滾：未 mark、conversation 未被清（不得走 already_active 的清除路徑）。
    expect(t.processed.has('m')).toBe(false);
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_confirm');
    spy.mockRestore();
  });

  it('[D-004 AC-12] confirm 撞 ux_events_active_group（index 名訊息變體）→ 仍窄捕捉為 already_active', () => {
    const svc = makeSvc(t);
    seedAwaitingConfirm(t);
    // 相容 better-sqlite3 可能回 index 名而非 column 名的訊息變體。
    const dup = Object.assign(
      new Error('UNIQUE constraint failed: index ux_events_active_group'),
      { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    );
    const spy = vi.spyOn(t.events, 'create').mockImplementation(() => {
      throw dup;
    });

    const r = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('already_active');
    expect(t.conversations.get(HOST)).toBeUndefined(); // 清落敗者流程
    spy.mockRestore();
  });

  it('[D-004 AC-9] cancel_event 後 soft-delete 列的稽核欄（cancelled_at / cancelled_by_user_id）完整保留，有效列仍有效', () => {
    const svc = makeSvc(t);
    const host = t.users.upsert(HOST, '主辦人');
    const created = t.events.create({
      groupId: G,
      hostUserId: host.id,
      eventDate: '2026-08-15',
      eventTime: '07:30',
      location: '東方球場',
      capacity: 16,
      status: 'open',
    });

    const member = t.users.upsert('U-m', '成員');
    let cancelledSlotId = 0;
    t.registrations.runImmediate(() => {
      const slots = t.registrations.insertSlots(
        { eventId: created.id, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        3,
      );
      t.registrations.cancelByIds([slots[0]!.id], member.id); // soft-delete 第一列
      cancelledSlotId = slots[0]!.id;
      return null;
    });

    // 取消前：稽核欄快照（cancelled_at 非空、cancelled_by=member.id）。
    const before = t.db
      .prepare('SELECT cancelled_at, cancelled_by_user_id FROM registrations WHERE id = ?')
      .get(cancelledSlotId) as { cancelled_at: string | null; cancelled_by_user_id: number | null };
    expect(before.cancelled_at).not.toBeNull();
    expect(before.cancelled_by_user_id).toBe(member.id);

    const r = svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z' });
    expect(r.kind).toBe('ok');

    // G10：取消活動為狀態轉移，不得動 registrations——稽核欄逐欄不變。
    const after = t.db
      .prepare('SELECT cancelled_at, cancelled_by_user_id FROM registrations WHERE id = ?')
      .get(cancelledSlotId) as { cancelled_at: string | null; cancelled_by_user_id: number | null };
    expect(after.cancelled_at).toBe(before.cancelled_at);
    expect(after.cancelled_by_user_id).toBe(before.cancelled_by_user_id);

    // 其餘兩列仍為有效報名（cancelled_at 保持 NULL，未被連帶清除）。
    const stillActive = (
      t.db
        .prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND cancelled_at IS NULL')
        .get(created.id) as { n: number }
    ).n;
    expect(stillActive).toBe(2);
  });
});
