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
//   B1 `下一輪` 跨群——必須比對 `conv.group_id` 才回該輪，否則主辦在別群輸入 `下一輪`
//      會外洩他群凍結名單的人名。（D-013 T-022：session 鍵已改為 `(group_id, line_user_id)`，
//      跨群不可讀由結構保證；該比對依 G3 保留為縱深防禦與回歸錨點。）
//   B2 策略A 未去重——`partitionBalanced` 吃 rng，webhook 重送會重算出不同分組並二次回覆；
//      改沿用唯讀指令 `名單` 的去重政策（交易外 markProcessed → `duplicate`）。

import type { EventReader } from '../db/repositories/event-repository';
import type { RegistrationReader } from '../db/repositories/registration-repository';
import type { ConversationReader } from '../db/repositories/conversation-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ProcessedEventRepository } from '../db/repositories/processed-event-repository';
import type { TransactionRunner } from '../db/tx';
import {
  ACTIVE_EVENT_STATUSES,
  GROUPING_STATE,
  type ConversationStateRow,
  type EventRow,
} from '../db/schema';
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
 *
 * D-030：本體已下放至 `db/schema`（repository 層也要用、而 db 不得 import domain），
 * 此處保留 re-export 讓既有匯入點（`event-service`、本檔）不必改動。
 */
export { GROUPING_STATE };

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
  /**
   * D-021 §5.1：由 handler 層消歧義解出的目標活動（`undefined` = 候選數為 0，沿用既有
   * `no_open_event` 分支）。跨群校驗已於 dispatch 層完成（G14），此處不重複比對 `group_id`。
   */
  eventId?: number;
}
export interface StartRoundsInput extends BalancedInput {
  courts?: number;
  rounds?: number;
  mode: GroupMode;
}
/**
 * `下一輪`。**刻意不進 `NEEDS_EVENT_SET`、不跑消歧義（G11 不變）**：不吃 `@selector`、無
 * ambiguous 分支。D-030 起**只多消費一樣東西**——dispatch 層已解出的 quote 目標活動。
 */
export interface NextRoundInput {
  /** 來源群。D-013：session 鍵為 `(group_id, line_user_id)`，本欄即**查詢鍵**（原僅供 B1 守衛比對）。 */
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  /**
   * D-030 §2：引用訊息解出的活動 id。
   *
   * **G1**：必須是 dispatch 層 `resolveQuotedEventInGroup` 的產物（D-025 G14 跨群防線已在那裡
   * 走過）；本層**不得**自行讀 `message_event_map`、**不得**接收原始 `quotedMessageId`。
   * `undefined`（未引用／引用解不出／跨群被擋）⇒ 沿用 §3 既有路徑：撈發話者自己的 session。
   */
  quotedEventId?: number;
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
  /**
   * D-030 §1：以 quote 指定 session 時，發話者既非該場 host、該場也查無其未取消報名列。
   * 零寫入早退（`markProcessed` 之前 return、全程唯讀）⇒ CLAUDE.md §4 去重政策例外 (b)，
   * 依該條「新增此類分支須在該設計文件明列」已列於 D-030「將改動的既有文件」。
   */
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'exhausted' }
  /**
   * D-029 §5.3：`eventId` 取自 session（`GroupingState.eventId`），供 handler 附
   * `relatedEventId`。`下一輪` **不**因此參與消歧義（G11）——它只是把「這輪屬於哪一場」
   * 如實回報給接線層。
   *
   * **選填**：T-033b 上線前建立、尚未結束的 grouping session，其 payload 沒有 `eventId`
   * 欄位（見 `nextRound` 的相容處理）。這類 session 的 `下一輪` 回覆不登記映射即可
   * （最多是那幾則舊訊息不能被 quote），**不得**因此改判 `no_session` 而把使用者的
   * 分組流程打斷。
   */
  | { kind: 'round'; round: Round; mode: GroupMode; eventId?: number };

/**
 * 目標活動是否仍在 active 集（{draft, open}）。
 *
 * **T-033b 起必要**（architect-reviewer B-1，D-025 errata E1）：在此之前 `eventId` 必來自
 * `listActiveByGroup` ⇒ 由構造保證 active，本層因而從未判過 status。quote 上線後，解出的 id
 * 刻意不過濾「是否仍在候選集合內」（`event-disambiguation.ts` §4.3 把狀態判斷交給各指令自己），
 * 分組若不判就會變成「引用一則舊訊息即可對已關閉／已取消的活動分組」——那是本批意外開出的
 * 新功能，不是既有行為。本守門即**維持 T-033b 前的語意不變**（`關閉報名` 後不能再分組）。
 */
function isActiveEvent(event: EventRow | undefined): event is EventRow {
  return event !== undefined && ACTIVE_EVENT_STATUSES.includes(event.status);
}

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

  /**
   * D-030 §1 授權（**僅 `下一輪` 的 quote 路徑**）：該場 host 本人 **∪** 該場有未取消報名列的人
   * （含 waitlist、含其代報名列）。唯讀、不寫任何列。
   *
   * **G3**：`groupBalanced`／`startRounds` 仍走 {@link isHost}，本方法不得被它們引用；
   * super-admin 亦**不**在此集合內（service 自始不知 admin 概念，沿用 errata 2026-08-17）。
   */
  private async isHostOrRegistered(event: EventRow, executorLineUserId: string): Promise<boolean> {
    const executor = await this.users.getByLineUserId(executorLineUserId);
    if (executor === undefined) return false;
    if (executor.id === event.host_user_id) return true;
    return (await this.registrations.findActiveByOwner(event.id, executor.id)).length > 0;
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
    // D-021 §5.1：改讀消歧義解出的 `eventId`；undefined = 候選數 0 → 既有 no_open_event。
    const active =
      input.eventId === undefined ? undefined : await this.events.getById(input.eventId);
    if (!isActiveEvent(active)) return { kind: 'no_open_event' };
    if (!(await this.isHost(active, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }
    const labels = await this.loadLabels(active.id);
    return { kind: 'balanced', result: partitionBalanced(labels, this.rng) };
  }

  /** 策略B：啟動 session、產第 1 輪、寫入 conversation_states（state='grouping'）。 */
  async startRounds(input: StartRoundsInput): Promise<StartRoundsResult> {
    // D-021 §5.1：同 groupBalanced。
    const active =
      input.eventId === undefined ? undefined : await this.events.getById(input.eventId);
    if (!isActiveEvent(active)) return { kind: 'no_open_event' };
    if (!(await this.isHost(active, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }
    const labels = await this.loadLabels(active.id);
    const started = startSession(
      labels,
      // D-029 §5.5：session 綁定消歧義解出的那一場（`active.id`＝鎖前唯讀重讀的權威 id）。
      { courts: input.courts, rounds: input.rounds ?? null, mode: input.mode, eventId: active.id },
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
   * **host-only 只保證「同一人」，不保證「同一群」**（B1 修正，2026-08-18）：只有啟動分組的
   * 主辦人自己的訊息能讀到其 `grouping` session（非主辦——含 super-admin——查無 session → no_session）；
   * 同一主辦在**別群**輸入 `下一輪` 不得讀到他群的凍結名單，一律 `no_session`
   * （不推進輪次、不寫回、不 mark）。
   *
   * **D-013**：session 鍵已含 group_id ⇒ 別群查詢**結構上**撈不到他群 session；
   * 下方 `conv.group_id !== input.groupId` 因而恆為 false，仍依 G3 保留為縱深防禦與回歸錨點。
   *
   * **D-030（2026-10-18，授權放寬）**：以上「host-only」敘述自本版起**僅適用於無 quote 的路徑**。
   * 帶 `quotedEventId` 時改以 `(group_id, eventId)` 指定 session，可執行者為
   * 「該場 host ∪ 該場有未取消報名列的人」（{@link isHostOrRegistered}），非此集合 → `not_authorized`。
   * B1 的跨群防線不因此鬆動：`quotedEventId` 已由 dispatch 層比對過 `group_id`（G1/G14），
   * 且 `getGroupingByEvent` 本身帶 `group_id`，跨群仍撈不到他群 session。
   */
  async nextRound(input: NextRoundInput): Promise<NextRoundResult> {
    let conv: ConversationStateRow | undefined;
    if (input.quotedEventId === undefined) {
      // §3 無 quote：維持現狀（撈自己的 session），host 既有體驗零回歸。
      conv = await this.conversations.get(input.groupId, input.executorLineUserId);
    } else {
      // §2 有 quote：session 以 `(group_id, eventId)` 指定，與發話者是誰無關。
      const event = await this.events.getById(input.quotedEventId);
      if (event === undefined) return { kind: 'no_session' };
      // 授權**先於** session 查詢：未授權者連「該場有沒有進行中的分組」都不該被告知（G5）。
      // 這也使 AC-3 的 `not_authorized` 不因 session 存在與否而變。
      if (!(await this.isHostOrRegistered(event, input.executorLineUserId))) {
        return { kind: 'not_authorized' }; // 零寫入早退（§4 例外 (b)）：尚未 markProcessed
      }
      conv = await this.conversations.getGroupingByEvent(input.groupId, input.quotedEventId);
    }
    if (conv === undefined || conv.state !== GROUPING_STATE || conv.payload === null) {
      return { kind: 'no_session' };
    }
    if (conv.group_id !== input.groupId) return { kind: 'no_session' }; // B1：跨群不得讀他群 session
    // 舊 payload 相容（T-033b）：跨版本存活的 session 沒有 `eventId`，故 `as GroupingState`
    // 對該欄位是張空頭支票——只在確實是數字時才往下傳（見 NextRoundResult 的說明）。
    const state = JSON.parse(conv.payload) as GroupingState;
    const advanced = nextRoundPure(state, this.rng);
    if (advanced.kind === 'exhausted') return { kind: 'exhausted' };

    return this.tx<NextRoundResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      // **B1（architect-reviewer 2026-10-18，D-030 errata E2）：交易內重讀該列再確認。**
      // `conversation_states` 的 `(group_id, line_user_id)` 是**開團問答 draft 與分組 session
      // 共用**的同一列（`event-service.ts` 的 upsert/delete 用同鍵），而本 runner 只是
      // `BEGIN…COMMIT`、**不鎖列**。D-030 之前 `下一輪` 只寫發話者自己的列，窗口僅 host 自己
      // 可造成；放寬授權後，任一有報名者都能寫 host 的列——若窗口內 host 開始 `開團`，此處的
      // upsert 會把 draft 靜默覆寫為 grouping；若 host 剛 `確認`／`放棄`（delete），則會把
      // 已結束的 session 復活。兩者皆**毀掉他人進行中的流程**，與使用者裁決忽略的
      // 「連跳一輪」不同級。此處重讀並比對，不一致即早退（不需 `FOR UPDATE`、不宣稱任何鎖）。
      const fresh = await repos.conversations.get(conv.group_id, conv.line_user_id);
      if (fresh === undefined || fresh.state !== GROUPING_STATE || fresh.payload !== conv.payload) {
        return { kind: 'no_session' };
      }
      await repos.conversations.upsert({
        // **G2（session 不得易主）**：寫回撈到那一列的 `line_user_id`（＝開團者），
        // **不得**用 `input.executorLineUserId`——否則有報名者喊一次 `下一輪`
        // 就把 session 複製／搬到自己名下，host 的 `下一輪` 從此失效。
        lineUserId: conv.line_user_id,
        groupId: conv.group_id,
        state: GROUPING_STATE,
        payload: JSON.stringify(advanced.state),
      });
      const eventId: unknown = advanced.state.eventId;
      return {
        kind: 'round',
        round: advanced.round,
        mode: advanced.state.mode,
        ...(typeof eventId === 'number' ? { eventId } : {}),
      };
    });
  }
}
