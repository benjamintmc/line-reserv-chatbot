import { describe, it, expect } from 'vitest';
import type { EventRow } from '../db/schema';
import {
  formatEditHelp,
  formatEditOk,
  formatEditCapacityRedirect,
  formatEditFormatError,
  formatEditPastDatetime,
  formatEditBadFee,
  formatEditNotAuthorized,
  formatEditClosedNotEditable,
  formatEditEventEnded,
  feeLabel,
  type EditMentionTarget,
} from './event-formatter';
import { MAX_MENTIONS_PER_MESSAGE, type EditEventResult } from './event-service';

// D-015 §3 釘死文案 / §4 mention 的**純函式**驗收（不觸 DB、不讀時鐘）。
// 時鐘一律以參數注入（G7）：本檔所有 now 皆為寫死的 UTC ISO 字串。

/** 兩個不同的注入時刻 → 兩個不同的 exampleDate（證明範例日期未寫死、未讀系統時鐘）。 */
const NOW_A = '2026-08-15T00:00:00Z'; // 台北 2026-08-15 08:00；+7d → 2026/08/22
const NOW_B = '2026-12-25T16:00:00Z'; // 台北 2026-12-26 00:00；+7d → 2027/01/02

function eventRow(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    group_id: 'G-1',
    host_user_id: 1,
    event_datetime: '2026-08-14T23:30:00Z', // 台北 2026-08-15 07:30
    location: '東方場地',
    capacity: 16,
    price_per_person: 2500,
    price_mode: 'per_person',
    venue_fee: null,
    settled_per_person: null,
    status: 'open',
    created_at: NOW_A,
    updated_at: NOW_A,
    ...over,
  };
}

type EditOk = Extract<EditEventResult, { kind: 'ok' }>;
function ok(over: Partial<EditOk> = {}): EditOk {
  return {
    kind: 'ok',
    field: 'location',
    before: '舊場地',
    after: '新場地',
    confirmedCount: 3,
    tagOwnerIds: [1, 2, 3],
    overflow: false,
    ...over,
  };
}

describe('D-015 §3 help 全文（AC-10）', () => {
  it('[D-015 AC-10] per_person：與釘死全文逐字相等', () => {
    const d = formatEditHelp(eventRow(), 4, NOW_A);
    expect(d.text).toBe(
      [
        '活動目前資訊：',
        '日期：2026-08-15',
        '時間：07:30',
        '場地：東方場地',
        '每人費用：2500 元', // D-015 errata 2026-08-23：去外層 `費用：`（feeLine 自帶標籤）
        '人數上限：16',
        '',
        '編輯 日期 2026/08/22',
        '編輯 時間 07:30',
        '編輯 場地 東方場地',
        '編輯 費用 2500',
        '人數請用「加開 N」',
      ].join('\n'),
    );
    expect(d.mentionees).toEqual([]);
  });

  it('[D-015 AC-10] split_venue：{費用列} 與 {費用範例} 各自正確（照範例打不會改錯對象）', () => {
    const ev = eventRow({ price_mode: 'split_venue', price_per_person: 0, venue_fee: 3000 });
    const d = formatEditHelp(ev, 4, NOW_A);
    expect(d.text).toBe(
      [
        '活動目前資訊：',
        '日期：2026-08-15',
        '時間：07:30',
        '場地：東方場地',
        '場地費：3000 元，平均每人約 750 元（暫估，關閉報名後結算）', // 同上 errata
        '人數上限：16',
        '',
        '編輯 日期 2026/08/22',
        '編輯 時間 07:30',
        '編輯 場地 東方場地',
        '編輯 費用 場地費4000',
        '人數請用「加開 N」',
      ].join('\n'),
    );
    expect(d.text).not.toContain('費用：場地費'); // 同上回歸守門
  });

  it('[D-015 AC-10] 換兩個 now → 兩種 exampleDate（未寫死、未讀系統時鐘）', () => {
    expect(formatEditHelp(eventRow(), 1, NOW_A).text).toContain('編輯 日期 2026/08/22');
    expect(formatEditHelp(eventRow(), 1, NOW_B).text).toContain('編輯 日期 2027/01/02');
  });

  it('[D-015 AC-10] 全文不得出現「編輯 地點」（F1：對外一律「場地」）', () => {
    for (const ev of [
      eventRow(),
      eventRow({ price_mode: 'split_venue', price_per_person: 0, venue_fee: 3000 }),
    ]) {
      expect(formatEditHelp(ev, 4, NOW_A).text).not.toContain('編輯 地點');
      expect(formatEditHelp(ev, 4, NOW_A).text).not.toContain('地點');
    }
  });
});

describe('D-015 §3 拒絕與導向文案（釘死）', () => {
  it('[D-015 AC-3] past_datetime：{now} 為 YYYY-MM-DD HH:MM，範例日期隨 now 動態', () => {
    expect(formatEditPastDatetime(NOW_A).text).toBe(
      '不能把活動時間改到過去（現在是 2026-08-15 08:00）。請改輸入未來的時間（例：編輯 日期 2026/08/22）。',
    );
    expect(formatEditPastDatetime(NOW_B).text).toBe(
      '不能把活動時間改到過去（現在是 2026-12-26 00:00）。請改輸入未來的時間（例：編輯 日期 2027/01/02）。',
    );
  });

  it('[D-015 AC-5] closed／過期／無活動 三種拒絕文案', () => {
    expect(formatEditClosedNotEditable().text).toBe('報名已截止的活動無法編輯。');
    expect(formatEditEventEnded().text).toBe('活動已結束，無法編輯活動資訊。');
  });

  it('[D-015 AC-4] not_authorized 文案（不沿用 close/cancel 的 (H′)）', () => {
    expect(formatEditNotAuthorized().text).toBe('只有開團的人（或系統管理員）可以編輯活動資訊。');
  });

  it('[D-015 AC-7] 人數導向文案', () => {
    expect(formatEditCapacityRedirect().text).toBe(
      '人數不能直接編輯。要增加名額請輸入「加開 N」（例：加開 2）；縮減名額目前不支援。',
    );
  });

  it('[D-019 AC-4] bad_fee 為零參數、純格式錯通用文案（與 price_mode 無關）', () => {
    expect(formatEditBadFee().text).toBe(
      '費用格式不正確。每人固定請輸入金額（例：編輯 費用 2500）；' +
        '場地費均攤請輸入「場地費」+總額（例：編輯 費用 場地費4000）。',
    );
  });

  it('[D-019] feeLabel：per_person 與 split_venue 各自標籤', () => {
    expect(feeLabel('per_person', 2200)).toBe('每人費用 2200 元');
    expect(feeLabel('split_venue', 4000)).toBe('場地費 4000 元');
  });

  it('[D-015 AC-9] 格式錯為編輯專用文案（A3：不得沿用開團問答字串、不叫使用者裸打值）', () => {
    expect(formatEditFormatError('date', NOW_A).text).toBe(
      '日期格式不正確，請輸入「編輯 日期 YYYY/MM/DD」（例：編輯 日期 2026/08/22）。',
    );
    expect(formatEditFormatError('time', NOW_A).text).toBe(
      '時間格式不正確，請輸入「編輯 時間 HH:MM」（例：編輯 時間 07:30）。',
    );
    // 每則都自帶「編輯 …」指令前綴 → 使用者照打不會落入 unknown 靜默。
    for (const f of ['date', 'time'] as const) {
      expect(formatEditFormatError(f, NOW_A).text).toContain('編輯 ');
    }
  });

  it('[D-015 AC-11] bad_location 文案帶實際字數', () => {
    expect(formatEditFormatError('location', NOW_A, { len: 41 }).text).toBe(
      '場地名稱請控制在 40 字以內（你輸入了 41 字）。',
    );
    expect(formatEditFormatError('location', NOW_A, { len: 123 }).text).toBe(
      '場地名稱請控制在 40 字以內（你輸入了 123 字）。',
    );
  });
});

describe('D-015 §3/§4 成功句 + mention 行', () => {
  it('[D-015 AC-2] 日期/時間成功句恆顯示合併後完整時刻', () => {
    const d = formatEditOk(
      ok({ field: 'date', before: '2026-08-15 07:30', after: '2026-09-01 07:30', tagOwnerIds: [] }),
      [{ displayName: '阿明', lineUserId: 'U1' }],
    );
    expect(d.text.split('\n')[0]).toBe('已更新活動時間：2026-08-15 07:30 → 2026-09-01 07:30');
    const t = formatEditOk(
      ok({ field: 'time', before: '2026-09-01 07:30', after: '2026-09-01 06:00' }),
      [{ displayName: '阿明', lineUserId: 'U1' }],
    );
    expect(t.text.split('\n')[0]).toBe('已更新活動時間：2026-09-01 07:30 → 2026-09-01 06:00');
  });

  it('[D-015 AC-6] 費用成功句：per_person 與 split（含 K 與攤額）；同模式（feeModeSwitched 省略）零回歸', () => {
    const pp = formatEditOk(ok({ field: 'fee', before: '2000', after: '2500' }), []);
    expect(pp.text.split('\n')[0]).toBe('已更新每人費用：2000 元 → 2500 元');

    const sp = formatEditOk(
      ok({ field: 'fee', before: '3000', after: '4000', perPerson: 1000, confirmedCount: 4 }),
      [],
    );
    expect(sp.text.split('\n')[0]).toBe(
      '已更新場地費：3000 元 → 4000 元（目前正取 4 人，平均每人約 1000 元；暫估，關閉報名後結算）',
    );
  });

  it('[D-019 AC-1] 費用切換成功句（per_person→split_venue）：帶標籤全稱＋攤額子句', () => {
    const d = formatEditOk(
      ok({
        field: 'fee',
        before: feeLabel('per_person', 2200),
        after: feeLabel('split_venue', 4000),
        perPerson: 1000,
        confirmedCount: 4,
        feeModeSwitched: true,
      }),
      [],
    );
    expect(d.text.split('\n')[0]).toBe(
      '已更新計費方式：每人費用 2200 元 → 場地費 4000 元（目前正取 4 人，平均每人約 1000 元；暫估，關閉報名後結算）',
    );
  });

  it('[D-019 AC-2] 費用切換成功句（split_venue→per_person）：帶標籤全稱、不附攤額子句', () => {
    const d = formatEditOk(
      ok({
        field: 'fee',
        before: feeLabel('split_venue', 3000),
        after: feeLabel('per_person', 2500),
        feeModeSwitched: true,
      }),
      [],
    );
    expect(d.text.split('\n')[0]).toBe('已更新計費方式：場地費 3000 元 → 每人費用 2500 元');
  });

  it('[D-015 AC-12] mention 行：依序 @、index/length 對齊、無 lineUserId 者退化純文字', () => {
    const targets: EditMentionTarget[] = [
      { displayName: '阿明', lineUserId: 'U1' },
      { displayName: '小華', lineUserId: null }, // 取不到 → 純文字，不進 mentionees
      { displayName: '大雄', lineUserId: 'U3' },
    ];
    const d = formatEditOk(ok({ field: 'location', before: 'A', after: 'B' }), targets);
    expect(d.text).toBe('已更新場地：A → B\n活動資訊已更新，已報名的各位請確認：@阿明 @小華 @大雄');
    expect(d.mentionees.map((m) => m.lineUserId)).toEqual(['U1', 'U3']);
    // index/length 必須精準指向該段顯示文字。
    for (const m of d.mentionees) {
      const seg = d.text.slice(m.index, m.index + m.length);
      expect(seg.startsWith('@')).toBe(true);
      expect(['@阿明', '@大雄']).toContain(seg);
    }
  });

  it('[D-015 AC-13] overflow → 整則退化為無 @ 提醒句（不部分 tag、不拆多則）', () => {
    const many: EditMentionTarget[] = Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 1 }, (_, i) => ({
      displayName: `人${i}`,
      lineUserId: `U${i}`,
    }));
    const d = formatEditOk(ok({ field: 'location', before: 'A', after: 'B', overflow: true }), many);
    expect(d.text).toBe('已更新場地：A → B\n活動資訊已更新，已報名的各位請確認。');
    expect(d.mentionees).toEqual([]);
  });

  it('[D-017 AC-7] 正取 0 人 → 只回成功句，不對空氣喊「已報名的各位請確認」', () => {
    // 主辦開團後自行 -1，正取歸零；此時仍輸出提示句會讓主辦誤以為有人收到通知。
    const d = formatEditOk(ok({ field: 'location', before: 'A', after: 'B', confirmedCount: 0, tagOwnerIds: [] }), []);
    expect(d.text).toBe('已更新場地：A → B');
    expect(d.text).not.toContain('已報名的各位請確認');
    expect(d.mentionees).toEqual([]);
  });

  it('[D-017 AC-7] overflow 的 targets 同樣是空陣列，但提示句必須保留（判斷順序）', () => {
    // overflow 與「沒人」的 targets 都是 []，只有 overflow 旗標能分辨：人在，只是不逐一標註。
    const d = formatEditOk(ok({ field: 'location', before: 'A', after: 'B', overflow: true }), []);
    expect(d.text).toBe('已更新場地：A → B\n活動資訊已更新，已報名的各位請確認。');
  });

  it('[D-015 AC-13] 未 overflow（＝上限）→ 正常 tag 全員', () => {
    const exact: EditMentionTarget[] = Array.from({ length: MAX_MENTIONS_PER_MESSAGE }, (_, i) => ({
      displayName: `人${i}`,
      lineUserId: `U${i}`,
    }));
    const d = formatEditOk(ok({ field: 'location', before: 'A', after: 'B', overflow: false }), exact);
    expect(d.mentionees).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
    expect(d.text).toContain('已報名的各位請確認：');
  });

  it('[D-015 AC-10] 新增文案皆為球種中性（不得出現特定球種用語，CLAUDE.md §0）', () => {
    const samples = [
      formatEditHelp(eventRow(), 4, NOW_A).text,
      formatEditOk(ok(), [{ displayName: '阿明', lineUserId: 'U1' }]).text,
      formatEditCapacityRedirect().text,
      formatEditPastDatetime(NOW_A).text,
      formatEditBadFee().text,
      formatEditFormatError('date', NOW_A).text,
      formatEditFormatError('time', NOW_A).text,
      formatEditFormatError('location', NOW_A, { len: 41 }).text,
      formatEditNotAuthorized().text,
      formatEditClosedNotEditable().text,
      formatEditEventEnded().text,
    ];
    // 專案曾重演過的 blocker：新增文案引入特定球種用語。此清單為守門，不得放寬。
    // （fixture 的 location 刻意取中性值，避免把「使用者輸入的資料」誤判為「我方文案」。）
    const banned = ['高爾夫', '球場', '球敘', '球聚', '開球', '果嶺', '桿', '羽球', '網球', '籃球'];
    for (const s of samples) {
      for (const w of banned) expect(s).not.toContain(w);
    }
  });
});
