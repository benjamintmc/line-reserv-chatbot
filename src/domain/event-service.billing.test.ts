import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { EventService } from './event-service';
import { RegistrationService } from './registration-service';
import { formatClosed } from './event-formatter';
import { formatList } from './list-formatter';
import type { ListResult } from './registration-service';

const HOST = 'U-host';
const G = 'G-1';

function makeServices(t: TestDb): { evt: EventService; reg: RegistrationService } {
  const evt = new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds: [HOST],
    logError: () => {},
  });
  const reg = new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    logError: () => {},
  });
  return { evt, reg };
}

let mid = 0;
function nextMid(): string {
  mid += 1;
  return `bm${mid}`;
}

/** 建立一場 open 活動（一行式 → 確認），回傳 event id。主辦自動登記為第 1 正取。 */
async function openEvent(
  evt: EventService,
  opts: { priceMode: 'per_person' | 'split_venue'; price?: number; venueFee?: number; capacity?: number },
): Promise<number> {
  await evt.handleOneline({
    groupId: G,
    executorLineUserId: HOST,
    messageId: nextMid(),
    date: '2026-08-15',
    time: '07:30',
    location: '東方球場',
    capacity: opts.capacity ?? 16,
    price: opts.price ?? 0,
    priceMode: opts.priceMode,
    venueFee: opts.venueFee,
  });
  const r = await evt.confirm({ groupId: G, executorLineUserId: HOST, messageId: nextMid(), hostDisplayName: '主辦人' });
  if (r.kind !== 'created') throw new Error('confirm 未建立');
  return r.event.id;
}

async function listText(reg: RegistrationService): Promise<string> {
  const r = (await reg.getListView({ groupId: G, messageId: nextMid() })) as ListResult;
  if (r.kind !== 'ok') throw new Error('list 非 ok');
  return formatList(r.view).text;
}

describe('EventService 計費（D-005 §3–§4）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-005 AC-3] 主辦自動登記為第 1 正取（seq=1/self/confirmed/owner=host.id/快照名/未取消）', async () => {
    const { evt } = makeServices(t);
    const eventId = await openEvent(evt, { priceMode: 'per_person', price: 2200 });
    const res = await t.pool.query<{
      seq: number; kind: string; status: string; owner_user_id: number; display_name: string; cancelled_at: string | null;
    }>('SELECT * FROM registrations WHERE event_id = $1 ORDER BY seq', [eventId]);
    const rows = res.rows;
    expect(rows).toHaveLength(1);
    const host = (await t.users.getByLineUserId(HOST))!;
    expect(rows[0]!.seq).toBe(1);
    expect(rows[0]!.kind).toBe('self');
    expect(rows[0]!.status).toBe('confirmed');
    expect(rows[0]!.owner_user_id).toBe(host.id);
    expect(rows[0]!.display_name).toBe('主辦人');
    expect(rows[0]!.cancelled_at).toBeNull();
    // 名單第 1 位為主辦。
    expect((await t.registrations.listConfirmed(eventId))[0]!.owner_user_id).toBe(host.id);
    expect(await t.registrations.countConfirmed(eventId)).toBe(1);
  });

  it('[D-005 AC-4] split +N 後均攤重算：主辦(1) +3 → 正取4 → 每人約 750', async () => {
    const { evt, reg } = makeServices(t);
    await openEvent(evt, { priceMode: 'split_venue', venueFee: 3000 });
    // 主辦後正取=1（估 3000）。
    expect(await listText(reg)).toContain('平均每人約 3000 元（暫估，關閉報名後結算）');
    // 成員 +3 → 正取=4 → ceil(3000/4)=750。
    await reg.signup({ groupId: G, executorLineUserId: 'U-m', executorDisplayName: '成員', messageId: nextMid(), count: 3 });
    expect(await listText(reg)).toContain('平均每人約 750 元（暫估，關閉報名後結算）');
  });

  it('[D-005 AC-5] split -N 後均攤重算：正取4(每人750) -1 → 正取3 → 每人約 1000', async () => {
    const { evt, reg } = makeServices(t);
    await openEvent(evt, { priceMode: 'split_venue', venueFee: 3000 });
    await reg.signup({ groupId: G, executorLineUserId: 'U-m', executorDisplayName: '成員', messageId: nextMid(), count: 3 });
    expect(await listText(reg)).toContain('平均每人約 750 元');
    // 成員 -1 → 正取=3 → ceil(3000/3)=1000。
    await reg.cancel({ groupId: G, executorLineUserId: 'U-m', executorDisplayName: '成員', messageId: nextMid(), count: 1 });
    expect(await listText(reg)).toContain('平均每人約 1000 元（暫估，關閉報名後結算）');
  });

  it('[D-005 AC-7] split 關閉報名 → 持久化 settled_per_person=429 + 公告最終攤額', async () => {
    const { evt, reg } = makeServices(t);
    const eventId = await openEvent(evt, { priceMode: 'split_venue', venueFee: 3000 });
    // 主辦(1) + 成員 +6 = 正取7 → ceil(3000/7)=429。
    await reg.signup({ groupId: G, executorLineUserId: 'U-m', executorDisplayName: '成員', messageId: nextMid(), count: 6 });
    const close = await evt.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(close.kind).toBe('ok');
    if (close.kind !== 'ok') return;
    expect(close.confirmedCount).toBe(7);
    expect(close.settledPerPerson).toBe(429);
    // 交易內持久化。
    expect((await t.events.getById(eventId))?.settled_per_person).toBe(429);
    // 公告最終攤額（formatClosed 以 settledPerPerson 為唯一真相來源）。
    const msg = formatClosed(close.event, close.settledPerPerson, close.confirmedCount).text;
    expect(msg).toContain('本場最終每人費用：429 元');
    expect(msg).toContain('場地費 3000 元 ÷ 正取 7 人');
    expect(msg).toContain('多收部分不另找零');
  });

  it('[D-005 AC-8] per_person 關閉報名 → settled_per_person 維持 NULL、不附結算列', async () => {
    const { evt } = makeServices(t);
    const eventId = await openEvent(evt, { priceMode: 'per_person', price: 2200 });
    const close = await evt.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(close.kind).toBe('ok');
    if (close.kind !== 'ok') return;
    expect(close.settledPerPerson).toBeNull();
    expect((await t.events.getById(eventId))?.settled_per_person).toBeNull();
    const msg = formatClosed(close.event, close.settledPerPerson, close.confirmedCount).text;
    expect(msg).toBe('「東方球場」球敘報名已截止，不再接受新報名。');
    expect(msg).not.toContain('最終每人費用');
  });
});
