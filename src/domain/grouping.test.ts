import { describe, it, expect } from 'vitest';
import {
  partitionBalanced,
  startSession,
  nextRound,
  defaultCourts,
  type GroupingState,
  type RandomFn,
  type Round,
} from './grouping';

/** 固定 seed 的可重現 PRNG（mulberry32）。 */
function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function labels(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `P${i + 1}`);
}

function sizes(groups: string[][]): number[] {
  return groups.map((g) => g.length).sort((a, b) => a - b);
}

function allNames(groups: string[][]): string[] {
  return groups.flat().sort();
}

/** 跑 rounds 輪（startSession + nextRound*），回傳最終 state 與各輪。 */
function runRounds(
  n: number,
  opts: { courts?: number; rounds?: number | null; mode: 'singles' | 'doubles' },
  seed: number,
  total: number,
): { state: GroupingState; rounds: Round[] } {
  const rng = mulberry32(seed);
  const start = startSession(labels(n), opts, rng);
  if (start.kind !== 'round') throw new Error('expected round');
  let state = start.state;
  const rounds: Round[] = [start.round];
  for (let r = 1; r < total; r++) {
    const nx = nextRound(state, rng);
    if (nx.kind !== 'round') throw new Error('expected round');
    state = nx.state;
    rounds.push(nx.round);
  }
  return { state, rounds };
}

describe('D-011 策略A：均分 partition', () => {
  it('[D-011 AC-1] r=0：N=8/12 全為 4 人組、無 3 人組', () => {
    for (const n of [8, 12]) {
      const res = partitionBalanced(labels(n), mulberry32(1));
      if (res.kind !== 'groups') throw new Error('expected groups');
      expect(res.groups.every((g) => g.length === 4)).toBe(true);
      expect(allNames(res.groups)).toEqual(labels(n).sort());
    }
  });

  it('[D-011 AC-2] r=3：N=7/11 恰一組 3、其餘皆 4', () => {
    for (const n of [7, 11]) {
      const res = partitionBalanced(labels(n), mulberry32(2));
      if (res.kind !== 'groups') throw new Error('expected groups');
      expect(sizes(res.groups).filter((s) => s === 3)).toHaveLength(1);
      expect(sizes(res.groups).filter((s) => s === 4)).toHaveLength((n - 3) / 4);
    }
  });

  it('[D-011 AC-3] r=2：N=6/10 恰兩組 3、其餘皆 4', () => {
    for (const n of [6, 10]) {
      const res = partitionBalanced(labels(n), mulberry32(3));
      if (res.kind !== 'groups') throw new Error('expected groups');
      expect(sizes(res.groups).filter((s) => s === 3)).toHaveLength(2);
      expect(sizes(res.groups).filter((s) => s === 4)).toHaveLength((n - 6) / 4);
    }
  });

  it('[D-011 AC-4] r=1：N=9/13 恰三組 3、其餘皆 4', () => {
    for (const n of [9, 13]) {
      const res = partitionBalanced(labels(n), mulberry32(4));
      if (res.kind !== 'groups') throw new Error('expected groups');
      expect(sizes(res.groups).filter((s) => s === 3)).toHaveLength(3);
      expect(sizes(res.groups).filter((s) => s === 4)).toHaveLength((n - 9) / 4);
    }
  });

  it('[D-011 AC-5] 邊界 N∈{1,2} → insufficient、不產任何組', () => {
    expect(partitionBalanced(labels(1), mulberry32(5)).kind).toBe('insufficient');
    expect(partitionBalanced(labels(2), mulberry32(5)).kind).toBe('insufficient');
  });

  it('[D-011 AC-6] 邊界 N=5 → 一組 5 人（不拆 4+1／3+2）', () => {
    const res = partitionBalanced(labels(5), mulberry32(6));
    if (res.kind !== 'single_group') throw new Error('expected single_group');
    expect(res.group).toHaveLength(5);
    expect([...res.group].sort()).toEqual(labels(5).sort());
  });
});

describe('D-011 策略B：逐輪輪替排程', () => {
  it('[D-011 AC-7] 雙打 20 人 5 場 4 輪 → 隊友 pair 零重複', () => {
    const { state } = runRounds(20, { courts: 5, rounds: 4, mode: 'doubles' }, 42, 4);
    expect(new Set(state.partnerPairs).size).toBe(state.partnerPairs.length);
  });

  it('[D-011 AC-8] 雙打 20 人 5 場 4 輪 → 對手 pair 零重複', () => {
    const { state } = runRounds(20, { courts: 5, rounds: 4, mode: 'doubles' }, 42, 4);
    expect(new Set(state.opponentPairs).size).toBe(state.opponentPairs.length);
  });

  it('[D-011 AC-9] 有輪空案例（雙打 12 人 2 場 6 輪）→ sit-out 累計極差 ≤ 1', () => {
    const { state } = runRounds(12, { courts: 2, rounds: 6, mode: 'doubles' }, 7, 6);
    const diff = Math.max(...state.sitOutCounts) - Math.min(...state.sitOutCounts);
    expect(diff).toBeLessThanOrEqual(1);
  });

  it('[D-011 AC-10] 有輪空案例（雙打 12 人 2 場 6 輪）→ 無人連續三輪出賽', () => {
    const { rounds } = runRounds(12, { courts: 2, rounds: 6, mode: 'doubles' }, 7, 6);
    const played = (round: Round): Set<string> =>
      new Set(round.courts.flatMap((c) => [...c.teamA, ...c.teamB]));
    const perRound = rounds.map(played);
    for (const name of labels(12)) {
      let streak = 0;
      for (const set of perRound) {
        streak = set.has(name) ? streak + 1 : 0;
        expect(streak).toBeLessThan(3);
      }
    }
  });

  it('[D-011 AC-11] 啟動只輸出「第 1 輪」（單一輪、round=1）', () => {
    const start = startSession(labels(16), { courts: 4, mode: 'doubles' }, mulberry32(9));
    if (start.kind !== 'round') throw new Error('expected round');
    expect(start.round.round).toBe(1);
    expect(start.state.round).toBe(1);
  });

  it('[D-011 AC-12] 雙打 M 未帶 → floor(N/4)（N=12 → 3 場）', () => {
    expect(defaultCourts(12, 'doubles')).toBe(3);
    const start = startSession(labels(12), { mode: 'doubles' }, mulberry32(10));
    if (start.kind !== 'round') throw new Error('expected round');
    expect(start.round.courts).toHaveLength(3);
  });

  it('[D-011 AC-18] 單打可行案例（8 人 4 場）→ 每場 2 人、無隊友、對手不重複', () => {
    const { state, rounds } = runRounds(8, { courts: 4, rounds: 3, mode: 'singles' }, 3, 3);
    expect(state.partnerPairs).toHaveLength(0); // 單打無隊友 pair（G6）
    for (const round of rounds) {
      for (const court of round.courts) {
        expect(court.teamA).toHaveLength(1);
        expect(court.teamB).toHaveLength(1);
      }
    }
    expect(new Set(state.opponentPairs).size).toBe(state.opponentPairs.length);
  });

  it('[D-011 AC-19] 單打 M 未帶 → floor(N/2)（N=10 → 5 場）', () => {
    expect(defaultCourts(10, 'singles')).toBe(5);
    const start = startSession(labels(10), { mode: 'singles' }, mulberry32(11));
    if (start.kind !== 'round') throw new Error('expected round');
    expect(start.round.courts).toHaveLength(5);
  });

  it('[D-011 AC-21] 連續 下一輪 → 與先前所有輪隊友/對手不重複、sit-out 累計延續', () => {
    const { state, rounds } = runRounds(16, { courts: 4, rounds: null, mode: 'doubles' }, 5, 3);
    expect(new Set(state.partnerPairs).size).toBe(state.partnerPairs.length);
    expect(new Set(state.opponentPairs).size).toBe(state.opponentPairs.length);
    expect(rounds.map((r) => r.round)).toEqual([1, 2, 3]);
  });

  it('[D-011 AC-22] R 上限：帶 5輪 到第 5 輪後 exhausted；未帶（null）可連續 >5 輪', () => {
    // 帶上限：rounds=2 → 第 1、2 輪後 exhausted。
    const rng = mulberry32(8);
    const start = startSession(labels(8), { courts: 2, rounds: 2, mode: 'doubles' }, rng);
    if (start.kind !== 'round') throw new Error('expected round');
    const r2 = nextRound(start.state, rng);
    if (r2.kind !== 'round') throw new Error('expected round');
    expect(r2.round.round).toBe(2);
    expect(nextRound(r2.state, rng).kind).toBe('exhausted');

    // 未帶上限：可連續超過任何固定數（此處 7 輪）。
    const { rounds } = runRounds(8, { courts: 2, rounds: null, mode: 'doubles' }, 8, 7);
    expect(rounds).toHaveLength(7);
    expect(rounds[6]!.round).toBe(7);
  });

  it('連一場都湊不滿（單打 N=1）→ insufficient', () => {
    expect(startSession(labels(1), { mode: 'singles' }, mulberry32(1)).kind).toBe('insufficient');
  });
});
