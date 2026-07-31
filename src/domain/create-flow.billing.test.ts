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
    superAdminUserIds: [HOST],
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
/** 走到 awaiting_fee（date→time→location→capacity 完成）。 */
function walkToFee(svc: EventService): void {
  svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: next() });
  step(svc, '2026/08/15');
  step(svc, '07:30');
  step(svc, '東方球場');
  const r = step(svc, '16');
  if (r.kind === 'advanced') expect(r.state).toBe('awaiting_fee');
}

describe('create-flow 單題計費（D-005 §6.2 修訂）', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-005 AC-10] 單題「場地費3000」→ split/venueFee=3000/price=0 → awaiting_confirm → 建立', () => {
    const svc = makeSvc(t);
    walkToFee(svc);
    const fee = step(svc, '場地費3000');
    expect(fee.kind).toBe('awaiting_confirm');
    const payload = JSON.parse(t.conversations.get(HOST)!.payload ?? '{}');
    expect(payload.priceMode).toBe('split_venue');
    expect(payload.venueFee).toBe(3000);
    expect(payload.price).toBe(0);
    const done = step(svc, '確認');
    expect(done.kind).toBe('created');
    if (done.kind !== 'created') return;
    expect(done.event.price_mode).toBe('split_venue');
    expect(done.event.venue_fee).toBe(3000);
    expect(done.event.price_per_person).toBe(0);
  });

  it('[D-005 AC-10] 單題含空白「場地費 3000」（帶空白）→ split/venueFee=3000', () => {
    const svc = makeSvc(t);
    walkToFee(svc);
    const fee = step(svc, '場地費 3000');
    expect(fee.kind).toBe('awaiting_confirm');
    const payload = JSON.parse(t.conversations.get(HOST)!.payload ?? '{}');
    expect(payload.priceMode).toBe('split_venue');
    expect(payload.venueFee).toBe(3000);
  });

  it('[D-005 AC-10] 單題「2200」（裸金額）→ per_person/price=2200', () => {
    const svc = makeSvc(t);
    walkToFee(svc);
    const fee = step(svc, '2200');
    expect(fee.kind).toBe('awaiting_confirm');
    const done = step(svc, '確認');
    expect(done.kind).toBe('created');
    if (done.kind !== 'created') return;
    expect(done.event.price_mode).toBe('per_person');
    expect(done.event.price_per_person).toBe(2200);
    expect(done.event.venue_fee).toBeNull();
  });

  it('[D-005 AC-10] 單題「每人2200」與含空白「每人 2200」→ per_person/price=2200', () => {
    const svc = makeSvc(t);
    walkToFee(svc);
    expect(step(svc, '每人2200').kind).toBe('awaiting_confirm');
    const payload = JSON.parse(t.conversations.get(HOST)!.payload ?? '{}');
    expect(payload.priceMode).toBe('per_person');
    expect(payload.price).toBe(2200);
  });

  it('[D-005 AC-17] awaiting_fee 無效答案（abc/-1/空）→ field_error 停留、不前進；隨後合法前進', () => {
    const svc = makeSvc(t);
    walkToFee(svc);
    const bad1 = step(svc, 'abc');
    expect(bad1.kind).toBe('field_error');
    if (bad1.kind === 'field_error') expect(bad1.state).toBe('awaiting_fee');
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_fee');
    expect(JSON.parse(t.conversations.get(HOST)!.payload ?? '{}').priceMode).toBeUndefined();
    // 場地費 0 → 無效（>0）停留。
    expect(step(svc, '場地費0').kind).toBe('field_error');
    expect(t.conversations.get(HOST)?.state).toBe('awaiting_fee');
    // 合法「場地費3000」→ 前進。
    const ok = step(svc, '場地費3000');
    expect(ok.kind).toBe('awaiting_confirm');
  });

  it('[D-005 AC-10] applyAnswer 純函式：awaiting_fee 依前綴判 mode（含空白容忍）', () => {
    const s = applyAnswer('awaiting_fee', {}, '場地費3000');
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.payload.priceMode).toBe('split_venue');
      expect(s.payload.venueFee).toBe(3000);
      expect(s.payload.price).toBe(0);
    }
    const sSpace = applyAnswer('awaiting_fee', {}, '場地費 3000元');
    expect(sSpace.ok).toBe(true);
    if (sSpace.ok) expect(sSpace.payload.venueFee).toBe(3000);
    const p = applyAnswer('awaiting_fee', {}, '每人 2200');
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.payload.priceMode).toBe('per_person');
      expect(p.payload.price).toBe(2200);
    }
    const bare = applyAnswer('awaiting_fee', {}, '2200');
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.payload.price).toBe(2200);
    expect(applyAnswer('awaiting_fee', {}, '').ok).toBe(false);
    expect(applyAnswer('awaiting_fee', {}, 'abc').ok).toBe(false);
  });
});
