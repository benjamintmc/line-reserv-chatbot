import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { EventService } from './event-service';
import { RegistrationService } from './registration-service';
import { formatClosed } from './event-formatter';
import { formatList } from './list-formatter';
import type { ListResult } from './registration-service';

// unit-tester 補強（D-005）：
//  1. split 關閉結算以「凍結後的實際正取數」為分母（countConfirmed 過濾 soft-delete）——
//     既有 AC-7 僅測全員留下（7 人）；此處驗證中途取消後 close 的攤額確反映減少後人數。
//  2. OP-1 主辦以 `-1` 移除自己 → 真實 confirmedCount=0 的 max(,1) 保底路徑（既有 AC-15
//     僅測純函式傳 0；此處以完整報名/取消流程觸發，驗證名單/關閉不 NaN/不 throw）。

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
  return `bs${mid}`;
}

async function openSplit(evt: EventService, venueFee: number): Promise<number> {
  await evt.handleOneline({
    groupId: G,
    executorLineUserId: HOST,
    messageId: nextMid(),
    date: '2999-08-15',
    time: '07:30',
    location: '東方球場',
    capacity: 16,
    price: 0,
    priceMode: 'split_venue',
    venueFee,
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

describe('EventService 計費補強（D-005 結算凍結 / OP-1 主辦自移）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-005 AC-7] split 關閉結算以「凍結後實際正取數」為分母：+6 後 -2 → 正取 5 → ceil(3000/5)=600', async () => {
    const { evt, reg } = makeServices(t);
    const eventId = await openSplit(evt, 3000);
    // 主辦(1) + 成員 +6 = 7。
    await reg.signup({ groupId: G, executorLineUserId: 'U-m', executorDisplayName: '成員', messageId: nextMid(), count: 6 });
    expect(await t.registrations.countConfirmed(eventId)).toBe(7);
    // 成員 -2 → 正取 5（soft-delete，實體列仍在但被過濾）。
    await reg.cancel({ groupId: G, executorLineUserId: 'U-m', executorDisplayName: '成員', messageId: nextMid(), count: 2 });
    expect(await t.registrations.countConfirmed(eventId)).toBe(5);

    const close = await evt.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(close.kind).toBe('ok');
    if (close.kind !== 'ok') return;
    // 分母為凍結後的 5（非 7），ceil(3000/5)=600。
    expect(close.confirmedCount).toBe(5);
    expect(close.settledPerPerson).toBe(600);
    expect((await t.events.getById(eventId))?.settled_per_person).toBe(600);
    const msg = formatClosed(close.event, close.settledPerPerson, close.confirmedCount).text;
    expect(msg).toContain('本場最終每人費用：600 元');
    expect(msg).toContain('÷ 正取 5 人');
  });

  it('[D-005 AC-15] OP-1 主辦 `-1` 移除自己 → 真實 confirmedCount=0：名單顯示 venue_fee、不 NaN/不 throw', async () => {
    const { evt, reg } = makeServices(t);
    const eventId = await openSplit(evt, 3000);
    expect(await t.registrations.countConfirmed(eventId)).toBe(1);
    // 主辦以 -1 取消自己的第 1 正取（seq=1、owner=host）。
    await reg.cancel({ groupId: G, executorLineUserId: HOST, executorDisplayName: '主辦人', messageId: nextMid(), count: 1 });
    expect(await t.registrations.countConfirmed(eventId)).toBe(0);
    // 名單費用列以 max(,1) 保底 → 平均每人約 venue_fee 元，且仍標暫估；不得出現 NaN/Infinity。
    const text = await listText(reg);
    expect(text).toContain('平均每人約 3000 元（暫估，關閉報名後結算）');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });

  it('[D-005 AC-15] 主辦自移後關閉（confirmedCount=0）：結算 ceil(3000/max(0,1))=3000、不 throw', async () => {
    const { evt, reg } = makeServices(t);
    const eventId = await openSplit(evt, 3000);
    await reg.cancel({ groupId: G, executorLineUserId: HOST, executorDisplayName: '主辦人', messageId: nextMid(), count: 1 });
    expect(await t.registrations.countConfirmed(eventId)).toBe(0);
    const close = await evt.closeEvent({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(close.kind).toBe('ok');
    if (close.kind !== 'ok') return;
    expect(close.confirmedCount).toBe(0);
    expect(close.settledPerPerson).toBe(3000);
    expect(Number.isFinite(close.settledPerPerson!)).toBe(true);
    expect((await t.events.getById(eventId))?.settled_per_person).toBe(3000);
  });
});
