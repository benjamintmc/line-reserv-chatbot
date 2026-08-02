import { describe, it, expect } from 'vitest';
import type { EventRow, RegistrationRow } from '../db/schema';
import type { RegistrationView } from './registration-service';
import { formatList } from './list-formatter';

function evt(over: Partial<EventRow>): EventRow {
  return {
    id: 1,
    group_id: 'G',
    host_user_id: 1,
    event_datetime: '2026-08-14T23:30:00Z',
    location: '東方球場',
    capacity: 16,
    price_per_person: 0,
    price_mode: 'per_person',
    venue_fee: null,
    settled_per_person: null,
    status: 'open',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

function rows(n: number): RegistrationRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    event_id: 1,
    owner_user_id: 10,
    display_name: '成員',
    kind: 'self' as const,
    status: 'confirmed' as const,
    seq: i + 1,
    cancelled_at: null,
    cancelled_by_user_id: null,
    created_at: '2026-08-01T00:00:00Z',
  }));
}

function view(event: EventRow, count: number): RegistrationView {
  return {
    event,
    confirmed: rows(count),
    waitlist: [],
    confirmedCount: count,
    available: Math.max(0, event.capacity - count),
  };
}

describe('list-formatter 計費列 mode-aware（D-005 §5.1）', () => {
  it('[D-005 AC-1] per_person 費用列與預估總金額回歸（球敘標題）', () => {
    const e = evt({ price_mode: 'per_person', price_per_person: 2200 });
    const { text } = formatList(view(e, 3));
    expect(text).toContain('[東方球場 球敘]'); // AC-11 中性化：非「球聚」
    expect(text).toContain('每人費用：2200 元');
    expect(text).toContain('預估總金額：3 × 2200 = 6600 元');
    expect(text).not.toContain('球聚');
  });

  it('[D-005 AC-2 / AC-14] split 費用列含暫估與 ceil；預估總額為固定 venue_fee', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    const { text } = formatList(view(e, 7));
    expect(text).toContain('場地費：3000 元，平均每人約 429 元（暫估，關閉報名後結算）');
    expect(text).toContain('預估總金額：場地費 3000 元（固定，暫估）');
  });

  it('[D-005 AC-14] split 費用列必含「暫估」與「關閉報名後結算」（不呈現無標示定金）', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    const { text } = formatList(view(e, 1));
    expect(text).toContain('暫估');
    expect(text).toContain('關閉報名後結算');
  });

  it('[D-005 AC-11] 費用/身分標籤中性化：body 標籤為「場地：」非「地點：」', () => {
    const e = evt({ price_mode: 'per_person', price_per_person: 2200 });
    const { text } = formatList(view(e, 1));
    expect(text).toContain('場地：東方球場');
    expect(text).not.toContain('地點：');
  });
});
