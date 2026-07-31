import { describe, it, expect } from 'vitest';
import {
  applyAnswer,
  nextState,
  isComplete,
  parseDraft,
  serializeDraft,
  FIRST_STATE,
  type CreateEventDraft,
} from './create-flow';

/** D-004 §3 逐步問答 state machine 純邏輯（不觸 DB / LINE）。 */
describe('create-flow 純狀態機（D-004 §3）', () => {
  it('nextState 逐欄前進，price 後為 awaiting_confirm', () => {
    expect(FIRST_STATE).toBe('awaiting_date');
    expect(nextState('awaiting_date')).toBe('awaiting_time');
    expect(nextState('awaiting_time')).toBe('awaiting_location');
    expect(nextState('awaiting_location')).toBe('awaiting_capacity');
    expect(nextState('awaiting_capacity')).toBe('awaiting_price');
    expect(nextState('awaiting_price')).toBe('awaiting_confirm');
  });

  it('[D-004 AC-4] awaiting_date 非法日期 → 停留同一 state、payload 不含 date', () => {
    const r = applyAnswer('awaiting_date', {}, '2026/13/40');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.state).toBe('awaiting_date');
    // 合法值則前進並寫入正規化 date
    const ok = applyAnswer('awaiting_date', {}, '2026/8/15');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.payload.date).toBe('2026-08-15');
    expect(ok.nextState).toBe('awaiting_time');
  });

  it('[D-004 AC-4] 各欄非法輸入皆停留該 state 重問（time/capacity/price）', () => {
    expect(applyAnswer('awaiting_time', { date: 'd' }, '25:00').ok).toBe(false);
    expect(applyAnswer('awaiting_capacity', {}, '0').ok).toBe(false);
    expect(applyAnswer('awaiting_capacity', {}, 'abc').ok).toBe(false);
    expect(applyAnswer('awaiting_price', {}, '-1').ok).toBe(false);
  });

  it('[D-004 AC-5] awaiting_location 可含空白，僅去頭尾、保留內部空白', () => {
    const r = applyAnswer('awaiting_location', { date: 'd', time: 't' }, '  東方 高爾夫球場 ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.location).toBe('東方 高爾夫球場');
    expect(r.nextState).toBe('awaiting_capacity');
  });

  it('[D-004 AC-5] awaiting_location 空白字串 → 停留重問', () => {
    const r = applyAnswer('awaiting_location', {}, '    ');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.state).toBe('awaiting_location');
  });

  it('awaiting_price 免費 0 → 前進 awaiting_confirm', () => {
    const r = applyAnswer('awaiting_price', {}, '0');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.price).toBe(0);
    expect(r.nextState).toBe('awaiting_confirm');
  });

  it('[D-004 AC-20] isComplete：缺欄位為 false；price=0 齊備為 true', () => {
    const partial: CreateEventDraft = { date: 'd', time: 't', location: 'l', capacity: 16 };
    expect(isComplete(partial)).toBe(false); // 缺 price
    const full: CreateEventDraft = { date: 'd', time: 't', location: 'l', capacity: 16, price: 0 };
    expect(isComplete(full)).toBe(true); // price=0 仍齊備
    expect(isComplete({ ...full, location: '' })).toBe(false); // 空 location 不齊備
  });

  it('[D-004 AC-20] parseDraft 型別安全：malformed JSON / 非物件 / 錯型別欄位 → 安全承載', () => {
    expect(parseDraft(null)).toEqual({});
    expect(parseDraft('')).toEqual({});
    expect(parseDraft('not json')).toEqual({});
    expect(parseDraft('123')).toEqual({}); // 非物件
    // 錯型別欄位被剔除（capacity 為字串 → 忽略）
    expect(parseDraft('{"date":"2026-08-15","capacity":"16"}')).toEqual({ date: '2026-08-15' });
    // 正常往返
    const d: CreateEventDraft = { date: '2026-08-15', time: '07:30', location: 'X', capacity: 16, price: 0 };
    expect(parseDraft(serializeDraft(d))).toEqual(d);
  });
});
