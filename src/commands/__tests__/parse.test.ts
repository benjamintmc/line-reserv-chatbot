// src/commands/__tests__/parse.test.ts
//
// D-002 §三 Acceptance Checks 逐條覆蓋。每個測試描述含 [D-002 AC-n] 標記，
// 供 harness/checks/check_ac_coverage.py 掃描（DoD 硬關卡）。
//
// D-005 §6.1：一行式 create_event_oneline 輸出新增 priceMode（裸/每人前綴 → 'per_person'）。

import { describe, expect, it } from 'vitest';
import { parseCommand } from '../parse';

describe('parseCommand (D-002 command parser)', () => {
  it('[D-002 AC-1] 全形加號+全形數字 ＋１ → signup count 1（無 proxyName）', () => {
    expect(parseCommand('＋１')).toEqual({ type: 'signup', count: 1 });
  });

  it('[D-002 AC-2] +3 → signup count 3', () => {
    expect(parseCommand('+3')).toEqual({ type: 'signup', count: 3 });
  });

  it('[D-002 AC-3] +0 與 -0 → unknown（靜默 no-op）', () => {
    expect(parseCommand('+0')).toEqual({ type: 'unknown' });
    expect(parseCommand('-0')).toEqual({ type: 'unknown' });
  });

  it('[D-002 AC-4] +20 有效、+21/+99 → invalid(count_out_of_range)', () => {
    expect(parseCommand('+20')).toEqual({ type: 'signup', count: 20 });
    expect(parseCommand('+21')).toMatchObject({
      type: 'invalid',
      command: 'signup',
      reason: 'count_out_of_range',
    });
    expect(parseCommand('+99')).toMatchObject({
      type: 'invalid',
      command: 'signup',
      reason: 'count_out_of_range',
    });
  });

  it('[D-002 AC-5] +1 陳大哥 → signup count 1 proxyName 陳大哥', () => {
    expect(parseCommand('+1 陳大哥')).toEqual({
      type: 'signup',
      count: 1,
      proxyName: '陳大哥',
    });
  });

  it('[D-002 AC-6] -2 → cancel count 2；-1 陳大哥 → cancel count 1 proxyName 陳大哥', () => {
    expect(parseCommand('-2')).toEqual({ type: 'cancel', count: 2 });
    expect(parseCommand('-1 陳大哥')).toEqual({
      type: 'cancel',
      count: 1,
      proxyName: '陳大哥',
    });
  });

  it('[D-002 AC-7] 名單 / list / LIST → list', () => {
    expect(parseCommand('名單')).toEqual({ type: 'list' });
    expect(parseCommand('list')).toEqual({ type: 'list' });
    expect(parseCommand('LIST')).toEqual({ type: 'list' });
  });

  it('[D-002 AC-8] 一行式開團（斜線日期/人/元尾綴）完整欄位', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 2200元')).toEqual({
      type: 'create_event_oneline',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
      priceMode: 'per_person',
    });
  });

  it('[D-002 AC-9] 一行式容錯（破折號日期/單位數時/無尾綴）→ 同 AC-8', () => {
    expect(parseCommand('開團 2026-08-15 7:30 東方球場 16 2200')).toEqual({
      type: 'create_event_oneline',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
      priceMode: 'per_person',
    });
  });

  it('[D-002 AC-10] 開團 / 新活動（無參數）→ create_event_start', () => {
    expect(parseCommand('開團')).toEqual({ type: 'create_event_start' });
    expect(parseCommand('新活動')).toEqual({ type: 'create_event_start' });
  });

  it('[D-002 AC-11] 閒聊 今天天氣真好 → unknown', () => {
    expect(parseCommand('今天天氣真好')).toEqual({ type: 'unknown' });
  });

  it('[D-002 AC-12] +abc / + / "+ 1"（sign 未緊接數字）→ unknown', () => {
    expect(parseCommand('+abc')).toEqual({ type: 'unknown' });
    expect(parseCommand('+')).toEqual({ type: 'unknown' });
    expect(parseCommand('+ 1')).toEqual({ type: 'unknown' });
  });

  it('[D-002 AC-13] 開團 arity 錯 → wrong_arity；日期範圍錯 → bad_date', () => {
    expect(parseCommand('開團 缺欄位')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_wrong_arity',
    });
    expect(parseCommand('開團 2026/13/40 07:30 場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_date',
    });
  });

  it('[D-002 AC-14] 確認/取消/關閉報名/取消活動/我的ID(含小寫) → 對應型別', () => {
    expect(parseCommand('確認')).toEqual({ type: 'confirm' });
    expect(parseCommand('取消')).toEqual({ type: 'abort' });
    expect(parseCommand('關閉報名')).toEqual({ type: 'close_event' });
    expect(parseCommand('取消活動')).toEqual({ type: 'cancel_event' });
    expect(parseCommand('我的ID')).toEqual({ type: 'my_id' });
    expect(parseCommand('我的id')).toEqual({ type: 'my_id' });
  });

  it('[D-002 AC-15] 前後空白與全形空格 → signup count 1', () => {
    expect(parseCommand('  +1  ')).toEqual({ type: 'signup', count: 1 });
    expect(parseCommand('＋１　')).toEqual({ type: 'signup', count: 1 });
  });

  it('[D-002 AC-16] 全形數字/冒號的一行式 → 同 AC-8', () => {
    expect(
      parseCommand('開團 ２０２６/０８/１５ ０７：３０ 東方球場 １６人 ２２００元'),
    ).toEqual({
      type: 'create_event_oneline',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
      priceMode: 'per_person',
    });
  });

  it('[D-002 AC-17] 純函式：同輸入兩次 deep-equal；任意輸入不拋例外', () => {
    const inputs = ['+1', '+1 陳大哥', '開團 2026/08/15 07:30 場 16 2200', '亂碼'];
    for (const input of inputs) {
      expect(parseCommand(input)).toEqual(parseCommand(input));
    }
    // 任意亂數/超長/空字串/非字串輸入皆不拋例外。
    const weird: unknown[] = [
      '',
      '   ',
      'x'.repeat(100000),
      ' ￿😀',
      '+'.repeat(5000),
      // 防禦性：非字串輸入不得拋例外（陣列型別為 unknown[]，故毋須 ts-expect-error）。
      null,
      // 防禦性：非字串輸入不得拋例外（陣列型別為 unknown[]，故毋須 ts-expect-error）。
      undefined,
      // 防禦性：非字串輸入不得拋例外（陣列型別為 unknown[]，故毋須 ts-expect-error）。
      12345,
    ];
    for (const w of weird) {
      expect(() => parseCommand(w as string)).not.toThrow();
    }
  });

  it('[D-002 AC-18] 代報名名字超長截斷取前 20 code unit（非 invalid）', () => {
    const name21 = '一二三四五六七八九十一二三四五六七八九十一';
    expect(parseCommand(`+1 ${name21}`)).toEqual({
      type: 'signup',
      count: 1,
      proxyName: '一二三四五六七八九十一二三四五六七八九十',
    });
  });

  it('[D-002 AC-19] +1 後僅尾隨空白 → signup count 1（無 proxyName）', () => {
    expect(parseCommand('+1   ')).toEqual({ type: 'signup', count: 1 });
  });

  it('[D-002 AC-20] 空字串與純空白 → unknown', () => {
    expect(parseCommand('')).toEqual({ type: 'unknown' });
    expect(parseCommand('   ')).toEqual({ type: 'unknown' });
  });

  it('[D-002 AC-21] 一行式時間範圍錯 → create_bad_time', () => {
    expect(parseCommand('開團 2026/08/15 25:99 東方球場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_time',
    });
  });

  it('[D-002 AC-22] 一行式人數非正整數 → create_bad_capacity', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 0人 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_capacity',
    });
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 abc人 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_capacity',
    });
  });

  it('[D-002 AC-23] 一行式價格非非負整數 → create_bad_price', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16 -100')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_price',
    });
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16 abc元')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_price',
    });
  });

  it('[D-002 AC-24] 一行式多欄同錯回第一個 reason（date 優先）', () => {
    expect(parseCommand('開團 2026/13/40 25:99 東方球場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_date',
    });
  });

  it('[D-002 AC-25] location 含空白導致 arity 錯 → create_wrong_arity', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方 球場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_wrong_arity',
    });
  });

  it('[D-002 AC-26] +N 數字後緊接非空白字元（寬鬆 proxyName）', () => {
    expect(parseCommand('+1abc')).toEqual({
      type: 'signup',
      count: 1,
      proxyName: 'abc',
    });
    expect(parseCommand('+1.5')).toEqual({
      type: 'signup',
      count: 1,
      proxyName: '.5',
    });
  });
});
