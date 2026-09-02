import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventRow } from '../db/schema';
import { matchSelector, resolveTargetEvent } from './event-disambiguation';
import { splitSelector } from '../commands/selector';
import { truncateForDisplay, formatEventNotFound, formatEventTooMany } from './disambiguation-formatter';

/** D-023 §4.3 / D-024（顯示截斷）：純函式層。 */

const NOW = '2999-01-01T00:00:00Z';

function ev(id: number, location: string, eventDatetime: string): EventRow {
  return {
    id,
    group_id: 'G',
    host_user_id: 1,
    event_datetime: eventDatetime,
    location,
    capacity: 16,
    price_per_person: 0,
    price_mode: 'per_person',
    venue_fee: null,
    settled_per_person: null,
    status: 'open',
    created_at: NOW,
    updated_at: NOW,
  };
}

// 台灣本地：2999-08-15 07:30 / 2999-08-15 09:00 / 2999-09-20 07:30
const A = ev(1, '旭陽球場', '2999-08-14T23:30:00Z');
const B = ev(2, '旭陽球場', '2999-08-15T01:00:00Z');
const C = ev(3, '東方球場', '2999-09-19T23:30:00Z');

describe('D-023 resolveTargetEvent 判斷順序（G2）', () => {
  it('候選 0 → none；候選 1 → single（完全不看 selector/quote）', () => {
    expect(resolveTargetEvent([], undefined, undefined, NOW)).toEqual({ kind: 'none' });
    // G2：candidates.length<=1 必須**最先**判斷——即便 selector 格式再怎麼不合、
    // 或 quote 指向別的活動，都不驗證、不影響結果。
    expect(resolveTargetEvent([A], undefined, undefined, NOW)).toEqual({ kind: 'single', eventId: 1 });
    expect(resolveTargetEvent([A], undefined, '完全對不上的鬼東西', NOW)).toEqual({
      kind: 'single',
      eventId: 1,
    });
    expect(resolveTargetEvent([A], 999, '東方', NOW)).toEqual({ kind: 'single', eventId: 1 });
  });

  it('>1 候選：無 quote 無 selector → ambiguous', () => {
    expect(resolveTargetEvent([A, B], undefined, undefined, NOW)).toEqual({ kind: 'ambiguous' });
  });

  it('>1 候選：只有 selector → 依命中數 0/1/多 回 not_found/resolved/too_many', () => {
    expect(resolveTargetEvent([A, C], undefined, '不存在的場地', NOW)).toEqual({
      kind: 'not_found',
      selectorRaw: '不存在的場地',
    });
    expect(resolveTargetEvent([A, C], undefined, '東方', NOW)).toEqual({ kind: 'resolved', eventId: 3 });
    expect(resolveTargetEvent([A, B, C], undefined, '球場', NOW)).toEqual({
      kind: 'too_many',
      selectorRaw: '球場',
    });
  });

  it('>1 候選：只有 quote → resolved（不過濾是否仍在候選內，交由各指令自身狀態判斷）', () => {
    expect(resolveTargetEvent([A, B], 77, undefined, NOW)).toEqual({ kind: 'resolved', eventId: 77 });
  });

  it('>1 候選：quote 與 selector 指向不同活動 → conflict；一致 → resolved', () => {
    expect(resolveTargetEvent([A, C], 1, '東方', NOW)).toEqual({ kind: 'conflict' });
    expect(resolveTargetEvent([A, B, C], 1, '球場', NOW)).toEqual({ kind: 'conflict' }); // selector 非恰一場
    expect(resolveTargetEvent([A, C], 3, '東方', NOW)).toEqual({ kind: 'resolved', eventId: 3 });
  });
});

describe('D-023 matchSelector 比對規則（§4.3 步驟 1–6）', () => {
  it('場地子字串（區分大小寫）過濾', () => {
    expect(matchSelector([A, B, C], '東方', NOW).map((e) => e.id)).toEqual([3]);
    expect(matchSelector([A, B, C], '球場', NOW).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(matchSelector([A, B, C], '不存在', NOW).map((e) => e.id)).toEqual([]);
  });

  it('日期 token：完整日期精確比對；月日只比 MM-DD（忽略年份）', () => {
    expect(matchSelector([A, B, C], '2999/09/20', NOW).map((e) => e.id)).toEqual([3]);
    expect(matchSelector([A, B, C], '9/20', NOW).map((e) => e.id)).toEqual([3]);
    expect(matchSelector([A, B, C], '8-15', NOW).map((e) => e.id)).toEqual([1, 2]);
  });

  it('時間 token 僅在「場地+日期過濾後仍 >1 場」時才套用（次要窄化條件）', () => {
    // 場地+日期已收斂到 1 場 → 即使時間對不上也不再過濾掉（步驟 5）。
    expect(matchSelector([A, C], '東方 07:30', NOW).map((e) => e.id)).toEqual([3]);
    // 場地+日期後仍 2 場 → 時間生效。
    expect(matchSelector([A, B], '旭陽 8/15', NOW).map((e) => e.id)).toEqual([1, 2]);
    expect(matchSelector([A, B], '旭陽 8/15 07:30', NOW).map((e) => e.id)).toEqual([1]);
  });
});

describe('D-024 顯示截斷 truncateForDisplay', () => {
  it('[D-024 AC-30] 長度 25 → 前 20 字 + …；長度 20（邊界）原樣不加 …', () => {
    const len25 = 'あ'.repeat(25);
    const len20 = 'あ'.repeat(20);
    const len19 = 'あ'.repeat(19);

    expect(truncateForDisplay(len25)).toBe(`${'あ'.repeat(20)}…`);
    expect(truncateForDisplay(len20)).toBe(len20); // 邊界零截斷
    expect(truncateForDisplay(len19)).toBe(len19);

    // not_found / too_many 文案中的 {xxx} 走同一條截斷。
    expect(formatEventNotFound(len25).text).toBe(`找不到符合 ${'あ'.repeat(20)}… 的球敘，請確認後再試`);
    expect(formatEventTooMany(len25).text).toBe(`有超過一場 ${'あ'.repeat(20)}… 的球敘，請修正再試`);
    expect(formatEventNotFound(len20).text).toBe(`找不到符合 ${len20} 的球敘，請確認後再試`);
    expect(formatEventTooMany(len20).text).toBe(`有超過一場 ${len20} 的球敘，請修正再試`);

    // `selectorRaw` 本身**不**被截斷（截斷只發生在 formatter 層）。
    const r = resolveTargetEvent([A, C], undefined, len25, NOW);
    expect(r.kind === 'not_found' && r.selectorRaw).toBe(len25);
  });
});

describe('D-024 純函式性', () => {
  it('[D-024 AC-24] 三者對同一輸入呼叫兩次 deep-equal、皆不拋例外、且原始碼無 DB 依賴', () => {
    const inputs = ['@旭陽 8/15 07:30 +1', '', '@', '+1', '@'.repeat(50), '＠東方\n名單'];
    for (const text of inputs) {
      expect(() => splitSelector(text)).not.toThrow();
      expect(splitSelector(text)).toEqual(splitSelector(text));
    }
    const selectors = ['旭陽', '球場 8/15', '', '   ', '9/20 07:30', 'no-match'];
    for (const sel of selectors) {
      expect(() => matchSelector([A, B, C], sel, NOW)).not.toThrow();
      expect(matchSelector([A, B, C], sel, NOW)).toEqual(matchSelector([A, B, C], sel, NOW));
      for (const q of [undefined, 2]) {
        expect(() => resolveTargetEvent([A, B, C], q, sel, NOW)).not.toThrow();
        expect(resolveTargetEvent([A, B, C], q, sel, NOW)).toEqual(
          resolveTargetEvent([A, B, C], q, sel, NOW),
        );
      }
    }
    // 候選集合不得被就地改動（純函式）。
    const candidates = [A, B, C];
    matchSelector(candidates, '球場', NOW);
    expect(candidates).toEqual([A, B, C]);

    // 靜態審查 import：兩檔皆不得觸 DB（不 import repository/pg、無 SQL、無 query 呼叫）。
    for (const file of [
      join(__dirname, '..', 'commands', 'selector.ts'),
      join(__dirname, 'event-disambiguation.ts'),
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/from '.*repositories\//);
      expect(src, file).not.toMatch(/from 'pg'/);
      expect(src, file).not.toMatch(/\bSELECT\b\s+.*\bFROM\b/i);
      expect(src, file).not.toMatch(/\.query\(/);
      expect(src, file).not.toMatch(/\bawait\b/); // 全同步純函式，無任何 I/O
    }
  });
});
