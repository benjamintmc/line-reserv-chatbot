import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, PAST_ISO, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from './registration-service';

// D-010 加開名額（`加開 N`）：AC-1..8。
// seedEvent 建 open 活動（host='U-host'），無自動報名列 → confirmed 由測試以 signup 撐起。

function makeService(t: TestDb, adminIds: string[] = []): RegistrationService {
  return new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    superAdminUserIds: adminIds,
    logError: () => {},
  });
}

let mid = 0;
function nextMid(): string {
  mid += 1;
  return `m${mid}`;
}

/** 以 signup 填 count 位正取（同一 owner，單批 confirmed）。 */
async function fillConfirmed(svc: RegistrationService, groupId: string, count: number): Promise<void> {
  await svc.signup({
    groupId,
    executorLineUserId: 'U-fill',
    executorDisplayName: '填充',
    messageId: nextMid(),
    count,
  });
}

/** 逐一加候補（各自 owner，seq 依序遞增）。回傳各人 line userId。 */
async function addWaitlisters(
  svc: RegistrationService,
  groupId: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    await svc.signup({
      groupId,
      executorLineUserId: `U-${name}`,
      executorDisplayName: name,
      messageId: nextMid(),
      count: 1,
    });
  }
}

describe('RegistrationService.addCapacity（D-010）', () => {
  let t: TestDb;
  beforeEach(async () => {
    mid = 0;
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-010 AC-1] capacity=16/confirmed=16/waitlist=[w1,w2]，host 加開 3 → capacity=19、w1w2 遞補、剩餘 1', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const svc = makeService(t);
    await fillConfirmed(svc, 'G', 16);
    await addWaitlisters(svc, 'G', ['w1', 'w2']);
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(2);

    const r = await svc.addCapacity({
      groupId: 'G',
      executorLineUserId: 'U-host',
      messageId: nextMid(),
      count: 3,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.added).toBe(3);
    expect(r.newCapacity).toBe(19);
    expect(r.promoted.map((x) => x.display_name)).toEqual(['w1', 'w2']);
    expect((await t.events.getById(event.id))!.capacity).toBe(19);
    expect(await t.registrations.countConfirmed(event.id)).toBe(18);
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(0);
    expect(r.view.available).toBe(1);
  });

  it('[D-010 AC-2] capacity=10/confirmed=10/waitlist 5，加開 2 → 恰遞補最小 seq 2 人（12/12）、餘 3 候補', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G' });
    const svc = makeService(t);
    await fillConfirmed(svc, 'G', 10);
    await addWaitlisters(svc, 'G', ['a', 'b', 'c', 'd', 'e']);

    const r = await svc.addCapacity({
      groupId: 'G',
      executorLineUserId: 'U-host',
      messageId: nextMid(),
      count: 2,
    });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.newCapacity).toBe(12);
    // 最小 seq 兩位＝a、b。
    expect(r.promoted.map((x) => x.display_name)).toEqual(['a', 'b']);
    expect(await t.registrations.countConfirmed(event.id)).toBe(12);
    expect(await t.registrations.countConfirmed(event.id)).toBeLessThanOrEqual(12);
    expect((await t.registrations.listWaitlist(event.id)).map((w) => w.display_name)).toEqual([
      'c',
      'd',
      'e',
    ]);
  });

  it('[D-010 AC-3] 兩則不同 messageId 的 加開 1 真並行 → 序列化後 capacity+2、有效正取數 ≤ 最終 capacity', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const svc = makeService(t);
    await fillConfirmed(svc, 'G', 16);
    await addWaitlisters(svc, 'G', ['w1', 'w2']);

    const [r1, r2] = await Promise.all([
      svc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: nextMid(), count: 1 }),
      svc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: nextMid(), count: 1 }),
    ]);
    expect([r1.kind, r2.kind]).toEqual(['ok', 'ok']);
    const finalCap = (await t.events.getById(event.id))!.capacity;
    expect(finalCap).toBe(18); // 16 + 1 + 1（序列化，各讀鎖內最新 capacity）
    const confirmed = await t.registrations.countConfirmed(event.id);
    expect(confirmed).toBeLessThanOrEqual(finalCap); // 無越界 confirmed（不超賣）
    expect(confirmed).toBe(18); // 兩候補皆遞補
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(0);
  });

  it('[D-010 AC-4] closed/cancelled/過期 open/無活動 加開 2 → 拒絕、capacity 不變、無遞補', async () => {
    // (a) closed → no_open_event（不在 active 集）。
    {
      const { event } = await seedEvent(t, { capacity: 8, groupId: 'Gc', status: 'closed' });
      const svc = makeService(t);
      const r = await svc.addCapacity({ groupId: 'Gc', executorLineUserId: 'U-host', messageId: nextMid(), count: 2 });
      expect(r.kind).toBe('no_open_event');
      expect((await t.events.getById(event.id))!.capacity).toBe(8);
    }
    // (b) cancelled → no_open_event。
    {
      const { event } = await seedEvent(t, { capacity: 8, groupId: 'Gx', status: 'cancelled' });
      const svc = makeService(t);
      const r = await svc.addCapacity({ groupId: 'Gx', executorLineUserId: 'U-host', messageId: nextMid(), count: 2 });
      expect(r.kind).toBe('no_open_event');
      expect((await t.events.getById(event.id))!.capacity).toBe(8);
    }
    // (c) 過期 open → event_ended。
    {
      const { event } = await seedEvent(t, { capacity: 8, groupId: 'Ge', status: 'open', eventDatetime: PAST_ISO });
      const svc = makeService(t);
      const r = await svc.addCapacity({ groupId: 'Ge', executorLineUserId: 'U-host', messageId: nextMid(), count: 2 });
      expect(r.kind).toBe('event_ended');
      expect((await t.events.getById(event.id))!.capacity).toBe(8);
    }
    // (d) 無活動 → no_open_event。
    {
      const svc = makeService(t);
      const r = await svc.addCapacity({ groupId: 'G-none', executorLineUserId: 'U-host', messageId: nextMid(), count: 2 });
      expect(r.kind).toBe('no_open_event');
    }
  });

  it('[D-010 AC-5] 非 host 非 super-admin → not_authorized、capacity 不變、users 無新列；host 與 super-admin 皆可加開', async () => {
    const { event } = await seedEvent(t, { capacity: 8, groupId: 'G' });
    const strangerSvc = makeService(t); // 無 super-admin
    const r = await strangerSvc.addCapacity({
      groupId: 'G',
      executorLineUserId: 'U-mallory',
      messageId: nextMid(),
      count: 2,
    });
    expect(r.kind).toBe('not_authorized');
    expect((await t.events.getById(event.id))!.capacity).toBe(8);
    // G4：非授權者無 DB 變更——未被 upsert 進 users。
    expect(await t.users.getByLineUserId('U-mallory')).toBeUndefined();

    // host 可加開。
    const rHost = await strangerSvc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: nextMid(), count: 1 });
    expect(rHost.kind).toBe('ok');
    expect((await t.events.getById(event.id))!.capacity).toBe(9);

    // super-admin（非 host）可加開。
    const adminSvc = makeService(t, ['U-super']);
    const rAdmin = await adminSvc.addCapacity({ groupId: 'G', executorLineUserId: 'U-super', messageId: nextMid(), count: 1 });
    expect(rAdmin.kind).toBe('ok');
    expect((await t.events.getById(event.id))!.capacity).toBe(10);
  });

  it('[D-010 AC-6] 加開後 capacity 嚴格增加、無 confirmed→waitlist 降級', async () => {
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G' });
    const svc = makeService(t);
    await fillConfirmed(svc, 'G', 4);
    const before = await t.registrations.listConfirmed(event.id);

    const r = await svc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: nextMid(), count: 2 });
    expect(r.kind).toBe('ok');
    expect((await t.events.getById(event.id))!.capacity).toBe(6); // 嚴格增加
    // 既有正取無一被降級為 waitlist。
    const after = await t.registrations.listConfirmed(event.id);
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(0);
  });

  it('[D-010 AC-7] 加開使 newCapacity>MAX_CAPACITY → over_limit、capacity 不變、無遞補', async () => {
    const { event } = await seedEvent(t, { capacity: 999, groupId: 'G' });
    const svc = makeService(t);
    // 撐 1 位候補以驗證 over_limit 不觸發遞補。
    await fillConfirmed(svc, 'G', 999);
    await addWaitlisters(svc, 'G', ['w1']);

    const r = await svc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: nextMid(), count: 2 });
    expect(r.kind).toBe('over_limit'); // 999+2=1001 > MAX_CAPACITY(1000)
    expect((await t.events.getById(event.id))!.capacity).toBe(999);
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(1); // 未遞補
  });

  it('[D-010 AC-8] 同 message_id 的 加開 2 連續兩次 → 第二次 markProcessed=false 中止 → capacity 只增一次', async () => {
    const { event } = await seedEvent(t, { capacity: 8, groupId: 'G' });
    const svc = makeService(t);
    const dupMid = 'dup-1';
    const r1 = await svc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: dupMid, count: 2 });
    expect(r1.kind).toBe('ok');
    expect((await t.events.getById(event.id))!.capacity).toBe(10);

    const r2 = await svc.addCapacity({ groupId: 'G', executorLineUserId: 'U-host', messageId: dupMid, count: 2 });
    expect(r2.kind).toBe('duplicate');
    expect((await t.events.getById(event.id))!.capacity).toBe(10); // 未再增
  });
});
