import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommand, COMMAND_HEAD_KEYWORDS } from '../parse';
import { splitSelector, SELECTOR_STOP_KEYWORDS } from '../selector';

/** D-024 §4.2：`@selector` 前綴切分（純函式，parseCommand 的前置）。 */

const PARSE_SRC = readFileSync(join(__dirname, '..', 'parse.ts'), 'utf8');

/**
 * AC-29 的**可重複呼叫**斷言：parse.ts 指令頭關鍵字集合 ⊆ splitSelector 停止詞集合。
 * 抽成函式是為了能以「刻意塞入假關鍵字」的方式證明它會失敗（非恆真斷言）。
 */
function assertSubsetOfStopWords(keywords: ReadonlyArray<string>): void {
  const stop = new Set(SELECTOR_STOP_KEYWORDS.map((k) => k.toLowerCase()));
  const missing = keywords.filter((k) => !stop.has(k.toLowerCase()));
  expect(missing, `不在 splitSelector 停止詞集合內的指令頭關鍵字：${missing.join('、')}`).toEqual([]);
}

describe('D-024 splitSelector（§4.2）', () => {
  it('無 @ 前綴 → 原樣不動（rest === text，既有路徑零回歸）', () => {
    for (const text of ['+1', '-2 陳先生', '名單', '開團 2026/09/01 08:00 東方球場 12 每人1200', '哈囉']) {
      expect(splitSelector(text)).toEqual({ selectorRaw: undefined, rest: text });
    }
  });

  it('`@` 後為空（單獨一個 @）→ 視為無效前綴、原樣不動', () => {
    expect(splitSelector('@ +1')).toEqual({ selectorRaw: undefined, rest: '@ +1' });
    expect(splitSelector('@')).toEqual({ selectorRaw: undefined, rest: '@' });
  });

  it('單一 token selector + 指令：selector 去 @、rest 自停止 token 起', () => {
    expect(splitSelector('@旭陽 +1')).toEqual({ selectorRaw: '旭陽', rest: '+1' });
    expect(splitSelector('@旭陽 名單')).toEqual({ selectorRaw: '旭陽', rest: '名單' });
    expect(splitSelector('@旭陽 -2 陳先生')).toEqual({ selectorRaw: '旭陽', rest: '-2 陳先生' });
  });

  it('多 token selector：累積到停止 token 為止，依原文字元切出（不重組間距）', () => {
    expect(splitSelector('@旭陽 8/15 07:30 +1')).toEqual({
      selectorRaw: '旭陽 8/15 07:30',
      rest: '+1',
    });
  });

  it('換行穿越：selector 獨佔第一行、指令在第二行（D-012 批次寫法）', () => {
    expect(splitSelector('@旭陽\n+1\n-1 陳先生')).toEqual({
      selectorRaw: '旭陽',
      rest: '+1\n-1 陳先生',
    });
  });

  it('掃到結尾未命中停止 token → selector 吃滿剩餘文字、rest 為空字串', () => {
    expect(splitSelector('@旭陽')).toEqual({ selectorRaw: '旭陽', rest: '' });
    expect(parseCommand(splitSelector('@旭陽').rest).type).toBe('unknown'); // 無害
  });

  it('G5：全形 ＠(U+FF20) 併入白名單表 → 與半形 @ 等義；不做整串 NFKC', () => {
    expect(splitSelector('＠旭陽 ＋1')).toEqual({ selectorRaw: '旭陽', rest: '+1' });
    // 非白名單字元原樣保留（例如全形括號不被轉半形）。
    expect(splitSelector('@旭陽（東） +1').selectorRaw).toBe('旭陽（東）');
  });

  it('停止 token 涵蓋 `+N`/`-N` 起手與全部指令頭關鍵字', () => {
    for (const kw of COMMAND_HEAD_KEYWORDS) {
      expect(splitSelector(`@旭陽 ${kw}`), kw).toEqual({ selectorRaw: '旭陽', rest: kw });
    }
    expect(splitSelector('@旭陽 +12').rest).toBe('+12');
    expect(splitSelector('@旭陽 -3').rest).toBe('-3');
  });

  it('[D-024 AC-29] parse.ts 指令頭關鍵字 ⊆ splitSelector 停止詞；塞入假關鍵字時該斷言必失敗', () => {
    // (1) 正向：目前兩處同步。
    assertSubsetOfStopWords(COMMAND_HEAD_KEYWORDS);

    // (2) 偵測力：刻意加入一個**不在**停止詞集合內的假關鍵字 → 同一條斷言必須失敗。
    //     （若斷言恆真，下面這行會因「未拋出」而讓本測試紅燈。）
    expect(SELECTOR_STOP_KEYWORDS).not.toContain('報到'); // 前提：確為假關鍵字
    expect(() => assertSubsetOfStopWords([...COMMAND_HEAD_KEYWORDS, '報到'])).toThrow();
  });

  it('G-selector-sync 防漂移：COMMAND_HEAD_KEYWORDS 與 parse.ts dispatch 表的字面一致', () => {
    // 靜態掃描 parse.ts 的分派字面（`s === '…'`／`head === '…'`／
    // `equalsIgnoreAsciiCase(s, '…')`／CREATE_KEYWORDS），確保清單既不遺漏也無殘留。
    const found = new Set<string>();
    for (const re of [
      /\bs === '([^']+)'/g,
      /\bhead === '([^']+)'/g,
      /equalsIgnoreAsciiCase\(s, '([^']+)'\)/g,
    ]) {
      for (const m of PARSE_SRC.matchAll(re)) found.add(m[1]!);
    }
    const createArr = /const CREATE_KEYWORDS = \[([^\]]*)\]/.exec(PARSE_SRC);
    for (const m of (createArr?.[1] ?? '').matchAll(/'([^']+)'/g)) found.add(m[1]!);

    expect([...found].sort()).toEqual([...COMMAND_HEAD_KEYWORDS].sort());
  });
});
