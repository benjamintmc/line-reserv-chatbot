// src/domain/grouping-service.ts
//
// D-011：分組 orchestration（handler → service → repository，遵「不在 handler 寫商業邏輯」）。
// 唯讀名單（listConfirmed + buildRoster）+ 純函式分組（grouping.ts）；策略B session 僅暫存於
// 既有 conversation_states（經注入 runInTransaction 的 client-bound conversations repo）——
// 不寫 events/registrations/users（G1/G5）。授權沿用 canManageEvent（host ∪ super-admin，裁決 #4）。
//
// 嚴禁 any。rng 可注入（預設 Math.random），供測試以固定 seed 重現。

import type { EventReader } from '../db/repositories/event-repository';
import type { RegistrationReader } from '../db/repositories/registration-repository';
import type { ConversationReader } from '../db/repositories/conversation-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { TransactionRunner } from '../db/tx';
import type { EventRow } from '../db/schema';
import { buildRoster } from './roster';
import {
  partitionBalanced,
  startSession,
  nextRound as nextRoundPure,
  type GroupMode,
  type GroupingState,
  type PartitionResult,
  type RandomFn,
  type Round,
} from './grouping';

const GROUPING_STATE = 'grouping';

export interface GroupingServiceDeps {
  events: EventReader;
  users: UserRepository;
  registrations: RegistrationReader;
  conversations: ConversationReader;
  runInTransaction: TransactionRunner;
  superAdminUserIds: ReadonlyArray<string>;
  rng?: RandomFn;
}

export interface BalancedInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}
export interface StartRoundsInput extends BalancedInput {
  courts?: number;
  rounds?: number;
  mode: GroupMode;
}
export interface NextRoundInput {
  executorLineUserId: string;
  messageId: string;
}

export type BalancedResult =
  | { kind: 'no_open_event' }
  | { kind: 'not_authorized' }
  | { kind: 'balanced'; result: PartitionResult };

export type StartRoundsResult =
  | { kind: 'no_open_event' }
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'insufficient' }
  | { kind: 'round'; round: Round; mode: GroupMode };

export type NextRoundResult =
  | { kind: 'no_session' }
  | { kind: 'duplicate' }
  | { kind: 'exhausted' }
  | { kind: 'round'; round: Round; mode: GroupMode };

export class GroupingService {
  private readonly events: EventReader;
  private readonly users: UserRepository;
  private readonly registrations: RegistrationReader;
  private readonly conversations: ConversationReader;
  private readonly tx: TransactionRunner;
  private readonly superAdmins: ReadonlySet<string>;
  private readonly rng: RandomFn;

  constructor(deps: GroupingServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.registrations = deps.registrations;
    this.conversations = deps.conversations;
    this.tx = deps.runInTransaction;
    this.superAdmins = new Set(deps.superAdminUserIds);
    this.rng = deps.rng ?? Math.random;
  }

  /** 授權：super-admin ∪ 活動建立者（唯讀，不寫任何列；同 D-006 canManageEvent）。 */
  private async canManageEvent(event: EventRow, executorLineUserId: string): Promise<boolean> {
    if (this.superAdmins.has(executorLineUserId)) return true;
    const executor = await this.users.getByLineUserId(executorLineUserId);
    return executor !== undefined && executor.id === event.host_user_id;
  }

  /** 取當前 active event 的正取 labels（confirmed、含 proxy、排除 waitlist/cancelled，G3）。 */
  private async loadLabels(eventId: number): Promise<string[]> {
    const rows = await this.registrations.listConfirmed(eventId);
    return buildRoster(rows).map((e) => e.label);
  }

  /** 策略A（均分）：唯讀、一次分完、不寫 session。 */
  async groupBalanced(input: BalancedInput): Promise<BalancedResult> {
    const active = await this.events.findActiveByGroup(input.groupId);
    if (active === undefined) return { kind: 'no_open_event' };
    if (!(await this.canManageEvent(active, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }
    const labels = await this.loadLabels(active.id);
    return { kind: 'balanced', result: partitionBalanced(labels, this.rng) };
  }

  /** 策略B：啟動 session、產第 1 輪、寫入 conversation_states（state='grouping'）。 */
  async startRounds(input: StartRoundsInput): Promise<StartRoundsResult> {
    const active = await this.events.findActiveByGroup(input.groupId);
    if (active === undefined) return { kind: 'no_open_event' };
    if (!(await this.canManageEvent(active, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }
    const labels = await this.loadLabels(active.id);
    const started = startSession(
      labels,
      { courts: input.courts, rounds: input.rounds ?? null, mode: input.mode },
      this.rng,
    );
    if (started.kind === 'insufficient') return { kind: 'insufficient' };

    return this.tx<StartRoundsResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: GROUPING_STATE,
        payload: JSON.stringify(started.state),
      });
      return { kind: 'round', round: started.round, mode: started.state.mode };
    });
  }

  /** `下一輪`：讀 grouping session → 產下一輪 → 寫回；無 session/達上限有對應結果。 */
  async nextRound(input: NextRoundInput): Promise<NextRoundResult> {
    const conv = await this.conversations.get(input.executorLineUserId);
    if (conv === undefined || conv.state !== GROUPING_STATE || conv.payload === null) {
      return { kind: 'no_session' };
    }
    const state = JSON.parse(conv.payload) as GroupingState;
    const advanced = nextRoundPure(state, this.rng);
    if (advanced.kind === 'exhausted') return { kind: 'exhausted' };

    return this.tx<NextRoundResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: conv.group_id,
        state: GROUPING_STATE,
        payload: JSON.stringify(advanced.state),
      });
      return { kind: 'round', round: advanced.round, mode: advanced.state.mode };
    });
  }
}
