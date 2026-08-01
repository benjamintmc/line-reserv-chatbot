import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { EventService } from './event-service';
import { EventRepository } from '../db/repositories/event-repository';

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

/** 全域遞增的 message_id，避免多次 walkToConfirm 撞去重（processed_events）。 */
let midCounter = 0;
function nextMid(): string {
  midCounter += 1;
  return `w${midCounter}`;
}

/**
 * 逐步走完至 awaiting_confirm（不含 `確認`；每步 message_id 全域唯一）。
 * D-005 §6.2（修訂）：capacity 後為單一計費題 awaiting_fee，整串答案 `2200` → per_person。
 */
async function walkToConfirm(svc: EventService, userId = HOST): Promise<void> {
  await svc.startCreation({ groupId: G, executorLineUserId: userId, messageId: nextMid() });
  for (const text of ['2026/08/15', '07:30', '東方球場', '16', '2200']) {
    await svc.continueFlow({
      groupId: G,
      executorLineUserId: userId,
      messageId: nextMid(),
      text,
      hostDisplayName: '主辦人',
    });
  }
}

describe('EventService（D-004 / D-005）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-004 AC-1] 一行式 → 摘要（awaiting_confirm，未 INSERT）→ 確認 → open', async () => {
    const svc = makeSvc(t);
    const r1 = await svc.handleOneline({
      groupId: G,
      executorLineUserId: HOST,
      messageId: 'm1',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
      priceMode: 'per_person',
    });
    expect(r1.kind).toBe('awaiting_confirm');
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm');
    expect(await t.events.findActiveByGroup(G)).toBeUndefined(); // 尚未 INSERT

    const r2 = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm2', hostDisplayName: '主辦人' });
    expect(r2.kind).toBe('created');
    if (r2.kind !== 'created') return;
    expect(r2.event.status).toBe('open');
    expect(r2.event.event_date).toBe('2026-08-15');
    expect(r2.event.event_time).toBe('07:30');
    expect(r2.event.location).toBe('東方球場');
    expect(r2.event.capacity).toBe(16);
    expect(r2.event.price_per_person).toBe(2200);
    expect(r2.event.price_mode).toBe('per_person');
    expect(await t.conversations.get(HOST)).toBeUndefined(); // 流程清除
  });

  it('[D-004 AC-3 / D-005 AC-10] 逐步問答完整走完（單題計費）→ 確認 → open', async () => {
    const svc = makeSvc(t);
    const start = await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    expect(start.kind).toBe('flow_started');
    if (start.kind === 'flow_started') expect(start.state).toBe('awaiting_date');

    const seq: Array<[string, string, string]> = [
      ['2026/08/15', 's1', 'awaiting_time'],
      ['07:30', 's2', 'awaiting_location'],
      ['東方球場', 's3', 'awaiting_capacity'],
      ['16', 's4', 'awaiting_fee'],
    ];
    for (const [text, mid, next] of seq) {
      const r = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: mid, text, hostDisplayName: '主辦人' });
      expect(r.kind).toBe('advanced');
      if (r.kind === 'advanced') expect(r.state).toBe(next);
    }
    const last = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's6', text: '2200', hostDisplayName: '主辦人' });
    expect(last.kind).toBe('awaiting_confirm');

    const done = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's7', text: '確認', hostDisplayName: '主辦人' });
    expect(done.kind).toBe('created');
    if (done.kind !== 'created') return;
    expect(done.event.event_date).toBe('2026-08-15');
    expect(done.event.location).toBe('東方球場');
    expect(done.event.capacity).toBe(16);
    expect(done.event.price_per_person).toBe(2200);
    expect(done.event.price_mode).toBe('per_person');
  });

  it('[D-004 AC-4] 逐步欄位驗證錯 → field_error 停留、payload 不含該欄；修正後前進', async () => {
    const svc = makeSvc(t);
    await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    const bad = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's1', text: '2026/13/40', hostDisplayName: '主辦人' });
    expect(bad.kind).toBe('field_error');
    if (bad.kind === 'field_error') expect(bad.state).toBe('awaiting_date');
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_date');
    expect(JSON.parse((await t.conversations.get(HOST))!.payload ?? '{}').date).toBeUndefined();

    const good = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's2', text: '2026/08/15', hostDisplayName: '主辦人' });
    expect(good.kind).toBe('advanced');
  });

  it('[D-004 AC-5] location 含空白經逐步問答保留', async () => {
    const svc = makeSvc(t);
    await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's1', text: '2026/08/15', hostDisplayName: '主辦人' });
    await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's2', text: '07:30', hostDisplayName: '主辦人' });
    const r = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's3', text: '東方 高爾夫球場', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('advanced');
    expect(JSON.parse((await t.conversations.get(HOST))!.payload ?? '{}').location).toBe('東方 高爾夫球場');
  });

  it('[D-004 AC-6] confirm 建立 host_user_id = 建立者的 user.id', async () => {
    const svc = makeSvc(t);
    await walkToConfirm(svc);
    const r = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'c6', text: '確認', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.event.host_user_id).toBe((await t.users.getByLineUserId(HOST))!.id);
  });

  it('[D-004 AC-21] awaiting_confirm 下輸入 OK/好/確定 → confirm_reprompt 停留、不建立；隨後 確認 建立', async () => {
    const svc = makeSvc(t);
    await walkToConfirm(svc);
    for (const [text, mid] of [['OK', 'r1'], ['好', 'r2'], ['確定', 'r3']] as const) {
      const r = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: mid, text, hostDisplayName: '主辦人' });
      expect(r.kind).toBe('confirm_reprompt');
      expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm'); // 停留
      expect(await t.events.findActiveByGroup(G)).toBeUndefined(); // 不建立
    }
    const done = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'rc', text: '確認', hostDisplayName: '主辦人' });
    expect(done.kind).toBe('created');
  });

  it('[D-004 AC-7] abort 任一 state 放棄流程；其後 confirm 無流程 → noop', async () => {
    const svc = makeSvc(t);
    await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's1', text: '2026/08/15', hostDisplayName: '主辦人' });
    const ab = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's2', text: '取消', hostDisplayName: '主辦人' });
    expect(ab.kind).toBe('aborted');
    expect(await t.conversations.get(HOST)).toBeUndefined();
    expect(await t.events.findActiveByGroup(G)).toBeUndefined();
    // 無流程 confirm → noop
    const c = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 's3', hostDisplayName: '主辦人' });
    expect(c.kind).toBe('noop');
  });

  it('[D-004 AC-8] open → closed；再 關閉報名 → already_closed 狀態不變', async () => {
    const svc = makeSvc(t);
    await walkToConfirm(svc);
    await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });
    const close1 = await svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'x1' });
    expect(close1.kind).toBe('ok');
    if (close1.kind === 'ok') expect(close1.event.status).toBe('closed');
    expect((await t.events.findActiveByGroup(G))?.status).toBe('closed');
    const close2 = await svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'x2' });
    expect(close2.kind).toBe('already_closed');
    expect((await t.events.findActiveByGroup(G))?.status).toBe('closed');
  });

  it('[D-004 AC-9] open/closed → cancelled，且不刪 registrations（含 soft-delete 列保留）', async () => {
    const svc = makeSvc(t);
    await walkToConfirm(svc);
    const created = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const eventId = created.event.id;

    // D-005：confirm 已自動登記主辦 1 列（seq=1）。再塞 3 confirmed member，取消 1（soft-delete）。
    const member = await t.users.upsert('U-m', '成員');
    await t.runImmediate(eventId, async (repos) => {
      const slots = await repos.registrations.insertSlots(
        { eventId, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        3,
      );
      await repos.registrations.cancelByIds([slots[0]!.id], member.id); // soft-delete 1 列
      return null;
    });
    // 主辦 1 + 成員 3 = 4 列（含被 soft-delete 者，實體列仍在）。
    const before = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1', [eventId]);
    expect(Number(before.rows[0]!.n)).toBe(4);

    const cancel = await svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z1' });
    expect(cancel.kind).toBe('ok');
    if (cancel.kind === 'ok') expect(cancel.event.status).toBe('cancelled');
    // registrations 列數不變（無 DELETE，G10）；稽核欄保留。
    const after = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1', [eventId]);
    expect(Number(after.rows[0]!.n)).toBe(4);
    // 群組 active 集合清空 → 可再開團
    expect(await t.events.findActiveByGroup(G)).toBeUndefined();

    // closed → cancelled 亦可（新的一場，unique message_id 由 walkToConfirm 保證）
    await walkToConfirm(svc);
    await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c2', hostDisplayName: '主辦人' });
    await svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'cl2' });
    const cancel2 = await svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z2' });
    expect(cancel2.kind).toBe('ok');
    if (cancel2.kind === 'ok') expect(cancel2.event.status).toBe('cancelled');
  });

  it('[D-004 AC-10 errata(2026-07-31 D-006 #7)] 開團全開 + 非建立者非 super-admin close/cancel 被拒（無 DB 變更）', async () => {
    // D-006 授權 errata：開團不再受授權保護（全開）；close/cancel 改 canManageEvent。
    const svc = makeSvc(t, []); // 無 super-admin
    const B = 'U-bad';
    // 開團全開：非 super-admin B 亦可啟動開團（不再 not_authorized）。
    expect((await svc.startCreation({ groupId: 'G-open', executorLineUserId: B, messageId: 'bs' })).kind).toBe('flow_started');

    // HOST 於 G 建一場 open（host_user_id = upsert(HOST).id）。
    const host = await t.users.upsert(HOST, '主辦人');
    await t.events.create({ groupId: G, hostUserId: host.id, eventDate: '2026-08-15', eventTime: '07:30', location: 'X', capacity: 4, status: 'open' });

    // B（非 host、非 super-admin）close/cancel → not_authorized、零 DB 變更。
    expect((await svc.closeEvent({ groupId: G, executorLineUserId: B, messageId: 'b3' })).kind).toBe('not_authorized');
    expect((await svc.cancelEvent({ groupId: G, executorLineUserId: B, messageId: 'b4' })).kind).toBe('not_authorized');
    expect((await t.events.findActiveByGroup(G))?.status).toBe('open'); // 狀態不變
    expect(await t.users.getByLineUserId(B)).toBeUndefined(); // 唯讀判定：未為 B upsert 寫列
    for (const m of ['b3', 'b4']) expect(await t.processed.has(m)).toBe(false); // 未 mark
  });

  it('[D-004 AC-11] 已有 active（open/closed）時再 開團 → already_active、不寫 conversation', async () => {
    const svc = makeSvc(t);
    await walkToConfirm(svc);
    await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });

    const start = await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 'r1' });
    expect(start.kind).toBe('already_active');
    const oneline = await svc.handleOneline({ groupId: G, executorLineUserId: HOST, messageId: 'r2', date: '2026-09-01', time: '08:00', location: 'Y', capacity: 8, price: 0, priceMode: 'per_person' });
    expect(oneline.kind).toBe('already_active');
    expect(await t.conversations.get(HOST)).toBeUndefined(); // 不寫 conversation
    expect(await t.processed.has('r1')).toBe(false);
    expect(await t.processed.has('r2')).toBe(false);

    // closed 亦視為 active → 拒絕
    await svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'cl' });
    expect((await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 'r3' })).kind).toBe('already_active');
  });

  it('[D-004 AC-12] confirm 撞 ux_events_active_group（UNIQUE）→ 窄捕捉 already_active + 清 conversation', async () => {
    const svc = makeSvc(t);
    // 直接布置 awaiting_confirm 流程（避免 startCreation 觸 findActiveByGroup）。
    await t.conversations.upsert({
      lineUserId: HOST,
      groupId: G,
      state: 'awaiting_confirm',
      payload: JSON.stringify({ date: '2026-08-15', time: '07:30', location: '東方球場', capacity: 16, price: 2200, priceMode: 'per_person' }),
    });
    // 先有一場 open（佔用 ux_events_active_group）。
    const other = await t.users.upsert('U-other', '別人');
    await t.events.create({ groupId: G, hostUserId: other.id, eventDate: '2026-08-15', eventTime: '07:30', location: '既有', capacity: 4, status: 'open' });
    // 讓「交易內入口早退」失效（模擬 race：pre-check 讀不到 active，但 INSERT 撞約束）。
    // 路線 A：confirm 交易內走 client-bound repos.events（每交易新建），故 spy 打在 prototype 才能命中。
    const spy = vi.spyOn(EventRepository.prototype, 'findActiveByGroup').mockResolvedValue(undefined);

    const r = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('already_active');
    spy.mockRestore();
    expect(await t.conversations.get(HOST)).toBeUndefined(); // 清落敗者流程（nit-2）
    // 仍只有 1 場 open（未建立第二場）。
    const openCount = await t.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM events WHERE group_id = $1 AND status = 'open'", [G]);
    expect(Number(openCount.rows[0]!.n)).toBe(1);
  });

  it('[D-004 AC-12] confirm 遇非 UNIQUE 錯誤 → 一律 re-throw，不當作 already_active', async () => {
    const svc = makeSvc(t);
    await t.conversations.upsert({
      lineUserId: HOST,
      groupId: G,
      state: 'awaiting_confirm',
      payload: JSON.stringify({ date: '2026-08-15', time: '07:30', location: '東方球場', capacity: 16, price: 2200, priceMode: 'per_person' }),
    });
    // 非 23505 的 DB 錯誤（模擬 I/O 例外）；路線 A 下 create 走 client-bound repos → spy prototype。
    const boom = Object.assign(new Error('disk I/O error'), { code: '58030' });
    const spy = vi.spyOn(EventRepository.prototype, 'create').mockRejectedValue(boom);
    await expect(
      svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' }),
    ).rejects.toThrow('disk I/O error');
    spy.mockRestore();
    // 交易回滾：messageId 未 mark、conversation 未被刪。
    expect(await t.processed.has('m')).toBe(false);
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm');
  });

  it('[D-004 AC-13] 去重：confirm 相同 message_id → 第二次 markProcessed=false → duplicate，只建立 1 場', async () => {
    const svc = makeSvc(t);
    await walkToConfirm(svc);
    // 預先標記 confirm 的 messageId（模擬重送已處理）。
    await t.processed.markProcessed('dup');
    const r = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'dup', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('duplicate');
    expect(await t.events.findActiveByGroup(G)).toBeUndefined(); // 未建立
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm'); // 流程保留（可正常重放）
  });

  it('[D-004 AC-14] 去重：逐步答案相同 message_id 重送 → 不重複推進（不套到下一問）', async () => {
    const svc = makeSvc(t);
    await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'd', text: '2026/08/15', hostDisplayName: '主辦人' });
    const first = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'tm', text: '07:30', hostDisplayName: '主辦人' });
    expect(first.kind).toBe('advanced'); // → awaiting_location
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_location');
    // 重送相同 message_id 'tm'（此時 state 已是 awaiting_location）→ 去重、不把 '07:30' 當 location
    const resend = await svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'tm', text: '07:30', hostDisplayName: '主辦人' });
    expect(resend.kind).toBe('duplicate');
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_location'); // 未前進
    expect(JSON.parse((await t.conversations.get(HOST))!.payload ?? '{}').location).toBeUndefined(); // 未誤填
  });

  it('[D-004 AC-16] 無流程時 confirm/abort → noop、不 mark、不改狀態', async () => {
    const svc = makeSvc(t);
    const c = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'n1', hostDisplayName: '主辦人' });
    const a = await svc.abort({ executorLineUserId: HOST, messageId: 'n2' });
    expect(c.kind).toBe('noop');
    expect(a.kind).toBe('noop');
    expect(await t.processed.has('n1')).toBe(false);
    expect(await t.processed.has('n2')).toBe(false);
    expect(await t.events.findActiveByGroup(G)).toBeUndefined();
  });

  it('[D-004 AC-17] 無 active 時 close/cancel → no_active、無狀態變更；cancelled 終態不可再轉移', async () => {
    const svc = makeSvc(t);
    expect((await svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y1' })).kind).toBe('no_active');
    expect((await svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y2' })).kind).toBe('no_active');

    // 建立 → 取消 → cancelled 終態；再 close/cancel → no_active（findActiveByGroup 不含 cancelled）。
    await walkToConfirm(svc);
    await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });
    await svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z' });
    expect((await svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y3' })).kind).toBe('no_active');
    expect((await svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y4' })).kind).toBe('no_active');
  });
});
