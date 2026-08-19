import { describe, it, expect } from 'vitest';
import {
  formatPartition,
  formatRound,
  formatInsufficientForRounds,
  formatNoGroupingSession,
  formatRoundsExhausted,
  formatGroupNotHost,
  formatGroupFormatHelp,
} from './grouping-formatter';
import type { PartitionResult, Round } from './grouping';

/** 特定球種字眼（G2）：任何 user-facing 輸出皆不得出現。 */
const SPORT_WORDS = ['高爾夫', '匹克球', 'pickleball', 'golf', '羽球', '網球'];

function assertNeutral(s: string): void {
  for (const w of SPORT_WORDS) {
    expect(s.toLowerCase()).not.toContain(w.toLowerCase());
  }
}

describe('D-011 §4 中性組版', () => {
  it('[D-011 AC-15] 策略A：每行 第 k 組：A、B、C、D', () => {
    const result: PartitionResult = {
      kind: 'groups',
      groups: [
        ['A', 'B', 'C', 'D'],
        ['E', 'F', 'G'],
      ],
    };
    const out = formatPartition(result);
    expect(out).toBe('第 1 組：A、B、C、D\n第 2 組：E、F、G');
    assertNeutral(out);
  });

  it('[D-011 AC-15] 策略B 雙打：第 r 輪 下 A場：A、B vs C、D、輪空列', () => {
    const round: Round = {
      round: 1,
      courts: [
        { teamA: ['A', 'B'], teamB: ['C', 'D'] },
        { teamA: ['E', 'F'], teamB: ['G', 'H'] },
      ],
      sitOut: ['X', 'Y'],
    };
    const out = formatRound(round);
    expect(out).toBe('第 1 輪\nA場：A、B vs C、D\nB場：E、F vs G、H\n輪空：X、Y');
    assertNeutral(out);
  });

  it('[D-011 AC-20] 策略B 單打：A場：A vs B（無「、」隊友）、無輪空則略', () => {
    const round: Round = {
      round: 2,
      courts: [
        { teamA: ['A'], teamB: ['B'] },
        { teamA: ['C'], teamB: ['D'] },
      ],
      sitOut: [],
    };
    const out = formatRound(round);
    expect(out).toBe('第 2 輪\nA場：A vs B\nB場：C vs D');
    expect(out).not.toContain('輪空');
    assertNeutral(out);
  });

  it('[D-011 AC-13] 中性文案：均分/多輪/不足/提示皆不含球種字眼', () => {
    assertNeutral(formatPartition({ kind: 'insufficient' }));
    assertNeutral(formatPartition({ kind: 'single_group', group: ['A', 'B', 'C', 'D', 'E'] }));
    assertNeutral(formatInsufficientForRounds());
    assertNeutral(formatNoGroupingSession());
    assertNeutral(formatRoundsExhausted());
    assertNeutral(formatGroupNotHost());
    assertNeutral(formatGroupFormatHelp());
  });

  it('[D-011 AC-5] 不足提示文案', () => {
    expect(formatPartition({ kind: 'insufficient' })).toBe('報名人數不足，無法分組');
  });

  it('[D-011 AC-6] N=5 一組 5 人 + 附註', () => {
    const out = formatPartition({ kind: 'single_group', group: ['A', 'B', 'C', 'D', 'E'] });
    expect(out).toBe('第 1 組：A、B、C、D、E\n（人數 5，暫不拆組）');
  });

  it('場地名遞補：>26 場以「第 N 場」表示', () => {
    const courts = Array.from({ length: 27 }, (_, i) => ({
      teamA: [`a${i}`],
      teamB: [`b${i}`],
    }));
    const out = formatRound({ round: 1, courts, sitOut: [] });
    expect(out).toContain('Z場：a25 vs b25');
    expect(out).toContain('第 27 場：a26 vs b26');
  });
});
