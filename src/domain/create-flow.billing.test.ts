import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { createTransactionRunner } from '../db/tx';
import { EventService } from './event-service';
import { applyAnswer } from './create-flow';

const HOST = 'U-host';
const G = 'G-1';

function makeSvc(t: TestDb): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: createTransactionRunner(t.db),
    hostUserIds: [HOST],
    logError: () => {},
  });
}

let mid = 0;
function next(): string {
  mid += 1;
  return `cf${mid}`;
}
function step(svc: EventService, text: string): ReturnType<EventService['continueFlow']> {
  return svc.continueFlow({ groupId: G, executorLineUserId: HOST, messageId: next(), text, hostDisplayName: '主辦人' });
}
/** 走到 awaiting_price_mode（date→time→location→capacity 完成）。 */
function walkToPriceMode(svc: EventService): void {
  svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: next() });
  step(svc, '2026/08/15');
  step(svc, '07:30');
  step(svc, '東方球場');
  const r = step(svc, '16');
  if (r.kind === 'advanced') expect(r.state).toBe('awaiting_price_mode');
}

describe('create-flow 計費方式分支（D-005 §6.2）', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-005 AC-10] 逐步問答「場地費」分支 → awaiting_venue_fee → 3000 → split 建立', () => {
    const svc = makeSvc(t);
    walkToPriceMode(svc);
    const mode = step(svc, '場地費');
    expect(mode.kind).toBe('advanced');
    if (mode.kind === 'advanced') expect(mode.state).toBe('awaiting_venue_fee');
    const fee = step(svc, '3000');
    expect(fee.kind).toBe('awaiting_confirm');
    const payload = JSON.parse(t.conversations.get(HOST)!.payload ?? '{}');
    expect(payload.priceMode).toBe('split_venue');
    expect(payload.venueFee).toBe(3000);
    const done = step(svc, '確認');
    expect(done.kind).toBe('created');
    if (done.kind !== 'created') return;
    expect(done.event.price_mode).toBe('split_venue');
    expect(done.event.venue_fee).toBe(3000);
    expect(done.event.price_per_person).toBe(0);
  });

  it('[D-005 AC-10] 逐步問答「每人」分支 → awaiting_price → 2200 → per_person 建立', () => {
    const svc = makeSvc(t);
    walkToPriceMode(svc);
    const mode = step(svc, '每人');
    expect(mode.kind).toBe('advanced');
    if (mode.kind === 'advanced') expect(mode.state).toBe('awaiting_price');
    const price = step(svc, '2200');
    expect(price.kind).toBe('awaiting_confirm');
    const done = step(svc, '確認');
    expect(done.kind).toBe('created');
    if (done.kind !== 'created') return;
    expect(done.event.price_mode).toBe('per_person');
    expect(done.event.price_per_person).toBe(2200);
    expect(done.event.venue_fee).toBeNull();
  });

  it('[D-005 AC-17] awaiting_price_mode 裸數字/其他字 → field_error 停留、不前進、不猜測；隨後合法前進', () => {
    const svc = makeSvc(t);
    walkToPriceMode(svc);
    // 裸數字 2200 → 重問、停留（不當金額）。
    const bad1 = step(svc, '2200');
    expect(bad1.kind).toBe('field_error');
    if (bad1.kind === 'field_error') expect(bad1.state).toBe('awaiting_price_mode');
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_price_mode');
    expect(JSON.parse(t.conversations.get(HOST)!.payload ?? '{}').priceMode).toBeUndefined();
    // 其他字 → 重問、停留。
    const bad2 = step(svc, '隨便');
    expect(bad2.kind).toBe('field_error');
    // 合法「場地費」→ 前進。
    const ok = step(svc, '場地費');
    expect(ok.kind).toBe('advanced');
    if (ok.kind === 'advanced') expect(ok.state).toBe('awaiting_venue_fee');
  });

  it('[D-005 AC-17] awaiting_venue_fee 非正整數（0/abc）→ field_error 停留；正整數前進', () => {
    const svc = makeSvc(t);
    walkToPriceMode(svc);
    step(svc, '場地費');
    expect(step(svc, '0').kind).toBe('field_error');
    expect(step(svc, 'abc').kind).toBe('field_error');
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_venue_fee');
    const ok = step(svc, '3000');
    expect(ok.kind).toBe('awaiting_confirm');
  });

  it('[D-005 AC-17] applyAnswer 純函式：awaiting_price_mode 只接受每人/場地費/均攤', () => {
    expect(applyAnswer('awaiting_price_mode', {}, '2200').ok).toBe(false);
    expect(applyAnswer('awaiting_price_mode', {}, '').ok).toBe(false);
    const p = applyAnswer('awaiting_price_mode', {}, '每人');
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.payload.priceMode).toBe('per_person');
    const s = applyAnswer('awaiting_price_mode', {}, '場地費');
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.payload.priceMode).toBe('split_venue');
    const s2 = applyAnswer('awaiting_price_mode', {}, '均攤');
    expect(s2.ok).toBe(true);
    if (s2.ok) expect(s2.payload.priceMode).toBe('split_venue');
  });
});
