import { describe, it, expect } from 'vitest';
import type { EventRow } from '../db/schema';
import { perPersonAmount, estimatedTotal } from './billing';

function evt(over: Partial<EventRow>): EventRow {
  return {
    id: 1,
    group_id: 'G',
    host_user_id: 1,
    event_date: '2026-08-15',
    event_time: '07:30',
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

describe('billing 純函式（D-005 §2）', () => {
  it('[D-005 AC-1] per_person：perPersonAmount=每人固定；estimatedTotal=正取×每人（回歸）', () => {
    const e = evt({ price_mode: 'per_person', price_per_person: 2200 });
    expect(perPersonAmount(e, 3)).toBe(2200);
    expect(perPersonAmount(e, 1)).toBe(2200);
    expect(estimatedTotal(e, 3)).toBe(6600);
  });

  it('[D-005 AC-2] split ceil：ceil(3000/7)=429；estimatedTotal=venue_fee（固定）', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    expect(perPersonAmount(e, 7)).toBe(429);
    expect(estimatedTotal(e, 7)).toBe(3000);
    expect(estimatedTotal(e, 1)).toBe(3000); // 與正取數無關
  });

  it('[D-005 AC-2] split 無條件進位（非四捨五入/捨去）', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    expect(perPersonAmount(e, 4)).toBe(750); // 3000/4=750 整除
    expect(perPersonAmount(e, 3)).toBe(1000); // 3000/3=1000
    const e2 = evt({ price_mode: 'split_venue', venue_fee: 1000, price_per_person: 0 });
    expect(perPersonAmount(e2, 3)).toBe(334); // ceil(333.33)
  });

  it('[D-005 AC-6] 正取=1（僅主辦）→ 均攤=venue_fee', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    expect(perPersonAmount(e, 1)).toBe(3000);
  });

  it('[D-005 AC-15] 分母 max(,1) 防除零：confirmedCount=0 → venue_fee（不 NaN/Infinity/throw）', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    const v = perPersonAmount(e, 0);
    expect(v).toBe(3000);
    expect(Number.isFinite(v)).toBe(true);
  });
});
