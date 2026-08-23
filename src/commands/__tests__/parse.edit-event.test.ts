import { describe, it, expect } from 'vitest';
import { parseCommand } from '../parse';
import { MAX_LOCATION_LEN } from '../types';

// D-015 §1 parser 契約（AC-9）。
// 注意 §1「已知取捨」：`編輯` 一律回覆並非全域保證——開團問答進行中時 handler 的 conversation
// 攔截優先於 parseCommand；多行批次只執行 signup/cancel。本檔只驗 parser 層。

describe('parseCommand — 編輯活動資訊（D-015 §1）', () => {
  it('[D-015 AC-9] `編輯`（無參數）→ edit_help', () => {
    expect(parseCommand('編輯')).toEqual({ type: 'edit_help' });
  });

  it('[D-015 AC-9] `編輯 費率 100`（未知欄位名）→ edit_help', () => {
    expect(parseCommand('編輯 費率 100')).toEqual({ type: 'edit_help' });
  });

  it('[D-015 AC-9] `編輯 場地`／`編輯 日期`／`編輯 費用`（缺新值）→ edit_help', () => {
    expect(parseCommand('編輯 場地')).toEqual({ type: 'edit_help' });
    expect(parseCommand('編輯 日期')).toEqual({ type: 'edit_help' });
    expect(parseCommand('編輯 時間')).toEqual({ type: 'edit_help' });
    expect(parseCommand('編輯 費用')).toEqual({ type: 'edit_help' });
  });

  it('[D-015 AC-9] `編輯 日期 2026-13-99` → invalid(edit_event, create_bad_date)', () => {
    expect(parseCommand('編輯 日期 2026-13-99')).toEqual({
      type: 'invalid',
      command: 'edit_event',
      reason: 'create_bad_date',
      raw: '編輯 日期 2026-13-99',
    });
  });

  it('[D-015 AC-9] `編輯 時間 25:00` → invalid(edit_event, create_bad_time)', () => {
    expect(parseCommand('編輯 時間 25:00')).toEqual({
      type: 'invalid',
      command: 'edit_event',
      reason: 'create_bad_time',
      raw: '編輯 時間 25:00',
    });
  });

  it('[D-015 AC-9] `編輯 日期 2026/09/01` → date，值經 validateDate 正規化為 YYYY-MM-DD', () => {
    expect(parseCommand('編輯 日期 2026/09/01')).toEqual({
      type: 'edit_event',
      field: 'date',
      value: '2026-09-01',
    });
    // `YYYY-MM-DD` 與非零填充亦收（validateDate 契約，勿改）。
    expect(parseCommand('編輯 日期 2026-9-1')).toEqual({
      type: 'edit_event',
      field: 'date',
      value: '2026-09-01',
    });
  });

  it('[D-015 AC-9] `編輯 時間 7:30` → time，值零填充為 HH:MM', () => {
    expect(parseCommand('編輯 時間 7:30')).toEqual({
      type: 'edit_event',
      field: 'time',
      value: '07:30',
    });
  });

  it('[D-015 AC-9] `編輯 場地 東方 A 場` → location 且**保留空格**', () => {
    expect(parseCommand('編輯 場地 東方 A 場')).toEqual({
      type: 'edit_event',
      field: 'location',
      value: '東方 A 場',
    });
  });

  it('[D-015 AC-9] 隱藏別名 `編輯 地點 東方 A 場` → 與 `編輯 場地 …` 完全同解', () => {
    expect(parseCommand('編輯 地點 東方 A 場')).toEqual(parseCommand('編輯 場地 東方 A 場'));
  });

  it('[D-015 AC-9] `編輯 費用 場地費 4000` → fee，值 compact 為 `場地費4000`（F2）', () => {
    expect(parseCommand('編輯 費用 場地費 4000')).toEqual({
      type: 'edit_event',
      field: 'fee',
      value: '場地費4000',
    });
    // `2500 元` 同理 compact；不 compact 則 validatePrice 會誤拒（F2 的存在理由）。
    expect(parseCommand('編輯 費用 2500 元')).toEqual({
      type: 'edit_event',
      field: 'fee',
      value: '2500元',
    });
  });

  it('[D-015 AC-9] 全形『編輯　日期　2026/09/01』→ 正常解析（全形空格/數字正規化）', () => {
    expect(parseCommand('編輯　日期　２０２６/０９/０１')).toEqual({
      type: 'edit_event',
      field: 'date',
      value: '2026-09-01',
    });
  });

  it('[D-015 AC-9] `編輯 人數 12` 與 `編輯 人數`（缺值）→ 皆為 capacity（導向用，不落 help）', () => {
    expect(parseCommand('編輯 人數 12')).toEqual({
      type: 'edit_event',
      field: 'capacity',
      value: '12',
    });
    expect(parseCommand('編輯 人數')).toEqual({
      type: 'edit_event',
      field: 'capacity',
      value: '',
    });
  });

  it('[D-015 AC-11] 場地 40 字 → 成功；41 字 → invalid(bad_location) 帶實際字數、不截斷', () => {
    const len40 = 'ㄅ'.repeat(MAX_LOCATION_LEN);
    expect(parseCommand(`編輯 場地 ${len40}`)).toEqual({
      type: 'edit_event',
      field: 'location',
      value: len40,
    });

    const len41 = 'ㄅ'.repeat(MAX_LOCATION_LEN + 1);
    const r = parseCommand(`編輯 場地 ${len41}`);
    expect(r).toEqual({
      type: 'invalid',
      command: 'edit_event',
      reason: 'bad_location',
      raw: `編輯 場地 ${len41}`,
      detail: { len: 41 },
    });
    // 不截斷：raw 仍保留完整輸入，未產生任何 41→40 的截斷值。
    if (r.type === 'invalid') expect(r.raw).toContain(len41);
  });

  it('[D-015 AC-9] 首 token 為 `編輯` 者一律不落入 unknown', () => {
    for (const s of ['編輯', '編輯 日期', '編輯 費率 100', '編輯 日期 xx', '編輯 人數']) {
      expect(parseCommand(s).type).not.toBe('unknown');
    }
    // 非首 token 的「編輯」不受影響（閒聊不被攔截）。
    expect(parseCommand('我來編輯一下').type).toBe('unknown');
  });
});
