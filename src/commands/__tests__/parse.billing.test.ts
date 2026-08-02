import { describe, it, expect } from 'vitest';
import { parseCommand } from '../parse';
import { validateFee, validateVenueFee } from '../validators';

describe('一行式計費語法（D-005 §6.1）', () => {
  it('[D-005 AC-9] 場地費前綴 → split_venue、venueFee、price=0', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 場地費3000元')).toEqual({
      type: 'create_event_oneline',
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 0,
      priceMode: 'split_venue',
      venueFee: 3000,
    });
    // 無「元」尾綴亦可。
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 場地費3000')).toMatchObject({
      priceMode: 'split_venue',
      venueFee: 3000,
      price: 0,
    });
  });

  it('[D-005 AC-9] 每人前綴與裸金額 → per_person、price、無 venueFee', () => {
    const withPrefix = parseCommand('開團 2026/08/15 07:30 東方球場 16人 每人2200元');
    expect(withPrefix).toMatchObject({ priceMode: 'per_person', price: 2200 });
    expect((withPrefix as { venueFee?: number }).venueFee).toBeUndefined();
    const bare = parseCommand('開團 2026/08/15 07:30 東方球場 16人 2200元');
    expect(bare).toMatchObject({ priceMode: 'per_person', price: 2200 });
  });

  it('[D-005 AC-9] 場地費非正整數 → create_bad_venue_fee', () => {
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 場地費0元')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_bad_venue_fee',
    });
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 場地費abc')).toMatchObject({
      type: 'invalid',
      reason: 'create_bad_venue_fee',
    });
  });

  it('[D-005 AC-9] validateFee/validateVenueFee 純函式判定', () => {
    expect(validateFee('場地費3000元')).toEqual({ ok: true, value: { mode: 'split_venue', amount: 3000 } });
    expect(validateFee('均攤3000')).toEqual({ ok: true, value: { mode: 'split_venue', amount: 3000 } });
    expect(validateFee('每人2200')).toEqual({ ok: true, value: { mode: 'per_person', amount: 2200 } });
    expect(validateFee('2200元')).toEqual({ ok: true, value: { mode: 'per_person', amount: 2200 } });
    expect(validateFee('0')).toEqual({ ok: true, value: { mode: 'per_person', amount: 0 } }); // per_person 允許 0
    expect(validateVenueFee('3000')).toEqual({ ok: true, value: 3000 });
    expect(validateVenueFee('0')).toEqual({ ok: false, reason: 'create_bad_venue_fee' });
    expect(validateVenueFee('場地費3000元')).toEqual({ ok: true, value: 3000 });
  });

  it('[D-005 AC-9] validateFee 容忍關鍵字與數字間空白（逐步單題整串答案，一行式 token 無空白零回歸）', () => {
    // 含空白（逐步問答單題整串答案會有）：關鍵字與數字間空白皆須正確解析。
    expect(validateFee('場地費 3000')).toEqual({ ok: true, value: { mode: 'split_venue', amount: 3000 } });
    expect(validateFee('場地費 3000元')).toEqual({ ok: true, value: { mode: 'split_venue', amount: 3000 } });
    expect(validateFee('每人 2200')).toEqual({ ok: true, value: { mode: 'per_person', amount: 2200 } });
    expect(validateFee('每人 2200 元')).toEqual({ ok: true, value: { mode: 'per_person', amount: 2200 } });
    expect(validateFee(' 2200 ')).toEqual({ ok: true, value: { mode: 'per_person', amount: 2200 } });
    // 一行式 token 無內部空白，容錯為 no-op（AC-9 零回歸）。
    expect(validateFee('場地費3000')).toEqual({ ok: true, value: { mode: 'split_venue', amount: 3000 } });
  });

  it('[D-005 AC-9] 空白容忍不得洩入一行式 arity：費用含內部空白 → create_wrong_arity（非靜默 split 解析）', () => {
    // validateFee 的「去除所有空白」僅作用於單一 token 內容；一行式先以空白切分 token，
    // 故費用欄含空白會使 arity 由 5 變 6，必須被判為格式錯，不得被誤解成 split/per_person。
    // 這道防線鎖住：未來若有人在切分「前」先 strip 空白，此測試會亮紅。
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 場地費 3000')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_wrong_arity',
    });
    expect(parseCommand('開團 2026/08/15 07:30 東方球場 16人 每人 2200')).toMatchObject({
      type: 'invalid',
      command: 'create_event',
      reason: 'create_wrong_arity',
    });
  });
});
