import { describe, it, expect } from 'vitest';
import type { EventRow, RegistrationRow } from '../db/schema';
import type { RegistrationView, AddCapacityResult } from './registration-service';
import {
  formatAddCapacity,
  formatAddCapacityNotAuthorized,
  formatAddCapacityEnded,
  formatAddCapacityOverLimit,
  type PromotionNotice,
} from './list-formatter';

const EVENT: EventRow = {
  id: 1,
  group_id: 'G',
  host_user_id: 99,
  event_datetime: '2026-08-14T23:30:00Z',
  location: '東方球場',
  capacity: 19,
  price_per_person: 2200,
  price_mode: 'per_person',
  venue_fee: null,
  settled_per_person: null,
  status: 'open',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function mkRow(id: number, name: string, seq: number): RegistrationRow {
  return {
    id,
    event_id: 1,
    owner_user_id: id,
    display_name: name,
    kind: 'self',
    status: 'confirmed',
    seq,
    cancelled_at: null,
    cancelled_by_user_id: null,
    created_at: '2026-08-01T00:00:00Z',
  };
}

describe('list-formatter 加開名額（D-010 §3）', () => {
  it('[D-010 AC-1] 成功單一則：加開公告 + 名單 + 剩餘名額 + 同則遞補 @（用「球敘」）', () => {
    const confirmed = [mkRow(1, 'A', 1), mkRow(2, 'w1', 2), mkRow(3, 'w2', 3)];
    const view: RegistrationView = {
      event: EVENT,
      confirmed,
      waitlist: [],
      confirmedCount: 3,
      available: 16,
    };
    const result = { kind: 'ok', added: 3, newCapacity: 19, promoted: [], view } as Extract<
      AddCapacityResult,
      { kind: 'ok' }
    >;
    const notices: PromotionNotice[] = [
      { isProxy: false, displayName: 'w1', ownerLineUserId: 'U-w1' },
      { isProxy: false, displayName: 'w2', ownerLineUserId: 'U-w2' },
    ];
    const { text, mentionees } = formatAddCapacity(result, notices);
    // 單一則：加開公告在最前、用「球敘」（非「球聚」）。
    expect(text.startsWith('「東方球場」球敘已加開 3 個名額（上限 19）。')).toBe(true);
    expect(text).not.toContain('球聚');
    expect(text).toContain('報名名單（3/19）：');
    expect(text).toContain('剩餘名額：16');
    // 同一則追加遞補通知，兩個 mention 位移正確落在合併文字上。
    expect(mentionees).toHaveLength(2);
    for (const m of mentionees) {
      expect(text.slice(m.index, m.index + m.length)).toMatch(/^@(w1|w2)$/);
    }
  });

  it('[D-010 AC-1] 無遞補時單一則不含 @、mentionees 空', () => {
    const view: RegistrationView = {
      event: { ...EVENT, capacity: 20 },
      confirmed: [mkRow(1, 'A', 1)],
      waitlist: [],
      confirmedCount: 1,
      available: 19,
    };
    const result = { kind: 'ok', added: 2, newCapacity: 20, promoted: [], view } as Extract<
      AddCapacityResult,
      { kind: 'ok' }
    >;
    const { text, mentionees } = formatAddCapacity(result, []);
    expect(mentionees).toHaveLength(0);
    expect(text).toContain('已加開 2 個名額（上限 20）。');
    expect(text).not.toContain('遞補');
  });

  it('[D-010 §3] 拒絕文案逐字對齊設計', () => {
    expect(formatAddCapacityNotAuthorized().text).toBe('只有開團的人（或系統管理員）可以加開名額。');
    expect(formatAddCapacityEnded().text).toBe('活動已結束，無法加開名額');
    expect(formatAddCapacityOverLimit().text).toBe('加開後將超過人數上限（1000），無法加開');
  });
});
