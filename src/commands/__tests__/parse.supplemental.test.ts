// src/commands/__tests__/parse.supplemental.test.ts
//
// unit-tester 獨立補強：針對 D-002 邊界與 Guardrail 的漏測補齊。
// 不放寬任何斷言；每個測試對應既有 AC 或 Guardrail，於名稱標註。
// 覆核角度：檢查順序、不對稱邊界、正規化白名單範圍、proxyName 截斷邊界。

import { describe, expect, it } from 'vitest';
import { parseCommand } from '../parse';

describe('parseCommand 補強：計數邊界與檢查順序（AC-3 / AC-4 / G4）', () => {
  it('[D-002 AC-3] +0000 → unknown（驗證 count<1 先於位數判斷，否則 digits.length>3 會誤判 invalid）', () => {
    expect(parseCommand('+0000')).toEqual({ type: 'unknown' });
    expect(parseCommand('-0000')).toEqual({ type: 'unknown' });
    expect(parseCommand('+00')).toEqual({ type: 'unknown' });
  });

  it('[D-002 AC-4] cancel 側超上限亦須 invalid(count_out_of_range)（G4 不對稱邊界對 cancel 也成立）', () => {
    expect(parseCommand('-21')).toMatchObject({
      type: 'invalid',
      command: 'cancel',
      reason: 'count_out_of_range',
    });
    expect(parseCommand('-99')).toMatchObject({
      type: 'invalid',
      command: 'cancel',
      reason: 'count_out_of_range',
    });
    expect(parseCommand('-20')).toEqual({ type: 'cancel', count: 20 });
  });

  it('[D-002 AC-4] 超長位數（>3 digits）→ invalid，不因 Number 溢位而漏判', () => {
    expect(parseCommand('+99999999999')).toMatchObject({
      type: 'invalid',
      command: 'signup',
      reason: 'count_out_of_range',
    });
  });
});

describe('parseCommand 補強：一行式日期/時間邊界（AC-8 / AC-9 / AC-21）', () => {
  it('[D-002 AC-9] 單位數月日零填充輸出 2026/2/3 → 2026-02-03', () => {
    expect(parseCommand('開團 2026/2/3 7:30 東方球場 16 2200')).toEqual({
      type: 'create_event_oneline',
      date: '2026-02-03',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
    });
  });

  it('[D-002 AC-21] 分位僅一位（7:5）為畸形時間 → create_bad_time（regex 分須兩位 \\d{2}）', () => {
    expect(parseCommand('開團 2026/08/15 7:5 東方球場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_time',
    });
  });

  it('[D-002 AC-21] 時=24 / 分=60 為超範圍 → create_bad_time', () => {
    expect(parseCommand('開團 2026/08/15 24:00 東方球場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_time',
    });
    expect(parseCommand('開團 2026/08/15 07:60 東方球場 16 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_time',
    });
  });
});

describe('parseCommand 補強：capacity 上限邊界（AC-22 / MAX_CAPACITY）', () => {
  it('[D-002 AC-22] capacity=1000（MAX_CAPACITY）有效、1001 → create_bad_capacity', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 1000人 2200')).toEqual({
      type: 'create_event_oneline',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 1000,
      price: 2200,
    });
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 1001人 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_capacity',
    });
  });
});

describe('parseCommand 補強：proxyName 截斷邊界與內部空白（AC-18 / AC-5）', () => {
  it('[D-002 AC-18] 剛好 20 code unit → 不截斷（邊界值保留全名）', () => {
    const name20 = '一二三四五六七八九十一二三四五六七八九十';
    expect(name20.length).toBe(20);
    expect(parseCommand(`+1 ${name20}`)).toEqual({
      type: 'signup',
      count: 1,
      proxyName: name20,
    });
  });

  it('[D-002 AC-5] proxyName 內部連續空白折疊為單一空白', () => {
    expect(parseCommand('+1 陳  大哥')).toEqual({
      type: 'signup',
      count: 1,
      proxyName: '陳 大哥',
    });
  });
});

describe('parseCommand 補強：正規化白名單範圍（G6 / §5 / AC-16）', () => {
  it('[D-002 AC-16] 全形數字於 location 內也被轉半形（白名單對全串生效）：２號球場 → 2號球場', () => {
    expect(parseCommand('開團 2026/08/15 07:30 ２號球場 16 2200')).toMatchObject({
      type: 'create_event_oneline',
      location: '2號球場',
    });
  });

  it('[D-002 AC-16] 非白名單全形英文字母不被轉換（G6 不逾越）：ＡＢＣ球場 原樣保留', () => {
    expect(parseCommand('開團 2026/08/15 07:30 ＡＢＣ球場 16 2200')).toMatchObject({
      type: 'create_event_oneline',
      location: 'ＡＢＣ球場',
    });
  });

  it('[D-002 AC-16] proxyName 內全形數字轉半形，中文原樣：+1 陳２號 → 陳2號', () => {
    expect(parseCommand('+1 陳２號')).toEqual({
      type: 'signup',
      count: 1,
      proxyName: '陳2號',
    });
  });
});

describe('parseCommand 補強：全形空格與前後空白對各指令（AC-15 / AC-7 / AC-10 / §5）', () => {
  it('[D-002 AC-10] 全形空格包裹的開團 → create_event_start（全形空格轉半形後 trim）', () => {
    expect(parseCommand('　開團　')).toEqual({ type: 'create_event_start' });
  });

  it('[D-002 AC-7] 名單 前後含空白 → list', () => {
    expect(parseCommand('  名單  ')).toEqual({ type: 'list' });
  });

  it('[D-002 AC-16] 一行式以全形空格分隔各欄 → 正常解析（全形空格先轉半形再切分）', () => {
    expect(parseCommand('開團　2026/08/15　07:30　東方球場　16　2200')).toEqual({
      type: 'create_event_oneline',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
    });
  });
});

describe('parseCommand 補強：sign 後空白與 dispatch 順序（AC-12 / AC-14 / §3）', () => {
  it('[D-002 AC-12] "+ "（加號後僅空白，無數字）→ unknown', () => {
    expect(parseCommand('+ ')).toEqual({ type: 'unknown' });
    expect(parseCommand('-  ')).toEqual({ type: 'unknown' });
  });

  it('[D-002 AC-14] 取消活動 須先於 取消 命中（dispatch 完全相等比對，不誤判為 abort）', () => {
    expect(parseCommand('取消活動')).toEqual({ type: 'cancel_event' });
    expect(parseCommand('取消')).toEqual({ type: 'abort' });
  });
});
