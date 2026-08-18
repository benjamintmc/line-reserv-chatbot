import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { GroupingService } from './grouping-service';
import type { RandomFn } from './grouping';
import type { GroupingState } from './grouping';

function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOST = 'U-host';
const G = 'G-1';

function makeService(t: TestDb): GroupingService {
  return new GroupingService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: t.runInTransaction,
    rng: mulberry32(123),
  });
}

async function seedConfirmed(
  t: TestDb,
  eventId: number,
  hostId: number,
  guests: string[],
): Promise<void> {
  for (const name of guests) {
    await t.registrations.insertSlot({
      eventId,
      ownerUserId: hostId,
      displayName: name,
      kind: 'proxy',
      status: 'confirmed',
    });
  }
}

describe('D-011 GroupingService（唯讀名單 + session 暫存）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-011 AC-14] 只納 confirmed（含 proxy、排除 waitlist/cancelled）', async () => {
    const { host, event } = await seedEvent(t, { capacity: 20, groupId: G, hostLineId: HOST });
    // 2 confirmed self（host 本人多名額）+ 2 confirmed proxy
    await t.registrations.insertSlot({
      eventId: event.id,
      ownerUserId: host.id,
      displayName: '主辦人',
      kind: 'self',
      status: 'confirmed',
    });
    await t.registrations.insertSlot({
      eventId: event.id,
      ownerUserId: host.id,
      displayName: '主辦人',
      kind: 'self',
      status: 'confirmed',
    });
    await seedConfirmed(t, event.id, host.id, ['客A', '客B']);
    // 1 waitlist（排除）
    await t.registrations.insertSlot({
      eventId: event.id,
      ownerUserId: host.id,
      displayName: 'Y候補',
      kind: 'proxy',
      status: 'waitlist',
    });
    // 1 confirmed 後取消（排除）
    const toCancel = await t.registrations.insertSlot({
      eventId: event.id,
      ownerUserId: host.id,
      displayName: 'X取消',
      kind: 'proxy',
      status: 'confirmed',
    });
    await t.registrations.cancelByIds([toCancel.id], host.id);

    const res = await makeService(t).groupBalanced({
      groupId: G,
      executorLineUserId: HOST,
      messageId: 'g1',
    });
    if (res.kind !== 'balanced' || res.result.kind !== 'groups') throw new Error('expected groups');
    const names = res.result.groups.flat();
    expect(names).toHaveLength(4); // 2 self + 2 proxy confirmed
    expect(names).not.toContain('Y候補');
    expect(names).not.toContain('X取消');
    expect(names.filter((n) => n.startsWith('主辦人'))).toHaveLength(2); // 名字(k) 後綴
  });

  it('no_open_event：群組無 active event → no_open_event', async () => {
    const res = await makeService(t).groupBalanced({
      groupId: 'G-empty',
      executorLineUserId: HOST,
      messageId: 'g1',
    });
    expect(res.kind).toBe('no_open_event');
  });

  it('not_authorized：非主辦（含 super-admin）→ not_authorized（errata host-only；super-admin 亦拒）', async () => {
    const { host, event } = await seedEvent(t, { capacity: 8, groupId: G, hostLineId: HOST });
    await seedConfirmed(t, event.id, host.id, ['客A', '客B', '客C', '客D']);
    const res = await makeService(t).groupBalanced({
      groupId: G,
      executorLineUserId: 'U-other',
      messageId: 'g1',
    });
    expect(res.kind).toBe('not_authorized');
    // 排除 super-admin：非該場 host_user_id 一律拒（errata；service 已不知 admin 概念）。
    const adminRes = await makeService(t).groupBalanced({ groupId: G, executorLineUserId: 'U-admin', messageId: 'g2' });
    expect(adminRes.kind).toBe('not_authorized');
    // host 通過（sanity）。
    const hostRes = await makeService(t).groupBalanced({ groupId: G, executorLineUserId: HOST, messageId: 'g3' });
    expect(hostRes.kind).toBe('balanced');
  });

  it('[D-011 AC-24] 策略B session 存於 conversation_states（state=grouping、payload JSON）', async () => {
    const { host, event } = await seedEvent(t, { capacity: 8, groupId: G, hostLineId: HOST });
    await seedConfirmed(t, event.id, host.id, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const svc = makeService(t);

    const r1 = await svc.startRounds({
      groupId: G,
      executorLineUserId: HOST,
      messageId: 'g1',
      courts: 2,
      mode: 'doubles',
    });
    if (r1.kind !== 'round') throw new Error('expected round');
    expect(r1.round.round).toBe(1);

    const conv = await t.conversations.get(HOST);
    expect(conv?.state).toBe('grouping');
    const state = JSON.parse(conv!.payload!) as GroupingState;
    expect(state.round).toBe(1);
    expect(state.labels).toHaveLength(8);

    // 下一輪：讀 session → 第 2 輪 → 寫回。
    const r2 = await svc.nextRound({ groupId: G, executorLineUserId: HOST, messageId: 'g2' });
    if (r2.kind !== 'round') throw new Error('expected round');
    expect(r2.round.round).toBe(2);
  });

  it('[D-011 AC-23][AC-24] 策略A 不寫 session；無 session 時 下一輪 → no_session', async () => {
    const { host, event } = await seedEvent(t, { capacity: 8, groupId: G, hostLineId: HOST });
    await seedConfirmed(t, event.id, host.id, ['客A', '客B', '客C', '客D']);
    const svc = makeService(t);

    const balanced = await svc.groupBalanced({
      groupId: G,
      executorLineUserId: HOST,
      messageId: 'g1',
    });
    expect(balanced.kind).toBe('balanced');
    expect(await t.conversations.get(HOST)).toBeUndefined(); // 策略A 不寫 session

    const next = await svc.nextRound({ groupId: G, executorLineUserId: HOST, messageId: 'g2' });
    expect(next.kind).toBe('no_session');
  });

  it('startRounds duplicate messageId → duplicate（冪等）', async () => {
    const { host, event } = await seedEvent(t, { capacity: 8, groupId: G, hostLineId: HOST });
    await seedConfirmed(t, event.id, host.id, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const svc = makeService(t);
    await svc.startRounds({ groupId: G, executorLineUserId: HOST, messageId: 'dup', courts: 2, mode: 'doubles' });
    const again = await svc.nextRound({ groupId: G, executorLineUserId: HOST, messageId: 'dup' });
    expect(again.kind).toBe('duplicate');
  });
  // ── errata 2026-08-18（T-018 review B1）：`下一輪` 跨群 ──────────────────
  it('[D-011 AC-23 errata 跨群] A 群開分組 session，同一主辦在 B 群「下一輪」→ no_session、不外洩 A 群名單、A 群 session 不被推進', async () => {
    const { host, event } = await seedEvent(t, { capacity: 8, groupId: G, hostLineId: HOST });
    await seedConfirmed(t, event.id, host.id, ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']);
    const svc = makeService(t);

    const r1 = await svc.startRounds({
      groupId: G,
      executorLineUserId: HOST,
      messageId: 'g1',
      courts: 2,
      mode: 'doubles',
    });
    if (r1.kind !== 'round') throw new Error('expected round');

    // B 群（無 active event、非該場）同一主辦輸入 `下一輪` → no_session（不得讀到 A 群凍結名單）。
    const cross = await svc.nextRound({ groupId: 'G-B', executorLineUserId: HOST, messageId: 'g2' });
    expect(cross.kind).toBe('no_session');
    expect(await t.processed.has('g2')).toBe(false); // 不 mark、無副作用

    // A 群 session 未被推進（仍停在第 1 輪）。
    const state = JSON.parse((await t.conversations.get(HOST))!.payload!) as GroupingState;
    expect(state.round).toBe(1);

    // 回 A 群 `下一輪` → 正常第 2 輪。
    const r2 = await svc.nextRound({ groupId: G, executorLineUserId: HOST, messageId: 'g3' });
    if (r2.kind !== 'round') throw new Error('expected round');
    expect(r2.round.round).toBe(2);
  });

  // ── errata 2026-08-18（T-018 review B2）：策略A 去重 ────────────────────
  it('[D-011 AC-24 errata 去重] 策略A 同一 messageId 重送 → duplicate（不重算、不二次回覆），且仍不寫 session', async () => {
    const { host, event } = await seedEvent(t, { capacity: 8, groupId: G, hostLineId: HOST });
    await seedConfirmed(t, event.id, host.id, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const svc = makeService(t);

    const first = await svc.groupBalanced({ groupId: G, executorLineUserId: HOST, messageId: 'm1' });
    expect(first.kind).toBe('balanced');
    expect(await t.processed.has('m1')).toBe(true);

    const resend = await svc.groupBalanced({ groupId: G, executorLineUserId: HOST, messageId: 'm1' });
    expect(resend.kind).toBe('duplicate'); // 重送不重骰、不回覆
    expect(await t.conversations.get(HOST)).toBeUndefined(); // 策略A 仍不寫 session
  });
});
