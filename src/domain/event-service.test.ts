import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { createTransactionRunner } from '../db/tx';
import { EventService } from './event-service';

const HOST = 'U-host';
const G = 'G-1';

function makeSvc(t: TestDb, hostIds: string[] = [HOST]): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: createTransactionRunner(t.db),
    hostUserIds: hostIds,
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
function walkToConfirm(svc: EventService, userId = HOST): void {
  svc.startCreation({ groupId: G, executorLineUserId: userId, messageId: nextMid() });
  for (const text of ['2026/08/15', '07:30', '東方球場', '16', '2200']) {
    svc.continueFlow({
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
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-004 AC-1] 一行式 → 摘要（awaiting_confirm，未 INSERT）→ 確認 → open', () => {
    const svc = makeSvc(t);
    const r1 = svc.handleOneline({
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
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_confirm');
    expect(t.events.findActiveByGroup(G)).toBeUndefined(); // 尚未 INSERT

    const r2 = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm2', hostDisplayName: '主辦人' });
    expect(r2.kind).toBe('created');
    if (r2.kind !== 'created') return;
    expect(r2.event.status).toBe('open');
    expect(r2.event.event_date).toBe('2026-08-15');
    expect(r2.event.event_time).toBe('07:30');
    expect(r2.event.location).toBe('東方球場');
    expect(r2.event.capacity).toBe(16);
    expect(r2.event.price_per_person).toBe(2200);
    expect(r2.event.price_mode).toBe('per_person');
    expect(t.conversations.get(HOST)).toBeUndefined(); // 流程清除
  });

  it('[D-004 AC-3 / D-005 AC-10] 逐步問答完整走完（單題計費）→ 確認 → open', () => {
    const svc = makeSvc(t);
    const start = svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    expect(start.kind).toBe('flow_started');
    if (start.kind === 'flow_started') expect(start.state).toBe('awaiting_date');

    const seq: Array<[string, string, string]> = [
      ['2026/08/15', 's1', 'awaiting_time'],
      ['07:30', 's2', 'awaiting_location'],
      ['東方球場', 's3', 'awaiting_capacity'],
      ['16', 's4', 'awaiting_fee'],
    ];
    for (const [text, mid, next] of seq) {
      const r = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: mid, text, hostDisplayName: '主辦人' });
      expect(r.kind).toBe('advanced');
      if (r.kind === 'advanced') expect(r.state).toBe(next);
    }
    const last = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's6', text: '2200', hostDisplayName: '主辦人' });
    expect(last.kind).toBe('awaiting_confirm');

    const done = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's7', text: '確認', hostDisplayName: '主辦人' });
    expect(done.kind).toBe('created');
    if (done.kind !== 'created') return;
    expect(done.event.event_date).toBe('2026-08-15');
    expect(done.event.location).toBe('東方球場');
    expect(done.event.capacity).toBe(16);
    expect(done.event.price_per_person).toBe(2200);
    expect(done.event.price_mode).toBe('per_person');
  });

  it('[D-004 AC-4] 逐步欄位驗證錯 → field_error 停留、payload 不含該欄；修正後前進', () => {
    const svc = makeSvc(t);
    svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    const bad = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's1', text: '2026/13/40', hostDisplayName: '主辦人' });
    expect(bad.kind).toBe('field_error');
    if (bad.kind === 'field_error') expect(bad.state).toBe('awaiting_date');
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_date');
    expect(JSON.parse(t.conversations.get(HOST)!.payload ?? '{}').date).toBeUndefined();

    const good = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's2', text: '2026/08/15', hostDisplayName: '主辦人' });
    expect(good.kind).toBe('advanced');
  });

  it('[D-004 AC-5] location 含空白經逐步問答保留', () => {
    const svc = makeSvc(t);
    svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's1', text: '2026/08/15', hostDisplayName: '主辦人' });
    svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's2', text: '07:30', hostDisplayName: '主辦人' });
    const r = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's3', text: '東方 高爾夫球場', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('advanced');
    expect(JSON.parse(t.conversations.get(HOST)!.payload ?? '{}').location).toBe('東方 高爾夫球場');
  });

  it('[D-004 AC-6] confirm 建立 host_user_id = 建立者的 user.id', () => {
    const svc = makeSvc(t);
    walkToConfirm(svc);
    const r = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'c6', text: '確認', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.event.host_user_id).toBe(t.users.getByLineUserId(HOST)!.id);
  });

  it('[D-004 AC-21] awaiting_confirm 下輸入 OK/好/確定 → confirm_reprompt 停留、不建立；隨後 確認 建立', () => {
    const svc = makeSvc(t);
    walkToConfirm(svc);
    for (const [text, mid] of [['OK', 'r1'], ['好', 'r2'], ['確定', 'r3']] as const) {
      const r = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: mid, text, hostDisplayName: '主辦人' });
      expect(r.kind).toBe('confirm_reprompt');
      expect(t.conversations.get(HOST)?.state).toBe('awaiting_confirm'); // 停留
      expect(t.events.findActiveByGroup(G)).toBeUndefined(); // 不建立
    }
    const done = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'rc', text: '確認', hostDisplayName: '主辦人' });
    expect(done.kind).toBe('created');
  });

  it('[D-004 AC-7] abort 任一 state 放棄流程；其後 confirm 無流程 → noop', () => {
    const svc = makeSvc(t);
    svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's1', text: '2026/08/15', hostDisplayName: '主辦人' });
    const ab = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 's2', text: '取消', hostDisplayName: '主辦人' });
    expect(ab.kind).toBe('aborted');
    expect(t.conversations.get(HOST)).toBeUndefined();
    expect(t.events.findActiveByGroup(G)).toBeUndefined();
    // 無流程 confirm → noop
    const c = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 's3', hostDisplayName: '主辦人' });
    expect(c.kind).toBe('noop');
  });

  it('[D-004 AC-8] open → closed；再 關閉報名 → already_closed 狀態不變', () => {
    const svc = makeSvc(t);
    walkToConfirm(svc);
    svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });
    const close1 = svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'x1' });
    expect(close1.kind).toBe('ok');
    if (close1.kind === 'ok') expect(close1.event.status).toBe('closed');
    expect(t.events.findActiveByGroup(G)?.status).toBe('closed');
    const close2 = svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'x2' });
    expect(close2.kind).toBe('already_closed');
    expect(t.events.findActiveByGroup(G)?.status).toBe('closed');
  });

  it('[D-004 AC-9] open/closed → cancelled，且不刪 registrations（含 soft-delete 列保留）', () => {
    const svc = makeSvc(t);
    walkToConfirm(svc);
    const created = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const eventId = created.event.id;

    // D-005：confirm 已自動登記主辦 1 列（seq=1）。再塞 3 confirmed member，取消 1（soft-delete）。
    const member = t.users.upsert('U-m', '成員');
    t.registrations.runImmediate(() => {
      const slots = t.registrations.insertSlots(
        { eventId, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        3,
      );
      t.registrations.cancelByIds([slots[0]!.id], member.id); // soft-delete 1 列
      return null;
    });
    // 主辦 1 + 成員 3 = 4 列（含被 soft-delete 者，實體列仍在）。
    const totalBefore = (t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId) as { n: number }).n;
    expect(totalBefore).toBe(4);

    const cancel = svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z1' });
    expect(cancel.kind).toBe('ok');
    if (cancel.kind === 'ok') expect(cancel.event.status).toBe('cancelled');
    // registrations 列數不變（無 DELETE，G10）；稽核欄保留。
    const totalAfter = (t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId) as { n: number }).n;
    expect(totalAfter).toBe(4);
    // 群組 active 集合清空 → 可再開團
    expect(t.events.findActiveByGroup(G)).toBeUndefined();

    // closed → cancelled 亦可（新的一場，unique message_id 由 walkToConfirm 保證）
    walkToConfirm(svc);
    svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c2', hostDisplayName: '主辦人' });
    svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'cl2' });
    const cancel2 = svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z2' });
    expect(cancel2.kind).toBe('ok');
    if (cancel2.kind === 'ok') expect(cancel2.event.status).toBe('cancelled');
  });

  it('[D-004 AC-10] 非白名單生命週期指令 → not_authorized、零 DB 副作用', () => {
    const svc = makeSvc(t, [HOST]); // 白名單只有 HOST
    const B = 'U-bad';
    expect(svc.startCreation({ groupId: G, executorLineUserId: B, messageId: 'b1' }).kind).toBe('not_authorized');
    expect(svc.handleOneline({ groupId: G, executorLineUserId: B, messageId: 'b2', date: '2026-08-15', time: '07:30', location: 'X', capacity: 4, price: 0, priceMode: 'per_person' }).kind).toBe('not_authorized');
    expect(svc.closeEvent({ groupId: G, executorLineUserId: B, messageId: 'b3' }).kind).toBe('not_authorized');
    expect(svc.cancelEvent({ groupId: G, executorLineUserId: B, messageId: 'b4' }).kind).toBe('not_authorized');
    // 零副作用：無 conversation、無 event、messageId 未 mark。
    expect(t.conversations.get(B)).toBeUndefined();
    expect(t.events.findActiveByGroup(G)).toBeUndefined();
    for (const m of ['b1', 'b2', 'b3', 'b4']) expect(t.processed.has(m)).toBe(false);
  });

  it('[D-004 AC-11] 已有 active（open/closed）時再 開團 → already_active、不寫 conversation', () => {
    const svc = makeSvc(t);
    walkToConfirm(svc);
    svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });

    const start = svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 'r1' });
    expect(start.kind).toBe('already_active');
    const oneline = svc.handleOneline({ groupId: G, executorLineUserId: HOST, messageId: 'r2', date: '2026-09-01', time: '08:00', location: 'Y', capacity: 8, price: 0, priceMode: 'per_person' });
    expect(oneline.kind).toBe('already_active');
    expect(t.conversations.get(HOST)).toBeUndefined(); // 不寫 conversation
    expect(t.processed.has('r1')).toBe(false);
    expect(t.processed.has('r2')).toBe(false);

    // closed 亦視為 active → 拒絕
    svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'cl' });
    expect(svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 'r3' }).kind).toBe('already_active');
  });

  it('[D-004 AC-12] confirm 撞 ux_events_active_group（UNIQUE）→ 窄捕捉 already_active + 清 conversation', () => {
    const svc = makeSvc(t);
    // 直接布置 awaiting_confirm 流程（避免 startCreation 觸 findActiveByGroup）。
    t.conversations.upsert({
      lineUserId: HOST,
      groupId: G,
      state: 'awaiting_confirm',
      payload: JSON.stringify({ date: '2026-08-15', time: '07:30', location: '東方球場', capacity: 16, price: 2200, priceMode: 'per_person' }),
    });
    // 先有一場 open（佔用 ux_events_active_group）。
    const other = t.users.upsert('U-other', '別人');
    t.events.create({ groupId: G, hostUserId: other.id, eventDate: '2026-08-15', eventTime: '07:30', location: '既有', capacity: 4, status: 'open' });
    // 讓入口早退失效（模擬 race：讀不到 active，但 INSERT 撞約束）。
    const spy = vi.spyOn(t.events, 'findActiveByGroup').mockReturnValue(undefined);

    const r = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('already_active');
    expect(t.conversations.get(HOST)).toBeUndefined(); // 清落敗者流程（nit-2）
    // 仍只有 1 場 open（未建立第二場）。
    const openCount = (t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE group_id = ? AND status = 'open'").get(G) as { n: number }).n;
    expect(openCount).toBe(1);
    spy.mockRestore();
  });

  it('[D-004 AC-12] confirm 遇非 UNIQUE 錯誤 → 一律 re-throw，不當作 already_active', () => {
    const svc = makeSvc(t);
    t.conversations.upsert({
      lineUserId: HOST,
      groupId: G,
      state: 'awaiting_confirm',
      payload: JSON.stringify({ date: '2026-08-15', time: '07:30', location: '東方球場', capacity: 16, price: 2200, priceMode: 'per_person' }),
    });
    const boom = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const spy = vi.spyOn(t.events, 'create').mockImplementation(() => {
      throw boom;
    });
    expect(() => svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'm', hostDisplayName: '主辦人' })).toThrow('disk I/O error');
    // 交易回滾：messageId 未 mark、conversation 未被刪。
    expect(t.processed.has('m')).toBe(false);
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_confirm');
    spy.mockRestore();
  });

  it('[D-004 AC-13] 去重：confirm 相同 message_id → 第二次 markProcessed=false → duplicate，只建立 1 場', () => {
    const svc = makeSvc(t);
    walkToConfirm(svc);
    // 預先標記 confirm 的 messageId（模擬重送已處理）。
    t.processed.markProcessed('dup');
    const r = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'dup', hostDisplayName: '主辦人' });
    expect(r.kind).toBe('duplicate');
    expect(t.events.findActiveByGroup(G)).toBeUndefined(); // 未建立
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_confirm'); // 流程保留（可正常重放）
  });

  it('[D-004 AC-14] 去重：逐步答案相同 message_id 重送 → 不重複推進（不套到下一問）', () => {
    const svc = makeSvc(t);
    svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 's0' });
    svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'd', text: '2026/08/15', hostDisplayName: '主辦人' });
    const first = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'tm', text: '07:30', hostDisplayName: '主辦人' });
    expect(first.kind).toBe('advanced'); // → awaiting_location
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_location');
    // 重送相同 message_id 'tm'（此時 state 已是 awaiting_location）→ 去重、不把 '07:30' 當 location
    const resend = svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: 'tm', text: '07:30', hostDisplayName: '主辦人' });
    expect(resend.kind).toBe('duplicate');
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_location'); // 未前進
    expect(JSON.parse(t.conversations.get(HOST)!.payload ?? '{}').location).toBeUndefined(); // 未誤填
  });

  it('[D-004 AC-16] 無流程時 confirm/abort → noop、不 mark、不改狀態', () => {
    const svc = makeSvc(t);
    const c = svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'n1', hostDisplayName: '主辦人' });
    const a = svc.abort({ executorLineUserId: HOST, messageId: 'n2' });
    expect(c.kind).toBe('noop');
    expect(a.kind).toBe('noop');
    expect(t.processed.has('n1')).toBe(false);
    expect(t.processed.has('n2')).toBe(false);
    expect(t.events.findActiveByGroup(G)).toBeUndefined();
  });

  it('[D-004 AC-17] 無 active 時 close/cancel → no_active、無狀態變更；cancelled 終態不可再轉移', () => {
    const svc = makeSvc(t);
    expect(svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y1' }).kind).toBe('no_active');
    expect(svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y2' }).kind).toBe('no_active');

    // 建立 → 取消 → cancelled 終態；再 close/cancel → no_active（findActiveByGroup 不含 cancelled）。
    walkToConfirm(svc);
    svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: 'c', hostDisplayName: '主辦人' });
    svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'z' });
    expect(svc.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y3' }).kind).toBe('no_active');
    expect(svc.cancelEvent({ groupId: G, executorLineUserId: HOST, messageId: 'y4' }).kind).toBe('no_active');
  });
});
