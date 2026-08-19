// src/domain/grouping.ts
//
// D-011：分組演算法（純函式、零 DB、零副作用、嚴禁 any）。
// 策略A（`partitionBalanced`）：3/4 均分、最大化 4 人組（§2）。
// 策略B（`startSession` / `nextRound`）：逐輪輪替排程，避開全歷史隊友/對手、
//   延續 sit-out 累計公平，成本函式依 §3（③出賽平均優先、④連續三輪次級軟懲罰，裁決 #1/#2）。
//
// 內部一律以「玩家索引（0..N-1）」運算、只在輸出時映射回 labels——因 labels 不保證唯一
// （不同 LINE 用戶同顯示名不加後綴，見 roster.ts），以索引為身分才不致碰撞。

/** 注入的亂數來源：回傳 [0,1)（測試以固定 seed 的產生器注入，確保可重現）。 */
export type RandomFn = () => number;

/** 分組模式：雙打（每場 4 人 2v2）/ 單打（每場 2 人 1v1、無隊友）。 */
export type GroupMode = 'singles' | 'doubles';

/** 策略A 結果（純資料，供 formatter 組版）。 */
export type PartitionResult =
  | { kind: 'groups'; groups: string[][] } // 僅 3/4 人組
  | { kind: 'single_group'; group: string[] } // N=5 特例：一組 5 人
  | { kind: 'insufficient' }; // N∈{0,1,2}：不足成組

/** 單一場地（雙打 teamA/teamB 各 2 人、單打各 1 人；以 labels 表示）。 */
export interface Court {
  teamA: string[];
  teamB: string[];
}

/** 單一輪（1-based 輪序、各場、輪空名單）。 */
export interface Round {
  round: number;
  courts: Court[];
  sitOut: string[];
}

/**
 * 策略B session 狀態（**可序列化**，存入 conversation_states.payload）。
 * 歷史以索引對（`"i|j"`，i<j）記錄；sit-out 與連續出賽以索引陣列累計。
 */
export interface GroupingState {
  mode: GroupMode;
  courts: number; // 有效場地數 M
  courtSize: number; // 每場人數（雙打 4／單打 2）
  roundsLimit: number | null; // R（選填上限）；null＝不設上限
  labels: string[]; // 凍結名單快照（分組當下）
  round: number; // 已產出的輪數
  partnerPairs: string[]; // 歷史隊友對（索引，雙打才有）
  opponentPairs: string[]; // 歷史對手對（索引）
  sitOutCounts: number[]; // 各人累計輪空次數
  consecutivePlayed: number[]; // 各人「最近連續出賽輪數」
}

export type StartResult =
  | { kind: 'round'; round: Round; state: GroupingState }
  | { kind: 'insufficient' }; // 連一場都湊不滿（N < courtSize）

export type NextResult =
  | { kind: 'round'; round: Round; state: GroupingState }
  | { kind: 'exhausted' }; // 已達 roundsLimit

const RESTARTS = 2000;
const W_PARTNER = 1_000_000;
const W_OPP = 1_000;
const W_SIT = 10;
const W_CONSEC = 1;

/** Fisher-Yates 洗牌（不變更輸入；以注入 rng 決定，可重現）。 */
function shuffle<T>(arr: readonly T[], rng: RandomFn): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function pairKey(i: number, j: number): string {
  return i < j ? `${i}|${j}` : `${j}|${i}`;
}

/** 每場人數（雙打 4／單打 2）。 */
export function courtSizeOf(mode: GroupMode): number {
  return mode === 'singles' ? 2 : 4;
}

/** M 未帶時的預設場數：`floor(N / courtSize)`（AC-12 雙打 / AC-19 單打）。 */
export function defaultCourts(n: number, mode: GroupMode): number {
  return Math.floor(n / courtSizeOf(mode));
}

// ── 策略A：3/4 均分 ──────────────────────────────────────────────────────
/**
 * 把 N 人拆成只有 3/4 的組、最大化 4 人組（組數最少）。§2：
 * `r=N%4` → threes=(4-r)%4；其餘湊 4。邊界 N∈{0,1,2} 不足；N=5 一組 5。
 */
export function partitionBalanced(labels: readonly string[], rng: RandomFn): PartitionResult {
  const n = labels.length;
  if (n <= 2) return { kind: 'insufficient' };
  if (n === 5) return { kind: 'single_group', group: shuffle(labels, rng) };

  const r = n % 4;
  const threes = (4 - r) % 4; // r=0→0, r=1→3, r=2→2, r=3→1
  const fours = (n - threes * 3) / 4;
  const shuffled = shuffle(labels, rng);

  const groups: string[][] = [];
  let cursor = 0;
  for (let k = 0; k < fours; k++) {
    groups.push(shuffled.slice(cursor, cursor + 4));
    cursor += 4;
  }
  for (let k = 0; k < threes; k++) {
    groups.push(shuffled.slice(cursor, cursor + 3));
    cursor += 3;
  }
  return { kind: 'groups', groups };
}

// ── 策略B：逐輪輪替排程 ──────────────────────────────────────────────────
interface RoundPlan {
  courts: number[][][]; // [court][team(0|1)][playerIndex...]
  sitOut: number[];
  cost: number;
}

/** 對一組已定 court 玩家（雙打 4 人）挑最小重複的隊友配對（3 種）。 */
function bestDoublesSplit(
  quad: number[],
  partnerSet: ReadonlySet<string>,
  oppSet: ReadonlySet<string>,
): { teamA: number[]; teamB: number[] } {
  const [p0, p1, p2, p3] = quad as [number, number, number, number];
  const options: Array<[number[], number[]]> = [
    [
      [p0, p1],
      [p2, p3],
    ],
    [
      [p0, p2],
      [p1, p3],
    ],
    [
      [p0, p3],
      [p1, p2],
    ],
  ];
  let best: { teamA: number[]; teamB: number[] } | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const [a, b] of options) {
    let c = 0;
    if (partnerSet.has(pairKey(a[0] as number, a[1] as number))) c += W_PARTNER;
    if (partnerSet.has(pairKey(b[0] as number, b[1] as number))) c += W_PARTNER;
    for (const x of a) for (const y of b) if (oppSet.has(pairKey(x, y))) c += W_OPP;
    if (c < bestCost) {
      bestCost = c;
      best = { teamA: a, teamB: b };
    }
  }
  // options 非空 → best 必非 null。
  return best as { teamA: number[]; teamB: number[] };
}

/** 產生單一輪的最佳排程（隨機化貪婪 + 多次重啟，早退於 cost=0）。 */
function scheduleOneRound(state: GroupingState, rng: RandomFn): RoundPlan {
  const n = state.labels.length;
  const effectiveCourts = Math.min(state.courts, Math.floor(n / state.courtSize));
  const onCourt = effectiveCourts * state.courtSize;
  const numSit = n - onCourt;
  const partnerSet = new Set(state.partnerPairs);
  const oppSet = new Set(state.opponentPairs);
  const indices = Array.from({ length: n }, (_, i) => i);

  let best: RoundPlan | null = null;
  for (let restart = 0; restart < RESTARTS; restart++) {
    // 1) 選輪空：以「累計輪空少者優先休息（排前→sitOut）以拉平；輪空多者上場」——
    //    先隨機洗牌得隨機 tiebreak，再穩定排序：sitOutCounts 少者排前（進 sitOut）。
    const order = shuffle(indices, rng).sort((a, b) => {
      if (state.sitOutCounts[a] !== state.sitOutCounts[b]) {
        return (state.sitOutCounts[a] as number) - (state.sitOutCounts[b] as number);
      }
      // 累計輪空相同時：連續出賽多者優先休息（排前 → 進 sitOut，破連續出賽）。
      return (state.consecutivePlayed[b] as number) - (state.consecutivePlayed[a] as number);
    });
    const sitOut = order.slice(0, numSit);
    const playing = order.slice(numSit);

    // 2) 排場：洗牌後切段；雙打挑最佳配對、單打直接 1v1。
    const shuffledPlaying = shuffle(playing, rng);
    const courts: number[][][] = [];
    for (let c = 0; c < effectiveCourts; c++) {
      const seg = shuffledPlaying.slice(c * state.courtSize, (c + 1) * state.courtSize);
      if (state.mode === 'doubles') {
        const { teamA, teamB } = bestDoublesSplit(seg, partnerSet, oppSet);
        courts.push([teamA, teamB]);
      } else {
        courts.push([[seg[0] as number], [seg[1] as number]]);
      }
    }

    // 3) 成本：重複隊友/對手 + sit-out 極差 + 連續三輪出賽懲罰。
    let cost = 0;
    for (const court of courts) {
      const [teamA, teamB] = court as [number[], number[]];
      if (state.mode === 'doubles') {
        if (partnerSet.has(pairKey(teamA[0] as number, teamA[1] as number))) cost += W_PARTNER;
        if (partnerSet.has(pairKey(teamB[0] as number, teamB[1] as number))) cost += W_PARTNER;
      }
      for (const x of teamA) for (const y of teamB) if (oppSet.has(pairKey(x, y))) cost += W_OPP;
    }
    const tmp = [...state.sitOutCounts];
    for (const s of sitOut) tmp[s] = (tmp[s] as number) + 1;
    cost += W_SIT * (Math.max(...tmp) - Math.min(...tmp));
    for (const p of playing) if ((state.consecutivePlayed[p] as number) >= 2) cost += W_CONSEC;

    if (best === null || cost < best.cost) best = { courts, sitOut, cost };
    if (cost === 0) break; // 已達理論最佳（無重複、無失衡、無連三）。
  }
  return best as RoundPlan;
}

/** 依 plan 產出 Round（索引→labels）並回傳更新後 state（不變更輸入）。 */
function applyRound(state: GroupingState, plan: RoundPlan): { round: Round; state: GroupingState } {
  const label = (i: number): string => state.labels[i] as string;
  const courts: Court[] = plan.courts.map((court) => {
    const [teamA, teamB] = court as [number[], number[]];
    return { teamA: teamA.map(label), teamB: teamB.map(label) };
  });
  const roundNo = state.round + 1;

  const partnerPairs = [...state.partnerPairs];
  const opponentPairs = [...state.opponentPairs];
  for (const court of plan.courts) {
    const [teamA, teamB] = court as [number[], number[]];
    if (state.mode === 'doubles') {
      partnerPairs.push(pairKey(teamA[0] as number, teamA[1] as number));
      partnerPairs.push(pairKey(teamB[0] as number, teamB[1] as number));
    }
    for (const x of teamA) for (const y of teamB) opponentPairs.push(pairKey(x, y));
  }

  const sitSet = new Set(plan.sitOut);
  const sitOutCounts = state.sitOutCounts.map((c, i) => (sitSet.has(i) ? c + 1 : c));
  const consecutivePlayed = state.consecutivePlayed.map((c, i) => (sitSet.has(i) ? 0 : c + 1));

  const nextState: GroupingState = {
    ...state,
    round: roundNo,
    partnerPairs,
    opponentPairs,
    sitOutCounts,
    consecutivePlayed,
  };
  return { round: { round: roundNo, courts, sitOut: plan.sitOut.map(label) }, state: nextState };
}

export interface StartOptions {
  courts?: number; // 未帶 → defaultCourts
  rounds?: number | null; // 未帶/null → 不設上限
  mode: GroupMode;
}

/** 啟動策略B session 並產第 1 輪（§1）。N < courtSize → insufficient。 */
export function startSession(
  labels: readonly string[],
  opts: StartOptions,
  rng: RandomFn,
): StartResult {
  const n = labels.length;
  const courtSize = courtSizeOf(opts.mode);
  const requested = opts.courts ?? defaultCourts(n, opts.mode);
  const effectiveCourts = Math.min(requested, Math.floor(n / courtSize));
  if (effectiveCourts < 1) return { kind: 'insufficient' };

  const state: GroupingState = {
    mode: opts.mode,
    courts: effectiveCourts,
    courtSize,
    roundsLimit: opts.rounds ?? null,
    labels: [...labels],
    round: 0,
    partnerPairs: [],
    opponentPairs: [],
    sitOutCounts: Array.from({ length: n }, () => 0),
    consecutivePlayed: Array.from({ length: n }, () => 0),
  };
  const plan = scheduleOneRound(state, rng);
  const applied = applyRound(state, plan);
  return { kind: 'round', round: applied.round, state: applied.state };
}

/** 產下一輪（避開全歷史、延續累計）；達 roundsLimit → exhausted（§1/§3、AC-21/AC-22）。 */
export function nextRound(state: GroupingState, rng: RandomFn): NextResult {
  if (state.roundsLimit !== null && state.round >= state.roundsLimit) {
    return { kind: 'exhausted' };
  }
  const plan = scheduleOneRound(state, rng);
  const applied = applyRound(state, plan);
  return { kind: 'round', round: applied.round, state: applied.state };
}
