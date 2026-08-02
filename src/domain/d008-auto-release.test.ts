import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, FUTURE_ISO, PAST_ISO, type TestDb } from '../db/__tests__/test-db';
import { EventRepository } from '../db/repositories/event-repository';
import { EventService } from './event-service';
import { RegistrationService } from './registration-service';
import { formatList, formatEventEnded } from './list-formatter';
import { formatClosed, formatOpenAnnouncement } from './event-formatter';
import { taipeiToUtcIso, utcIsoToTaipei } from '../db/time';
import type { EventRow } from '../db/schema';

// D-008 單場名額自動釋放（closed 索引移除 + 過期 open 惰性 flip + event_datetime 合併）。
// 對真 PG（PG-only）；過期判定不倚賴真實時鐘（用 FUTURE_ISO/PAST_ISO 固定值）。

const G = 'G-1';
const HOST = 'U-host';

function makeEvt(t: TestDb, superAdmins: string[] = [HOST]): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds: superAdmins,
    logError: () => {},
  });
}

function makeReg(t: TestDb): RegistrationService {
  return new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    logError: () => {},
  });
}

let mid = 0;
const nextMid = (): string => `d8-${(mid += 1)}`;

/** 直接建立一場活動（繞過確認流程，供構造過期/closed 前置狀態）。 */
async function createEvent(
  t: TestDb,
  opts: {
    eventDatetime: string;
    status?: 'open' | 'closed';
    groupId?: string;
    priceMode?: 'per_person' | 'split_venue';
    venueFee?: number;
    pricePerPerson?: number;
    capacity?: number;
    hostLineId?: string;
  },
): Promise<EventRow> {
  const host = await t.users.upsert(opts.hostLineId ?? HOST, '主辦人');
  return t.events.create({
    groupId: opts.groupId ?? G,
    hostUserId: host.id,
    eventDatetime: opts.eventDatetime,
    location: '東方球場',
    capacity: opts.capacity ?? 16,
    status: opts.status ?? 'open',
    ...(opts.priceMode === 'split_venue'
      ? { priceMode: 'split_venue' as const, venueFee: opts.venueFee ?? 3000 }
      : { priceMode: 'per_person' as const, pricePerPerson: opts.pricePerPerson ?? 2200 }),
  });
}

/** 布置一則 awaiting_confirm 對話（供 confirm 直接觸發 flip/建立）。 */
async function seedConfirmable(t: TestDb, userId: string): Promise<void> {
  await t.conversations.upsert({
    lineUserId: userId,
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

describe('D-008 單場名額自動釋放', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-008 AC-2] 過期 open 開團自動 flip done 並放行 + 名單顯示新 live', async () => {
    const old = await createEvent(t, { eventDatetime: PAST_ISO, status: 'open' });
    const evt = makeEvt(t);
    await seedConfirmable(t, HOST);
    const r = await evt.confirm({ groupId: G, executorLineUserId: HOST, messageId: nextMid(), hostDisplayName: '主辦人' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    // 舊事件 flip done、新事件 open 且同交易插入主辦首列。
    expect((await t.events.getById(old.id))?.status).toBe('done');
    expect(r.event.status).toBe('open');
    expect(r.event.id).toBeGreaterThan(old.id);
    expect(await t.registrations.countConfirmed(r.event.id)).toBe(1);
    // 名單顯示新事件（live）。
    const reg = makeReg(t);
    const list = await reg.getListView({ groupId: G, messageId: nextMid() });
    expect(list.kind).toBe('ok');
    if (list.kind === 'ok') {
      expect(list.phase).toBe('live');
      expect(list.view.event.id).toBe(r.event.id);
    }
  });

  it('[D-008 AC-3] 未過期 open 仍擋團（不 flip、不建立；confirm 分支清 conversation）', async () => {
    const active = await createEvent(t, { eventDatetime: FUTURE_ISO, status: 'open' });
    const evt = makeEvt(t);
    // 入口早退。
    expect((await evt.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() })).kind).toBe('already_active');
    // confirm 分支：布置 awaiting_confirm，confirm → already_active + 清 conversation、不 flip、不建立。
    await seedConfirmable(t, 'U-other');
    const r = await evt.confirm({ groupId: G, executorLineUserId: 'U-other', messageId: nextMid(), hostDisplayName: '別人' });
    expect(r.kind).toBe('already_active');
    expect(await t.conversations.get('U-other')).toBeUndefined(); // nit-1 清 conversation
    expect((await t.events.getById(active.id))?.status).toBe('open'); // 未 flip
    const cnt = await t.pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM events WHERE group_id = $1", [G]);
    expect(Number(cnt.rows[0]!.n)).toBe(1); // 未建立第二場
  });

  it('[D-008 AC-4] 過期 open 的 +N/-N 被拒（event_ended、不進 runImmediate、無寫入、無 flip）', async () => {
    const ev = await createEvent(t, { eventDatetime: PAST_ISO, status: 'open' });
    const reg = makeReg(t);
    const up = await reg.signup({ groupId: G, executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'ac4-up', count: 2 });
    expect(up.kind).toBe('event_ended');
    const down = await reg.cancel({ groupId: G, executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'ac4-dn', count: 1 });
    expect(down.kind).toBe('event_ended');
    // 拒絕文案 pin。
    expect(formatEventEnded().text).toBe('這場活動已結束，無法再報名／取消。');
    // 無 registrations 列、無 flip、未進 runImmediate（messageId 未 mark）。
    expect(await t.registrations.countConfirmed(ev.id)).toBe(0);
    expect((await t.events.getById(ev.id))?.status).toBe('open');
    expect(await t.processed.has('ac4-up')).toBe(false);
    expect(await t.processed.has('ac4-dn')).toBe(false);
  });

  it('[D-008 AC-5] 名單顯示活動已結束（ended；字串 pin，split + per_person）', async () => {
    // split：venue_fee=3000、正取 4 → 每人 750。
    const ev = await createEvent(t, { eventDatetime: PAST_ISO, status: 'open', priceMode: 'split_venue', venueFee: 3000, capacity: 16 });
    const member = await t.users.upsert('U-m', '成員');
    await t.runImmediate(ev.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: ev.id, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        4,
      ),
    );
    const reg = makeReg(t);
    const list = await reg.getListView({ groupId: G, messageId: nextMid() });
    expect(list.kind).toBe('ok');
    if (list.kind !== 'ok') return;
    expect(list.phase).toBe('ended');
    const text = formatList(list.view, list.phase).text;
    expect(text).toContain('[東方球場 球敘]（活動已結束）');
    expect(text).toContain('場地費：3000 元，每人 750 元（正取 4 人）');
    expect(text).not.toContain('暫估');
    expect(text).not.toContain('關閉報名後結算');
    expect(text).not.toContain('剩餘名額');
    expect(text).toContain('總金額：場地費 3000 元');
    expect(text).not.toContain('預估');

    // per_person 變體：總金額 4 × 2200 = 8800。
    const ppEvent: EventRow = { ...list.view.event, price_mode: 'per_person', venue_fee: null, price_per_person: 2200 };
    const ppText = formatList({ ...list.view, event: ppEvent }, 'ended').text;
    expect(ppText).toContain('總金額：4 × 2200 = 8800 元');
    expect(ppText).not.toContain('預估');
  });

  it('[D-008 AC-6] 兩並行開團僅一成功（同過期 open flip + insert；另撞 23505 → already_active）', async () => {
    const old = await createEvent(t, { eventDatetime: PAST_ISO, status: 'open' });
    const evt = makeEvt(t);
    await seedConfirmable(t, 'U-1');
    await seedConfirmable(t, 'U-2');
    const [r1, r2] = await Promise.all([
      evt.confirm({ groupId: G, executorLineUserId: 'U-1', messageId: nextMid(), hostDisplayName: 'U1' }),
      evt.confirm({ groupId: G, executorLineUserId: 'U-2', messageId: nextMid(), hostDisplayName: 'U2' }),
    ]);
    const kinds = [r1.kind, r2.kind].sort();
    expect(kinds).toEqual(['already_active', 'created']);
    // 舊過期 open 已 flip done；結束後至多一場 {draft,open}。
    expect((await t.events.getById(old.id))?.status).toBe('done');
    const active = await t.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM events WHERE group_id = $1 AND status IN ('draft','open')",
      [G],
    );
    expect(Number(active.rows[0]!.n)).toBe(1);
    // nit-2：勝者於交易內、落敗者於 catch(23505) 分支之另一交易皆清 conversation → 不卡 awaiting_confirm。
    expect(await t.conversations.get('U-1')).toBeUndefined();
    expect(await t.conversations.get('U-2')).toBeUndefined();
  });

  it('[D-008 AC-9] signup 鎖內以 getById 重讀最新列 re-check（見 done → event_ended、不插槽、無超賣）', async () => {
    const ev = await createEvent(t, { eventDatetime: FUTURE_ISO, status: 'open', capacity: 4 });
    const reg = makeReg(t);
    // findOpenEventForSignup（進交易前）讀到 live open（stale 快照）；
    // 鎖內 getById 模擬被並行 flip 為 done → re-check 見非 open → event_ended、不插槽。
    const spy = vi
      .spyOn(EventRepository.prototype, 'getById')
      .mockResolvedValue({ ...ev, status: 'done' });
    const r = await reg.signup({ groupId: G, executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'ac9', count: 1 });
    spy.mockRestore();
    expect(r.kind).toBe('event_ended');
    expect(await t.registrations.countConfirmed(ev.id)).toBe(0); // 不插槽、無超賣
  });

  it('[D-008 AC-9] signup 鎖內 re-check：仍 open 但鎖內已過期（非 done 分支）→ event_ended、不插槽', async () => {
    // 補強：AC-9 的第二種鎖內失效——read 於交易外未過期、進交易後鎖內重讀見「同列已跨過 event_datetime」
    //（status 仍 open、但 isExpired 為真），isOpenForSignup(fresh) 亦須為 false → event_ended、不插槽。
    const ev = await createEvent(t, { eventDatetime: FUTURE_ISO, status: 'open', capacity: 4 });
    const reg = makeReg(t);
    const spy = vi
      .spyOn(EventRepository.prototype, 'getById')
      .mockResolvedValue({ ...ev, status: 'open', event_datetime: PAST_ISO });
    const r = await reg.signup({ groupId: G, executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'ac9b', count: 1 });
    spy.mockRestore();
    expect(r.kind).toBe('event_ended');
    expect(await t.registrations.countConfirmed(ev.id)).toBe(0);
  });

  it('[D-008 AC-9] cancel(-N) 亦於鎖內以 getById re-check：見 done → event_ended、不取消（對稱 signup）', async () => {
    // 補強：AC-9 鎖內 re-check 對 -N 的對稱覆蓋。既有 AC-4 只驗「交易外」過期即拒；此驗「交易內」被 flip。
    // 先於未過期 open 佈一筆 confirmed（否則 candidates 空 → nothing_to_cancel 早退、不進交易）。
    const ev = await createEvent(t, { eventDatetime: FUTURE_ISO, status: 'open', capacity: 4 });
    const owner = await t.users.upsert('U-a', 'A');
    await t.runImmediate(ev.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: ev.id, ownerUserId: owner.id, displayName: 'A', kind: 'self', status: 'confirmed' },
        1,
      ),
    );
    const reg = makeReg(t);
    // 鎖內 getById 模擬被並行 flip 為 done → cancel re-check 見非 open → event_ended、不取消。
    const spy = vi
      .spyOn(EventRepository.prototype, 'getById')
      .mockResolvedValue({ ...ev, status: 'done' });
    const r = await reg.cancel({ groupId: G, executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'ac9c', count: 1 });
    spy.mockRestore();
    expect(r.kind).toBe('event_ended');
    // 該 confirmed 列未被取消 → 名單不變。
    expect(await t.registrations.countConfirmed(ev.id)).toBe(1);
  });

  it('[D-008 AC-11] closed 且已過期仍分類為 closed（status 優先於過期，不誤標 ended）', async () => {
    // 補強：displayPhase 先判 status==='closed'（不論時間，event-status.ts §2）。closed 且 event_datetime 已過
    //（closed 後時間也可能流逝）須仍為 phase='closed'「報名已截止」，不得被誤分類為 'ended'「活動已結束」。
    await createEvent(t, { eventDatetime: PAST_ISO, status: 'closed' });
    const reg = makeReg(t);
    const list = await reg.getListView({ groupId: G, messageId: nextMid() });
    expect(list.kind).toBe('ok');
    if (list.kind !== 'ok') return;
    expect(list.phase).toBe('closed'); // status 優先於過期，非 'ended'
    const text = formatList(list.view, list.phase).text;
    expect(text).toContain('（報名已截止）');
    expect(text).not.toContain('（活動已結束）');
  });

  it('[D-008 AC-7] event_datetime 存 UTC + 過期判定跨午夜邊界（純轉換）', () => {
    // 台灣 2026-08-15 07:30 → UTC 2026-08-14T23:30:00Z（跨 UTC 日界）。
    expect(taipeiToUtcIso('2026-08-15', '07:30')).toBe('2026-08-14T23:30:00Z');
    // 跨台灣午夜：2026-08-15 00:30 → 2026-08-14T16:30:00Z。
    expect(taipeiToUtcIso('2026-08-15', '00:30')).toBe('2026-08-14T16:30:00Z');
    // 過期判定：字串比較（now > event_datetime）。
    const store = '2026-08-14T23:30:00Z';
    expect('2026-08-14T23:29:00Z' > store).toBe(false); // 未過期
    expect('2026-08-14T23:31:00Z' > store).toBe(true); // 過期
  });

  it('[D-008 AC-10] 顯示時區還原一致（UTC → 台灣本地 = 輸入字面）', async () => {
    expect(utcIsoToTaipei('2026-08-14T23:30:00Z')).toEqual({ date: '2026-08-15', time: '07:30' });
    // 開團公告以 event_datetime 還原顯示。
    const ev = await createEvent(t, { eventDatetime: '2026-08-14T23:30:00Z', status: 'open' });
    expect(formatOpenAnnouncement(ev).text).toContain('日期：2026-08-15 07:30');
  });

  it('[D-008 AC-11] closed 名單顯示報名已截止（closed；字串 pin，最終結算列、無剩餘名額）', async () => {
    // split closed：settled_per_person 凍結（經 closeEvent 寫入）。
    const evt = makeEvt(t);
    // 建 open split → 4 人 → 關閉（凍結 settled）。
    const open = await createEvent(t, { eventDatetime: FUTURE_ISO, status: 'open', priceMode: 'split_venue', venueFee: 3000 });
    const member = await t.users.upsert('U-m', '成員');
    await t.runImmediate(open.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: open.id, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        4,
      ),
    );
    const closed = await evt.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(closed.kind).toBe('ok');
    if (closed.kind === 'ok') expect(closed.settledPerPerson).toBe(750);

    const reg = makeReg(t);
    const list = await reg.getListView({ groupId: G, messageId: nextMid() });
    expect(list.kind).toBe('ok');
    if (list.kind !== 'ok') return;
    expect(list.phase).toBe('closed');
    const text = formatList(list.view, list.phase).text;
    expect(text).toContain('[東方球場 球敘]（報名已截止）');
    expect(text).toContain('場地費：3000 元，每人 750 元（正取 4 人，最終結算）');
    expect(text).not.toContain('剩餘名額');
    expect(text).toContain('總金額：場地費 3000 元');
    expect(text).not.toContain('預估');
  });

  it('[D-008 AC-12] 顯示取 latest-by-id：closed #A 與新 open #B 並存 → 顯示 #B（live），#A 保留', async () => {
    const evt = makeEvt(t);
    // #A：open → closed。
    const a = await createEvent(t, { eventDatetime: FUTURE_ISO, status: 'open' });
    const closed = await evt.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(closed.kind).toBe('ok');
    // #B：closed 已釋放 → 可再開 open。
    await seedConfirmable(t, HOST);
    const b = await evt.confirm({ groupId: G, executorLineUserId: HOST, messageId: nextMid(), hostDisplayName: '主辦人' });
    expect(b.kind).toBe('created');
    if (b.kind !== 'created') return;

    const reg = makeReg(t);
    const list = await reg.getListView({ groupId: G, messageId: nextMid() });
    expect(list.kind).toBe('ok');
    if (list.kind === 'ok') {
      expect(list.phase).toBe('live');
      expect(list.view.event.id).toBe(b.event.id); // latest-by-id = #B
    }
    // #A 名單資料仍在（未刪，稽核保留）。
    expect((await t.events.getById(a.id))?.status).toBe('closed');
  });

  it('[D-008 AC-13] closed 用詞收斂（formatClosed：報名已截止；split 追加攤額、per_person 不追加）', () => {
    const base: EventRow = {
      id: 1, group_id: G, host_user_id: 1, event_datetime: FUTURE_ISO, location: '東方球場',
      capacity: 16, price_per_person: 0, price_mode: 'split_venue', venue_fee: 3000,
      settled_per_person: null, status: 'closed', created_at: FUTURE_ISO, updated_at: FUTURE_ISO,
    };
    const split = formatClosed(base, 750, 4).text;
    expect(split).toContain('「東方球場」球敘報名已截止，不再接受新報名。');
    expect(split).toContain('本場最終每人費用：750 元');
    const pp: EventRow = { ...base, price_mode: 'per_person', venue_fee: null, price_per_person: 2200 };
    expect(formatClosed(pp, null, 5).text).toBe('「東方球場」球敘報名已截止，不再接受新報名。');
  });
});
