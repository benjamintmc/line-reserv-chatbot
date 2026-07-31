import { describe, it, expect } from 'vitest';
import { parseCommand } from '../parse';
import {
  validateDate,
  validateTime,
  validateCapacity,
  validatePrice,
} from '../validators';
import { normalizeWhitelist } from '../normalize';

/**
 * [D-004 AC-22] validator 與 D-002 一行式 inline parse 等價。
 *
 * commands 匯出的 validateDate/validateTime/validateCapacity/validatePrice 對同一組輸入，
 * 與一行式 `開團 …` 解析（parseCommand → create_event_oneline）產生**相同**的接受/拒絕與
 * 正規化輸出（含零填充）。此為 G7 單一 source of truth 的證明：parse.ts 已改為複用 validators，
 * 本測試以「經 parseCommand 全路徑」對照「直接呼叫 validator」鎖死等價、防未來分歧。
 */
describe('validator 與 D-002 一行式解析等價（G7 / AC-22）', () => {
  // 以合法基底組一行式，替換單一欄位以隔離該欄行為。
  const base = { date: '2026/08/15', time: '07:30', location: '東方球場', cap: '16', price: '2200' };
  function oneline(o: Partial<typeof base>): ReturnType<typeof parseCommand> {
    const m = { ...base, ...o };
    return parseCommand(`開團 ${m.date} ${m.time} ${m.location} ${m.cap} ${m.price}`);
  }

  it('[D-004 AC-22] 日期：接受集正規化輸出與 parse 一致', () => {
    for (const tok of ['2026/08/15', '2026-8-5', '2026/12/31', '2026-01-01']) {
      const r = validateDate(normalizeWhitelist(tok));
      const p = oneline({ date: tok });
      expect(r.ok).toBe(true);
      expect(p.type).toBe('create_event_oneline');
      if (r.ok && p.type === 'create_event_oneline') {
        expect(p.date).toBe(r.value); // 同一零填充輸出
      }
    }
  });

  it('[D-004 AC-22] 日期：拒絕集一致（validator 失敗 ⇔ parse invalid create_bad_date）', () => {
    for (const tok of ['2026/13/40', '2026/00/10', 'abc', '2026/1', '2026.1.1']) {
      const r = validateDate(normalizeWhitelist(tok));
      const p = oneline({ date: tok });
      expect(r.ok).toBe(false);
      // parse 於首欄錯即回 invalid(create_bad_date)
      expect(p.type === 'invalid' && p.reason).toBe('create_bad_date');
    }
  });

  it('[D-004 AC-22] 時間：接受/拒絕與零填充一致', () => {
    for (const tok of ['07:30', '7:05', '23:59', '0:00']) {
      const r = validateTime(normalizeWhitelist(tok));
      const p = oneline({ time: tok });
      expect(r.ok).toBe(true);
      if (r.ok && p.type === 'create_event_oneline') expect(p.time).toBe(r.value);
    }
    for (const tok of ['24:00', '07:60', '7', '7:5', 'aa:bb']) {
      expect(validateTime(normalizeWhitelist(tok)).ok).toBe(false);
      const p = oneline({ time: tok });
      expect(p.type === 'invalid' && p.reason).toBe('create_bad_time');
    }
  });

  it('[D-004 AC-22] 人數：去尾綴「人」、範圍與 parse 一致', () => {
    for (const tok of ['16', '16人', '1', '1000']) {
      const r = validateCapacity(normalizeWhitelist(tok));
      const p = oneline({ cap: tok });
      expect(r.ok).toBe(true);
      if (r.ok && p.type === 'create_event_oneline') expect(p.capacity).toBe(r.value);
    }
    for (const tok of ['0', '1001', 'abc', '-3', '16位']) {
      expect(validateCapacity(normalizeWhitelist(tok)).ok).toBe(false);
      const p = oneline({ cap: tok });
      expect(p.type === 'invalid' && p.reason).toBe('create_bad_capacity');
    }
  });

  it('[D-004 AC-22] 價格：去尾綴「元」、非負整數與 parse 一致（含 0）', () => {
    for (const tok of ['2200', '2200元', '0', '0元']) {
      const r = validatePrice(normalizeWhitelist(tok));
      const p = oneline({ price: tok });
      expect(r.ok).toBe(true);
      if (r.ok && p.type === 'create_event_oneline') expect(p.price).toBe(r.value);
    }
    for (const tok of ['abc', '-1', '22.5', '2200圓']) {
      expect(validatePrice(normalizeWhitelist(tok)).ok).toBe(false);
      const p = oneline({ price: tok });
      expect(p.type === 'invalid' && p.reason).toBe('create_bad_price');
    }
  });

  it('[D-004 AC-22] 全形數字經 normalizeWhitelist 後兩路徑一致', () => {
    const r = validateCapacity(normalizeWhitelist('１６人'));
    const p = oneline({ cap: '１６人' });
    expect(r.ok).toBe(true);
    if (r.ok && p.type === 'create_event_oneline') expect(p.capacity).toBe(16);
  });
});
