// src/domain/grouping-service.ts
//
// D-011：分組 orchestration（handler → service → repository，遵「不在 handler 寫商業邏輯」）。
// 唯讀名單（listConfirmed + buildRoster）+ 純函式分組（grouping.ts）；策略B session 僅暫存於
// 既有 conversation_states（經注入 runInTransaction 的 client-bound conversations repo）——
// 不寫 events/registrations/users（G1/G5）。
// 授權（errata 2026-08-17，取代裁決 #4 canManageEvent）：**僅該 event 的 host_user_id**、排除 super-admin。
//
// 嚴禁 any。rng 可注入（預設 Math.random），供測試以固定 seed 重現。
//
// errata 2026-08-18（T-018 review B1/B2）：
//   B1 `下一輪` 跨群——session PK 為 line_user_id（跨群唯一），必須比對 `conv.group_id` 才回該輪，
//      否則主辦在別群輸入 `下一輪` 會外洩他群凍結名單的人名。
//   B2 策略A 未去重——`partitionBalanced` 吃 rng，webhook 重送會重算出不同分組並二次回覆；
//      改沿用唯讀指令 `名單` 的去重政策（交易外 markProcessed → `duplicate`）。

import type { EventReader } from '../db/repositories/event-repository';
import type { RegistrationReader } from '../db/repositories/registration-repository';
import type { ConversationReader } from '../db/repositories/conversation-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ProcessedEventRepository } from '../db/repositories/processed-event-repository';
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

/**
 * 分組 session 的 conversation_states.state 標記（與開團問答共用同一列，互斥）。
 * **單一來源**：event-service 需辨識「被覆寫的前一段流程是分組」時亦 import 此常數，
 * 勿在其他檔案重寫字面值（design-reviewer nit，2026-08-18）。
 */
export const GROUPING_STATE = 'grouping';

export interface GroupingServiceDeps {
  events: EventReader;
  users: UserRepository;
  registrations: RegistrationReader;
  conversations: ConversationReader;
  /** 唯讀去重（策略A）：沿用 D-003 §5「名單」政策，交易外 markProcessed（無資料副作用）。 */
  processed: ProcessedEventRepository;
  runInTransaction: TransactionRunner;
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
  /** 來源群（B1 修正）：session 以 line_user_id 為 PK（跨群唯一），必須比對 `conv.group_id`。 */
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export type BalancedResult =
  | { kind: 'no_open_event' }
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
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
  private readonly processed: ProcessedEventRepository;
  private readonly tx: TransactionRunner;
  private readonly rng: RandomFn;

  constructor(deps: GroupingServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.registrations = deps.registrations;
    this.conversations = deps.conversations;
    this.processed = deps.processed;
    this.tx = deps.runInTransaction;
    this.rng = deps.rng ?? Math.random;
  }

  /**
   * 授權（errata 2026-08-17，取代裁決 #4 canManageEvent）：**僅該 event 的 host_user_id**。
   * 唯讀（不寫任何列）；**排除 super-admin**——分組/下一輪僅開放主辦人本人。
   */
  private async isHost(event: EventRow, executorLineUserId: string): Promise<boolean> {
    const executor = await this.users.getByLineUserId(executorLineUserId);
    return executor !== undefined && executor.id === event.host_user_id;
  }

  /** 取當前 active event 的正取 labels（confirmed、含 proxy、排除 waitlist/cancelled，G3）。 */
  private async loadLabels(eventId: number): Promise<string[]> {
    const rows = await this.registrations.listConfirmed(eventId);
    return buildRoster(rows).map((e) => e.label);
  }

  /**
   * 策略A（均分）：唯讀、一次分完、不寫 session。
   *
   * B2 修正（去重）：`partitionBalanced` 吃 rng，重送同一 webhook 會重算出**不同分組**並二次回覆。
   * 沿用唯讀指令 `名單` 的既有去重政策（D-003 §5 / `getListView`）：**交易外** markProcessed 作首步，
   * 重送 → `duplicate`（handler 回 `[]`，不回覆）。不新增第四種去重變體。
   */
  async groupBalanced(input: BalancedInput): Promise<BalancedResult> {
    if (!(await this.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
    const active = await this.events.findActiveByGroup(input.groupId);
    if (active === undefined) return { kind: 'no_open_event' };
    if (!(await this.isHost(active, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }
    const labels = await this.loadLabels(active.id);
    return { kind: 'balanced', result: partitionBalanced(labels, this.rng) };
  }

  /** 策略B：啟動 session、產第 1 輪、寫入 conversation_states（state='grouping'）。 */
  async startRounds(input: StartRoundsInput): Promise<StartRoundsResult> {
    const active = await this.events.findActiveByGroup(input.groupId);
    if (active === undefined) return { kind: 'no_open_event' };
    if (!(await this.isHost(active, input.executorLineUserId))) {
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

  /**
   * `下一輪`：讀 grouping session → 產下一輪 → 寫回；無 session/達上限有對應結果。
   *
   * **host-only 只保證「同一人」，不保證「同一群」**（B1 修正，2026-08-18）：session 以
   * line_user_id 為主鍵（跨群唯一），只有啟動分組的主辦人自己的訊息能讀到其 `grouping` session
   * （非主辦——含 super-admin——查無 session → no_session）；但同一主辦在**別群**輸入 `下一輪`
   * 會讀到他群的凍結名單並外洩人名，故此處**必須**再比對 `conv.group_id === input.groupId`，
   * 不同群一律 `no_session`（不推進輪次、不寫回、不 mark）。
   */
  async nextRound(input: NextRoundInput): Promise<NextRoundResult> {
    const conv = await this.conversations.get(input.executorLineUserId);
    if (conv === undefined || conv.state !== GROUPING_STATE || conv.payload === null) {
      return { kind: 'no_session' };
    }
    if (conv.group_id !== input.groupId) return { kind: 'no_session' }; // B1：跨群不得讀他群 session
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
