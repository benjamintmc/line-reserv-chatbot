// src/domain/grouping-formatter.ts
//
// D-011 §4：分組中性組版（純函式；繁體中文；球種中性，G2）。
// 策略A `第 k 組：A、B、C、D`；策略B `第 r 輪` 下各場 `A場：A、B vs C、D`
// （單打 `A場：A vs B`）、A-Z 場名、每輪末 `輪空：…`。
// 單打/雙打之差異由 team 陣列長度天然表現（單打各 1、雙打各 2），組版無需分支。
// **不改動既有 formatter 措辭（G4）**；本檔為新增獨立模組。

import type { PartitionResult, Round } from './grouping';

/** 場地名（≤26 場用 A、B、C…Z；超過以「第 N 場」遞補，§4 errata 2026-08-17）。 */
const COURT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function courtName(indexZeroBased: number): string {
  if (indexZeroBased < COURT_LETTERS.length) {
    return `${COURT_LETTERS.charAt(indexZeroBased)}場`;
  }
  return `第 ${indexZeroBased + 1} 場`;
}

/** 策略A：3/4 均分 / N=5 一組 / 不足提示（§2、AC-5/AC-6/AC-15）。 */
export function formatPartition(result: PartitionResult): string {
  if (result.kind === 'insufficient') {
    return '報名人數不足，無法分組';
  }
  if (result.kind === 'single_group') {
    return `第 1 組：${result.group.join('、')}\n（人數 5，暫不拆組）`;
  }
  return result.groups.map((g, i) => `第 ${i + 1} 組：${g.join('、')}`).join('\n');
}

/** 策略B：單一輪組版（§4、AC-15 雙打 / AC-20 單打）。 */
export function formatRound(round: Round): string {
  const lines: string[] = [`第 ${round.round} 輪`];
  round.courts.forEach((court, i) => {
    const left = court.teamA.join('、');
    const right = court.teamB.join('、');
    lines.push(`${courtName(i)}：${left} vs ${right}`);
  });
  if (round.sitOut.length > 0) {
    lines.push(`輪空：${round.sitOut.join('、')}`);
  }
  return lines.join('\n');
}

/** 策略B：連一場都湊不滿（N < 每場人數）。 */
export function formatInsufficientForRounds(): string {
  return '報名人數不足，無法分組';
}

/** `下一輪` 但無進行中 session（AC-23）。 */
export function formatNoGroupingSession(): string {
  return '目前沒有進行中的分組，請先『分組 …』';
}

/** `下一輪` 但已達輪數上限（AC-22）。 */
export function formatRoundsExhausted(): string {
  return '已達輪數上限';
}

/** 分組／下一輪 非主辦（host-only，errata 2026-08-17）之拒絕文案（中性、不提管理員）。 */
export function formatGroupNotHost(): string {
  return '只有開團的人可以使用分組。';
}

/** `分組` 參數畸形的中文格式提示。 */
export function formatGroupFormatHelp(): string {
  return [
    '分組指令格式：',
    '・分組（均分成 3～4 人一組）',
    '・分組 2場（多輪輪替，之後打「下一輪」）',
    '・分組 2場 5輪（限定 5 輪）',
    '・分組 2場 單打（1v1）',
  ].join('\n');
}
