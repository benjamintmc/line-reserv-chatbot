import { describe, it, expect } from 'vitest';
import type { EventRow, RegistrationRow } from '../db/schema';
import type { RegistrationView, SignupResult } from './registration-service';
import {
  formatList,
  formatSignup,
  formatPromotionNotice,
  type PromotionNotice,
} from './list-formatter';

const EVENT: EventRow = {
  id: 1,
  group_id: 'G',
  host_user_id: 99,
  event_datetime: '2026-08-14T23:30:00Z',
  location: '東方球場',
  capacity: 16,
  price_per_person: 2200,
  // D-005 §1：per_person 模式（venue_fee/settled_per_person 恆為 NULL）。
  price_mode: 'per_person',
  venue_fee: null,
  settled_per_person: null,
  status: 'open',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function mkRow(id: number, owner: number, name: string, seq: number): RegistrationRow {
  return {
    id,
    event_id: 1,
    owner_user_id: owner,
    display_name: name,
    kind: 'self',
    status: 'confirmed',
    seq,
    cancelled_at: null,
    cancelled_by_user_id: null,
    created_at: '2026-08-01T00:00:00Z',
  };
}

function mkWaitRow(id: number, owner: number, name: string, seq: number): RegistrationRow {
  return { ...mkRow(id, owner, name, seq), status: 'waitlist' };
}

describe('list-formatter', () => {
  it('[D-003 AC-8] 名單格式：序號後綴 + (3/16) + 剩餘名額 + 預估總金額', () => {
    const confirmed = [
      mkRow(1, 10, '王小明', 1),
      mkRow(2, 10, '王小明', 2),
      mkRow(3, 10, '王小明', 3),
    ];
    const view: RegistrationView = {
      event: EVENT,
      confirmed,
      waitlist: [],
      confirmedCount: 3,
      available: 13,
    };
    const { text, mentionees } = formatList(view);
    expect(mentionees).toHaveLength(0);
    expect(text).toContain('報名名單（3/16）：');
    expect(text).toContain('1. 王小明');
    expect(text).toContain('2. 王小明(2)');
    expect(text).toContain('3. 王小明(3)');
    expect(text).toContain('剩餘名額：13');
    expect(text).toContain('預估總金額：3 × 2200 = 6600 元');
  });

  it('[D-003 AC-8] 有候補時附「候補名單」段落', () => {
    const view: RegistrationView = {
      event: EVENT,
      confirmed: [mkRow(1, 10, 'A', 1)],
      waitlist: [{ ...mkRow(2, 20, 'B', 2), status: 'waitlist' }],
      confirmedCount: 1,
      available: 15,
    };
    expect(formatList(view).text).toContain('候補名單：');
  });

  // ── formatSignup（正取 / 整批候補分支）補強 ──────────────────────────
  it('[D-003 AC-1] formatSignup 正取分支：文案「已為…報名 N 位（正取）」+ 名單', () => {
    const confirmed = [mkRow(1, 10, '王小明', 1), mkRow(2, 10, '王小明', 2)];
    const view: RegistrationView = {
      event: EVENT,
      confirmed,
      waitlist: [],
      confirmedCount: 2,
      available: 14,
    };
    const result: Extract<SignupResult, { kind: 'ok' }> = {
      kind: 'ok',
      outcome: 'confirmed',
      requested: 2,
      subjectDisplayName: '王小明',
      newSlots: confirmed,
      view,
    };
    const { text, mentionees } = formatSignup(result);
    expect(mentionees).toHaveLength(0);
    expect(text).toContain('已為「王小明」報名 2 位（正取）。');
    expect(text).toContain('報名名單（2/16）：');
    // 正取分支不應出現候補序位字樣。
    expect(text).not.toContain('候補序位');
  });

  it('[D-003 AC-3] formatSignup 整批候補分支：整批文案 + 候補序位（空場先候補）', () => {
    const waitlist = [mkWaitRow(10, 20, '陳小華', 1), mkWaitRow(11, 20, '陳小華', 2)];
    const view: RegistrationView = {
      event: EVENT,
      confirmed: Array.from({ length: 16 }, (_, i) => mkRow(100 + i, 10, '正取者', i + 1)),
      waitlist,
      confirmedCount: 16,
      available: 0,
    };
    const result: Extract<SignupResult, { kind: 'ok' }> = {
      kind: 'ok',
      outcome: 'waitlisted',
      requested: 2,
      subjectDisplayName: '陳小華',
      newSlots: waitlist,
      view,
    };
    const { text } = formatSignup(result);
    expect(text).toContain('正取名額已滿，已將「陳小華」的 2 位整批排入候補。');
    expect(text).toContain('候補序位：第 1、2 位');
    expect(text).toContain('候補名單：');
  });

  it('[D-003 AC-3] formatSignup 候補序位反映既有候補之偏移（非從 1 起）', () => {
    // 既有候補 X(seq1), X(seq2)；新報名 C(seq3) 應為候補序位第 3 位。
    const existing = [mkWaitRow(1, 10, 'X', 1), mkWaitRow(2, 10, 'X', 2)];
    const newSlot = mkWaitRow(3, 30, 'C', 3);
    const view: RegistrationView = {
      event: EVENT,
      confirmed: Array.from({ length: 16 }, (_, i) => mkRow(100 + i, 10, '正取者', i + 1)),
      waitlist: [...existing, newSlot],
      confirmedCount: 16,
      available: 0,
    };
    const result: Extract<SignupResult, { kind: 'ok' }> = {
      kind: 'ok',
      outcome: 'waitlisted',
      requested: 1,
      subjectDisplayName: 'C',
      newSlots: [newSlot],
      view,
    };
    expect(formatSignup(result).text).toContain('候補序位：第 3 位');
  });

  it('[D-003 AC-14] 遞補通知：自報名 mention 描述子含被遞補者 line_user_id、index/length 對齊', () => {
    const notices: PromotionNotice[] = [
      { isProxy: false, displayName: '王小明', ownerLineUserId: 'U-wang' },
    ];
    const { text, mentionees } = formatPromotionNotice(notices);
    expect(text).toContain('名額釋出，恭喜由候補遞補為正取：');
    expect(text).toContain('@王小明');
    expect(mentionees).toHaveLength(1);
    const m = mentionees[0]!;
    expect(m.lineUserId).toBe('U-wang');
    expect(text.slice(m.index, m.index + m.length)).toBe('@王小明');
  });

  it('[D-003 AC-14] 代報名列被遞補：mention 代報者、文案標「（由 @代報者 代報）」', () => {
    const notices: PromotionNotice[] = [
      { isProxy: true, displayName: '陳大哥', proxyAgentName: '李大華', ownerLineUserId: 'U-lee' },
    ];
    const { text, mentionees } = formatPromotionNotice(notices);
    expect(text).toContain('陳大哥（由 @李大華 代報）');
    expect(mentionees).toHaveLength(1);
    const m = mentionees[0]!;
    expect(m.lineUserId).toBe('U-lee');
    expect(text.slice(m.index, m.index + m.length)).toBe('@李大華');
  });

  it('[D-003 AC-14] owner line_user_id 取不到 → 退化純文字（無 mention 描述子）', () => {
    const notices: PromotionNotice[] = [
      { isProxy: false, displayName: '無好友者', ownerLineUserId: null },
    ];
    const { text, mentionees } = formatPromotionNotice(notices);
    expect(text).toContain('@無好友者');
    expect(mentionees).toHaveLength(0);
  });

  // ── formatPromotionNotice 多筆與 fallback 邊界補強 ──────────────────
  it('[D-003 AC-14] 多筆遞補：每筆 index/length 各自對齊被 @ 文字（跨行偏移正確）', () => {
    const notices: PromotionNotice[] = [
      { isProxy: false, displayName: '甲', ownerLineUserId: 'U1' },
      { isProxy: true, displayName: '陳大哥', proxyAgentName: '乙', ownerLineUserId: 'U2' },
    ];
    const { text, mentionees } = formatPromotionNotice(notices);
    expect(mentionees).toHaveLength(2);
    // 依 lineUserId 找回各自描述子，驗證 slice 精準命中（第二筆的 index 必須含前一行位移）。
    const first = mentionees.find((m) => m.lineUserId === 'U1')!;
    const second = mentionees.find((m) => m.lineUserId === 'U2')!;
    expect(text.slice(first.index, first.index + first.length)).toBe('@甲');
    expect(text.slice(second.index, second.index + second.length)).toBe('@乙');
    expect(text).toContain('陳大哥（由 @乙 代報）');
  });

  it('[D-003 AC-14] 代報名列 owner line_user_id 取不到 → 純文字、仍含「（由 @代報者 代報）」骨架', () => {
    const notices: PromotionNotice[] = [
      { isProxy: true, displayName: '陳大哥', proxyAgentName: '李大華', ownerLineUserId: null },
    ];
    const { text, mentionees } = formatPromotionNotice(notices);
    expect(text).toContain('陳大哥（由 @李大華 代報）');
    expect(mentionees).toHaveLength(0);
  });

  it('[D-003 AC-14] 代報者稱謂缺漏 → 退化「@代報者」佔位', () => {
    const notices: PromotionNotice[] = [
      { isProxy: true, displayName: '陳大哥', ownerLineUserId: 'U-x' },
    ];
    const { text, mentionees } = formatPromotionNotice(notices);
    expect(text).toContain('陳大哥（由 @代報者 代報）');
    const m = mentionees[0]!;
    expect(text.slice(m.index, m.index + m.length)).toBe('@代報者');
  });
});
