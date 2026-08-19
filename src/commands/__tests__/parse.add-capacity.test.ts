import { describe, it, expect } from 'vitest';
import { parseCommand } from '../parse';

// D-010 §一.1 / AC-6·AC-7：`加開 N` 解析、邊界與上限（parser 純函式層）。
describe('D-010 §一.1 加開名額指令解析', () => {
  it('[D-010 AC-7] 加開 3 → add_capacity{count:3}', () => {
    expect(parseCommand('加開 3')).toEqual({ type: 'add_capacity', count: 3 });
  });

  it('[D-010 AC-7] 全形『加開　３』→ add_capacity{count:3}（全形空格+全形數字正規化）', () => {
    expect(parseCommand('加開　３')).toEqual({ type: 'add_capacity', count: 3 });
  });

  it('[D-010 AC-7] 加開 20（MAX_COUNT）→ add_capacity{count:20}', () => {
    expect(parseCommand('加開 20')).toEqual({ type: 'add_capacity', count: 20 });
  });

  it('[D-010 AC-7] 加開 21（>MAX_COUNT）→ invalid(add_capacity, count_out_of_range) 靜默', () => {
    expect(parseCommand('加開 21')).toEqual({
      type: 'invalid',
      command: 'add_capacity',
      reason: 'count_out_of_range',
      raw: '加開 21',
    });
  });

  it('[D-010 AC-7] 加開（無參數）→ unknown（不回覆）', () => {
    expect(parseCommand('加開')).toEqual({ type: 'unknown' });
  });

  it('[D-010 AC-6] 加開 0 → unknown（不回覆、只加不減）', () => {
    expect(parseCommand('加開 0')).toEqual({ type: 'unknown' });
  });

  it('[D-010 AC-6] 加開 -1 → unknown（負數不回覆）', () => {
    expect(parseCommand('加開 -1')).toEqual({ type: 'unknown' });
  });

  it('[D-010 AC-7] 加開 abc / 加開 3 x（非單一純數字）→ unknown', () => {
    expect(parseCommand('加開 abc')).toEqual({ type: 'unknown' });
    expect(parseCommand('加開 3 x')).toEqual({ type: 'unknown' });
  });

  it('位數過長（加開 1000）→ invalid(count_out_of_range)（domain 另以 MAX_CAPACITY 檢新總量）', () => {
    expect(parseCommand('加開 1000')).toEqual({
      type: 'invalid',
      command: 'add_capacity',
      reason: 'count_out_of_range',
      raw: '加開 1000',
    });
  });
});
