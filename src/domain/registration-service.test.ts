import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from './registration-service';
import { buildRoster } from './roster';

function makeService(t: TestDb): RegistrationService {
  return new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    logError: () => {},
  });
}

describe('RegistrationService', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-003 AC-1] 空 open 活動 +3 → 3 列 confirmed、名單後綴、剩餘 13', async () => {
    await seedEvent(t, { capacity: 16, groupId: 'G' });
    const svc = makeService(t);
    const r = await svc.signup({
      groupId: 'G',
      executorLineUserId: 'U-wang',
      executorDisplayName: '王小明',
      messageId: 'm1',
      count: 3,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.outcome).toBe('confirmed');
    expect(r.view.confirmedCount).toBe(3);
    expect(r.view.available).toBe(13);
    expect(buildRoster(r.view.confirmed).map((e) => e.label)).toEqual([
      '王小明',
      '王小明(2)',
      '王小明(3)',
    ]);
  });

  it('[D-003 AC-2] 容量剩 1，兩筆 +1 序列化後無超賣（一 confirmed 一整批 waitlist）', async () => {
    const { event } = await seedEvent(t, { capacity: 1, groupId: 'G' });
    const svc = makeService(t);
    const a = await svc.signup({
      groupId: 'G',
      executorLineUserId: 'U-a',
      executorDisplayName: 'A',
      messageId: 'm1',
      count: 1,
    });
    const b = await svc.signup({
      groupId: 'G',
      executorLineUserId: 'U-b',
      executorDisplayName: 'B',
      messageId: 'm2',
      count: 1,
    });
    expect(a.kind === 'ok' && a.outcome).toBe('confirmed');
    expect(b.kind === 'ok' && b.outcome).toBe('waitlisted');
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
    expect(await t.registrations.countConfirmed(event.id)).toBeLessThanOrEqual(event.capacity);
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(1);
  });

  it('[D-003 AC-2] 大批 +N 相繼進入，有效正取數恆不超過 capacity（outcome-based）', async () => {
    const { event } = await seedEvent(t, { capacity: 3, groupId: 'G' });
    const svc = makeService(t);
    // 5 位各 +1 相繼進入；只有前 3 位能進正取，其餘整批候補。
    const outcomes: string[] = [];
    for (const [i, name] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      const r = await svc.signup({
        groupId: 'G',
        executorLineUserId: `U-${name}`,
        executorDisplayName: name,
        messageId: `m${i}`,
        count: 1,
      });
      outcomes.push(r.kind === 'ok' ? r.outcome : r.kind);
    }
    expect(outcomes).toEqual(['confirmed', 'confirmed', 'confirmed', 'waitlisted', 'waitlisted']);
    expect(await t.registrations.countConfirmed(event.id)).toBe(3);
    expect(await t.registrations.countConfirmed(event.id)).toBeLessThanOrEqual(event.capacity);
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(2);
  });

  it('[D-003 AC-3] available=1 但 +2 → 整批候補（非部分接受）', async () => {
    await seedEvent(t, { capacity: 1, groupId: 'G' });
    const svc = makeService(t);
    const r = await svc.signup({
      groupId: 'G',
      executorLineUserId: 'U-x',
      executorDisplayName: 'X',
      messageId: 'm1',
      count: 2,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.outcome).toBe('waitlisted');
    expect(r.newSlots).toHaveLength(2);
    expect(r.newSlots.every((s) => s.status === 'waitlist')).toBe(true);
    expect(r.view.confirmedCount).toBe(0);
  });

  it('[D-003 AC-3] 已有 1 正取（capacity=2），+2 → available=1<2 → 整批候補、正取不動', async () => {
    const { event } = await seedEvent(t, { capacity: 2, groupId: 'G' });
    const svc = makeService(t);
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'm1', count: 1 });
    const r = await svc.signup({ groupId: 'G', executorLineUserId: 'U-b', executorDisplayName: 'B', messageId: 'm2', count: 2 });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.outcome).toBe('waitlisted');
    expect(r.newSlots.every((s) => s.status === 'waitlist')).toBe(true);
    expect(await t.registrations.countConfirmed(event.id)).toBe(1); // 未部分接受
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(2);
  });

  it('[D-003 AC-4] 取消釋出正取 → 最小 seq 有效候補被遞補', async () => {
    const { event } = await seedEvent(t, { capacity: 2, groupId: 'G' });
    const svc = makeService(t);
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'm1', count: 1 });
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-b', executorDisplayName: 'B', messageId: 'm2', count: 1 });
    const cRes = await svc.signup({ groupId: 'G', executorLineUserId: 'U-c', executorDisplayName: 'C', messageId: 'm3', count: 1 });
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-d', executorDisplayName: 'D', messageId: 'm4', count: 1 });
    expect(cRes.kind === 'ok' && cRes.outcome).toBe('waitlisted');

    const cancel = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'm5', count: 1 });
    expect(cancel.kind).toBe('ok');
    if (cancel.kind !== 'ok') return;
    expect(cancel.promoted).toHaveLength(1);
    // 最小 seq 有效候補＝C（先於 D 進候補）。
    expect(cancel.promoted[0]!.display_name).toBe('C');
    expect((await t.registrations.getById(cancel.promoted[0]!.id))!.status).toBe('confirmed');
    expect(await t.registrations.countConfirmed(event.id)).toBe(2);
  });

  it('[D-003 AC-5] 混合持有 2 正取+1 候補，-1 先退候補（高 seq）、不觸發遞補', async () => {
    const { event } = await seedEvent(t, { capacity: 2, groupId: 'G' });
    const svc = makeService(t);
    // X +2 → 兩正取；X +1 → 一候補。
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm1', count: 2 });
    const w = await svc.signup({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm2', count: 1 });
    expect(w.kind === 'ok' && w.outcome).toBe('waitlisted');

    const cancel = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm3', count: 1 });
    expect(cancel.kind).toBe('ok');
    if (cancel.kind !== 'ok') return;
    expect(cancel.cancelled).toBe(1);
    expect(cancel.promoted).toHaveLength(0); // 退的是候補，不釋出正取
    expect(await t.registrations.countConfirmed(event.id)).toBe(2); // 正取不變
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(0); // 候補被退
  });

  it('[D-003 AC-5] 組內高 seq 先：純正取 3 列 -2 → 取消高 seq 兩列、保留最低 seq', async () => {
    const { event } = await seedEvent(t, { capacity: 5, groupId: 'G' });
    const svc = makeService(t);
    const s = await svc.signup({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm1', count: 3 });
    expect(s.kind).toBe('ok');
    if (s.kind !== 'ok') return;
    const [seq1, seq2, seq3] = s.newSlots; // insertSlots 依 seq 升冪回傳

    const cancel = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm2', count: 2 });
    expect(cancel.kind === 'ok' && cancel.cancelled).toBe(2);
    // 高 seq 先：seq3、seq2 被取消，seq1 保留（名單上先消失 X(3)、X(2)）。
    expect((await t.registrations.getById(seq3!.id))!.cancelled_at).not.toBeNull();
    expect((await t.registrations.getById(seq2!.id))!.cancelled_at).not.toBeNull();
    expect((await t.registrations.getById(seq1!.id))!.cancelled_at).toBeNull();
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
  });

  it('[D-003 AC-6] 代報名 +1 陳大哥 → proxy 列、owner=傳訊人、顯示名為輸入名字', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G' });
    const svc = makeService(t);
    const r = await svc.signup({
      groupId: 'G',
      executorLineUserId: 'U-wang',
      executorDisplayName: '王小明',
      messageId: 'm1',
      count: 1,
      proxyName: '陳大哥',
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const slot = r.newSlots[0]!;
    expect(slot.kind).toBe('proxy');
    expect(slot.display_name).toBe('陳大哥');
    const owner = (await t.users.getByLineUserId('U-wang'))!;
    expect(slot.owner_user_id).toBe(owner.id);
    expect(r.subjectDisplayName).toBe('陳大哥');
  });

  it('[D-003 AC-7] 非主辦人只能取消自己代報：他人代取消查無 → nothing_to_cancel', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G' }); // host = U-host
    const svc = makeService(t);
    // 王小明（非主辦）代報 陳大哥。
    const signup = await svc.signup({ groupId: 'G', executorLineUserId: 'U-wang', executorDisplayName: '王小明', messageId: 'm1', count: 1, proxyName: '陳大哥' });
    expect(signup.kind).toBe('ok');
    const proxyRowId = signup.kind === 'ok' ? signup.newSlots[0]!.id : -1;

    // 非主辦成員 B 嘗試代取消王小明代報的名額 → 拒絕。
    const byB = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-b', executorDisplayName: 'B', messageId: 'm2', count: 1, proxyName: '陳大哥' });
    expect(byB.kind).toBe('nothing_to_cancel');
    expect((await t.registrations.getById(proxyRowId))!.cancelled_at).toBeNull(); // 未被取消

    // 王小明本人代取消 → 成功。
    const byWang = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-wang', executorDisplayName: '王小明', messageId: 'm3', count: 1, proxyName: '陳大哥' });
    expect(byWang.kind).toBe('ok');
    expect((await t.registrations.getById(proxyRowId))!.cancelled_at).not.toBeNull();
    expect(await t.registrations.findActiveProxyByName(event.id, '陳大哥')).toHaveLength(0);
  });

  it('[D-003 AC-7] 自取消 -N 只退本人 self 名額，不動本人代報名額', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G' });
    const svc = makeService(t);
    // 王小明自報 +1，並代報 +1 陳大哥。
    const self = await svc.signup({ groupId: 'G', executorLineUserId: 'U-wang', executorDisplayName: '王小明', messageId: 'm1', count: 1 });
    const proxy = await svc.signup({ groupId: 'G', executorLineUserId: 'U-wang', executorDisplayName: '王小明', messageId: 'm2', count: 1, proxyName: '陳大哥' });
    const selfId = self.kind === 'ok' ? self.newSlots[0]!.id : -1;
    const proxyId = proxy.kind === 'ok' ? proxy.newSlots[0]!.id : -1;

    // -1(無名字) 只取消 self 名額。
    const cancel = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-wang', executorDisplayName: '王小明', messageId: 'm3', count: 1 });
    expect(cancel.kind === 'ok' && cancel.cancelled).toBe(1);
    expect((await t.registrations.getById(selfId))!.cancelled_at).not.toBeNull();
    expect((await t.registrations.getById(proxyId))!.cancelled_at).toBeNull(); // 代報名額不受 -N 影響
    expect(await t.registrations.findActiveProxyByName(event.id, '陳大哥')).toHaveLength(1);
  });

  it('[D-003 AC-9 / D-008 AC-11] 無活動 → 皆 no_open_event；closed → signup/cancel no_open_event、名單顯示 closed', async () => {
    const svc = makeService(t);
    // 無任何活動。
    expect((await svc.signup({ groupId: 'G-none', executorLineUserId: 'U', executorDisplayName: 'U', messageId: 'm1', count: 1 })).kind).toBe('no_open_event');
    expect((await svc.cancel({ groupId: 'G-none', executorLineUserId: 'U', executorDisplayName: 'U', messageId: 'm2', count: 1 })).kind).toBe('no_open_event');
    expect((await svc.getListView({ groupId: 'G-none', messageId: 'm3' })).kind).toBe('no_open_event');

    // closed 活動：signup/cancel 仍 no_open_event（findActiveByGroup 不回 closed）；
    // D-008 AC-11：名單改顯示 closed（phase='closed'、kind='ok'，非 no_open_event）。
    const host = await t.users.upsert('U-h2', '主辦2');
    await t.events.create({ groupId: 'G-closed', hostUserId: host.id, eventDatetime: '2026-08-14T23:30:00Z', location: '某場', capacity: 4, status: 'closed' });
    expect((await svc.signup({ groupId: 'G-closed', executorLineUserId: 'U', executorDisplayName: 'U', messageId: 'm4', count: 1 })).kind).toBe('no_open_event');
    expect((await svc.cancel({ groupId: 'G-closed', executorLineUserId: 'U', executorDisplayName: 'U', messageId: 'm6', count: 1 })).kind).toBe('no_open_event');
    const list = await svc.getListView({ groupId: 'G-closed', messageId: 'm5' });
    expect(list.kind).toBe('ok');
    if (list.kind === 'ok') expect(list.phase).toBe('closed');
  });

  it('[D-003 AC-11] 相同 message_id 的 +1 連續兩次 → 第二次 duplicate、只 1 列有效', async () => {
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G' });
    const svc = makeService(t);
    const r1 = await svc.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'dup', count: 1 });
    const r2 = await svc.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'dup', count: 1 });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('duplicate');
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
  });

  it('[D-003 AC-11] cancel 相同 message_id 兩次 → 第二次 duplicate、不重複取消', async () => {
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G' });
    const svc = makeService(t);
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm1', count: 2 });
    const c1 = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'cdup', count: 1 });
    const c2 = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'cdup', count: 1 });
    expect(c1.kind === 'ok' && c1.cancelled).toBe(1);
    expect(c2.kind).toBe('duplicate');
    // 第二次未再取消：仍剩 1 正取（而非 0）。
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
  });

  it('[D-003 AC-12] 超取消歸零（-5 取消全部 2 列）；無名額 -1 → nothing_to_cancel', async () => {
    const { event } = await seedEvent(t, { capacity: 5, groupId: 'G' });
    const svc = makeService(t);
    await svc.signup({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm1', count: 2 });
    const over = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-x', executorDisplayName: 'X', messageId: 'm2', count: 5 });
    expect(over.kind).toBe('ok');
    expect(over.kind === 'ok' && over.cancelled).toBe(2);
    expect(await t.registrations.countConfirmed(event.id)).toBe(0);

    const none = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-y', executorDisplayName: 'Y', messageId: 'm3', count: 1 });
    expect(none.kind).toBe('nothing_to_cancel');
  });

  it('[D-003 AC-17] 主辦人跨 owner 代取消他人代報 confirmed 名額 → 稽核記主辦人並觸發遞補', async () => {
    const { event, host } = await seedEvent(t, { capacity: 1, groupId: 'G' }); // host = U-host
    const svc = makeService(t);
    // 成員 A（非主辦）代報 陳大哥 → 佔滿唯一正取。
    const aSignup = await svc.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'm1', count: 1, proxyName: '陳大哥' });
    expect(aSignup.kind === 'ok' && aSignup.outcome).toBe('confirmed');
    const chenId = aSignup.kind === 'ok' ? aSignup.newSlots[0]!.id : -1;
    // W 進候補。
    const wSignup = await svc.signup({ groupId: 'G', executorLineUserId: 'U-w', executorDisplayName: 'W', messageId: 'm2', count: 1 });
    expect(wSignup.kind === 'ok' && wSignup.outcome).toBe('waitlisted');

    // 主辦人 -1 陳大哥（跨 owner 代取消）。
    const cancel = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-host', executorDisplayName: '主辦人', messageId: 'm3', count: 1, proxyName: '陳大哥' });
    expect(cancel.kind).toBe('ok');
    if (cancel.kind !== 'ok') return;
    const chen = (await t.registrations.getById(chenId))!;
    expect(chen.cancelled_at).not.toBeNull();
    expect(chen.cancelled_by_user_id).toBe(host.id); // 稽核記主辦人
    // 觸發遞補：W 由候補轉正取。
    expect(cancel.promoted).toHaveLength(1);
    expect(cancel.promoted[0]!.display_name).toBe('W');
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
  });

  it('[D-003 AC-18] 主辦人代取消多筆同名：取較新（高 seq）1 列，另一保留', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G' });
    const svc = makeService(t);
    const a = await svc.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'm1', count: 1, proxyName: '陳大哥' });
    const b = await svc.signup({ groupId: 'G', executorLineUserId: 'U-b', executorDisplayName: 'B', messageId: 'm2', count: 1, proxyName: '陳大哥' });
    const aId = a.kind === 'ok' ? a.newSlots[0]!.id : -1;
    const bId = b.kind === 'ok' ? b.newSlots[0]!.id : -1;

    const cancel = await svc.cancel({ groupId: 'G', executorLineUserId: 'U-host', executorDisplayName: '主辦人', messageId: 'm3', count: 1, proxyName: '陳大哥' });
    expect(cancel.kind === 'ok' && cancel.cancelled).toBe(1);
    // 高 seq（B，較新）被取消；A 保留。
    expect((await t.registrations.getById(bId))!.cancelled_at).not.toBeNull();
    expect((await t.registrations.getById(aId))!.cancelled_at).toBeNull();
    expect(await t.registrations.findActiveProxyByName(event.id, '陳大哥')).toHaveLength(1);
  });

  it('getListView 對空 open 活動回 ok 且 view 完整', async () => {
    await seedEvent(t, { capacity: 8, groupId: 'G' });
    const svc = makeService(t);
    const r = await svc.getListView({ groupId: 'G', messageId: 'm1' });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.view.confirmedCount).toBe(0);
    expect(r.view.available).toBe(8);
  });
});
