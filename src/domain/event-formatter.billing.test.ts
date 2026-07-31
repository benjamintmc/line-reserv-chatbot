import { describe, it, expect } from 'vitest';
import type { EventRow } from '../db/schema';
import type { CreateEventDraft } from './create-flow';
import {
  formatFlowPrompt,
  formatFieldError,
  formatConfirmSummary,
  formatOpenAnnouncement,
  formatClosed,
  formatCancelled,
  formatAlreadyActiveEntry,
  formatOnelineFormatHelp,
} from './event-formatter';

function evt(over: Partial<EventRow>): EventRow {
  return {
    id: 1,
    group_id: 'G',
    host_user_id: 1,
    event_date: '2026-08-15',
    event_time: '07:30',
    location: '東方球場',
    capacity: 16,
    price_per_person: 0,
    price_mode: 'per_person',
    venue_fee: null,
    settled_per_person: null,
    status: 'open',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('event-formatter 計費 + 中性化（D-005 §5 / §7）', () => {
  it('[D-005 AC-11] 逐步提問中性化：時間 / 場地（非「開球時間」/「球場地點」）', () => {
    expect(formatFlowPrompt('awaiting_time').text).toContain('請輸入時間');
    expect(formatFlowPrompt('awaiting_time').text).not.toContain('開球時間');
    expect(formatFlowPrompt('awaiting_location').text).toContain('請輸入場地');
    expect(formatFlowPrompt('awaiting_location').text).not.toContain('球場地點');
  });

  it('[D-005 AC-10] 單題費用提問範本：含每人/場地費兩種寫法 + 取消逃生口', () => {
    const p = formatFlowPrompt('awaiting_fee').text;
    expect(p).toContain('請輸入費用');
    expect(p).toContain('每人');
    expect(p).toContain('場地費');
    expect(p).toContain('取消');
  });

  it('[D-005 AC-17] 單題費用無效重問範本：含兩種寫法範例', () => {
    const fe = formatFieldError('awaiting_fee').text;
    expect(fe).toContain('費用格式不正確');
    expect(fe).toContain('2200');
    expect(fe).toContain('場地費3000');
  });

  it('[D-005 AC-14] 確認摘要 split 標暫估、不硬算每人', () => {
    const draft: CreateEventDraft = {
      date: '2026-08-15', time: '07:30', location: '東方球場', capacity: 16,
      priceMode: 'split_venue', venueFee: 3000, price: 0,
    };
    const text = formatConfirmSummary(draft).text;
    expect(text).toContain('場地：東方球場');
    expect(text).toContain('費用：場地費 3000 元，開團後依實際報名人數均攤（暫估，關閉報名後結算）');
  });

  it('[D-005 AC-19] 開團公告 split：只顯示場地費總額、不含「平均每人約」、明示主辦佔首位', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    const text = formatOpenAnnouncement(e).text;
    expect(text).toContain('[東方球場 球敘] 開團成功！');
    expect(text).toContain('費用：場地費 3000 元，將依報名人數均攤（暫估，關閉報名後結算）');
    expect(text).not.toContain('平均每人約');
    expect(text).toContain('主辦已自動報名為第 1 位');
    expect(text).toContain('場地：東方球場');
  });

  it('[D-005 AC-19] 開團公告 per_person：每人費用列（回歸）', () => {
    const e = evt({ price_mode: 'per_person', price_per_person: 2200 });
    const text = formatOpenAnnouncement(e).text;
    expect(text).toContain('每人費用：2200 元');
  });

  it('[D-005 AC-7] formatClosed split：以 settledPerPerson 為唯一真相顯示最終攤額 + 多收不找零', () => {
    // 注意 event.settled_per_person 為 pre-close 快照（可能 NULL）；formatClosed 只認傳入值。
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0, settled_per_person: null });
    const text = formatClosed(e, 429, 7).text;
    expect(text).toContain('「東方球場」球敘已關閉報名');
    expect(text).toContain('本場最終每人費用：429 元（場地費 3000 元 ÷ 正取 7 人，除不盡無條件進位；多收部分不另找零）');
  });

  it('[D-005 AC-8] formatClosed per_person：不附結算列', () => {
    const e = evt({ price_mode: 'per_person', price_per_person: 2200 });
    const text = formatClosed(e, null, 5).text;
    expect(text).toBe('「東方球場」球敘已關閉報名，不再接受新報名。');
  });

  it('[D-005 AC-11] 取消活動回覆中性化「球敘」', () => {
    expect(formatCancelled(evt({})).text).toBe('「東方球場」球敘已取消。');
  });

  it('[D-005 AC-14] 重複活動摘要 split 費用列 mode-aware', () => {
    const e = evt({ price_mode: 'split_venue', venue_fee: 3000, price_per_person: 0 });
    const text = formatAlreadyActiveEntry(e).text;
    expect(text).toContain('費用：場地費 3000 元，將依報名人數均攤（暫估，關閉報名後結算）');
    expect(text).toContain('場地：東方球場');
  });

  it('[D-005 AC-18] (K′) 一行式格式提示涵蓋兩種計費語法', () => {
    const text = formatOnelineFormatHelp().text;
    expect(text).toContain('每人固定');
    expect(text).toContain('2200元');
    expect(text).toContain('場地費均攤');
    expect(text).toContain('場地費3000元');
  });
});
