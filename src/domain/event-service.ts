// src/domain/event-service.ts
//
// D-004 §1–§6 / D-005 §3–§4：開團 domain。組合 D-001 repository 原語 + create-flow 純邏輯，
// 完成 host 授權（注入白名單，G1）、狀態轉移合法性（G2）、同群一場 active（G3）、
// 交易 + 去重（G4）、host_user_id=建立者（G8）、取消活動不刪 registrations（G10）。
//
// D-005：`確認` 建立 open event 後於同交易插入主辦第 1 正取（§3、G3 走既有 insertSlot）；
// `關閉報名`(split) 於同交易計算 ceil 最終攤額並持久化 settled_per_person（§4、OP-3、G1）。
//
// 本層**回傳結構化 domain 結果物件（非 LINE 訊息）**，對 LINE SDK 零耦合、可純測（G5）。
// 嚴禁 any（G6）；不得出現 SQL 字串或直接存取 db（G5）——一律經 repository / tx runner。
// 授權只認注入的 hostUserIds、不讀 process.env（G1）。

import { parseCommand } from '../commands';
import type { EventRow, PriceMode } from '../db/schema';
import type { EventRepository } from '../db/repositories/event-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { RegistrationRepository } from '../db/repositories/registration-repository';
import type { ConversationRepository } from '../db/repositories/conversation-repository';
import type { ProcessedEventRepository } from '../db/repositories/processed-event-repository';
import type { TransactionRunner } from '../db/tx';
import { perPersonAmount } from './billing';
import {
  applyAnswer,
  FIRST_STATE,
  isComplete,
  parseDraft,
  serializeDraft,
  type CreateEventDraft,
  type CreateState,
} from './create-flow';

// ── 結果物件型別（D-004 §7.1；嚴禁 any） ─────────────────────────────────

/** `開團`（一行式 / 逐步）入口結果。 */
export type CreateEntryResult =
  | { kind: 'not_authorized' }
  | { kind: 'already_active'; event: EventRow }
  | { kind: 'duplicate' }
  | { kind: 'flow_started'; state: CreateState }
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft };

/** 一行式格式畸形（invalid create_event）結果。 */
export type InvalidOnelineResult = { kind: 'not_authorized' } | { kind: 'format_help' };

/** 進行中流程收到一則訊息的結果（confirm/abort/答案/重問）。 */
export type ContinueFlowResult =
  | { kind: 'noop' }
  | { kind: 'field_error'; state: CreateState }
  | { kind: 'advanced'; state: CreateState }
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft }
  | { kind: 'confirm_reprompt' }
  | { kind: 'aborted' }
  | { kind: 'created'; event: EventRow }
  | { kind: 'already_active' }
  | { kind: 'duplicate' };

/** `確認`（無流程時 noop）結果。 */
export type ConfirmResult =
  | { kind: 'noop' }
  | { kind: 'duplicate' }
  | { kind: 'already_active' }
  | { kind: 'created'; event: EventRow };

/** `取消`（abort）結果。 */
export type AbortResult = { kind: 'noop' } | { kind: 'duplicate' } | { kind: 'aborted' };

/**
 * `關閉報名`（close_event）結果。
 * D-005 §4：ok 帶 confirmedCount（凍結正取數）與 settledPerPerson（split 最終攤額；per_person 為 null）。
 */
export type CloseResult =
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'no_active' }
  | { kind: 'already_closed' }
  | { kind: 'ok'; event: EventRow; confirmedCount: number; settledPerPerson: number | null };

/** `取消活動`（cancel_event）結果。 */
export type CancelResult =
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'no_active' }
  | { kind: 'ok'; event: EventRow };

// ── 輸入型別 ─────────────────────────────────────────────────────────

export interface StartCreationInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export interface OnelineInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  date: string;
  time: string;
  location: string;
  capacity: number;
  /** per_person 每人金額；split_venue 時為 0（D-005 §6.1）。 */
  price: number;
  /** 計費模式（D-005 §6.1）。 */
  priceMode: PriceMode;
  /** 場地費總額（僅 split_venue 帶值，>0）。 */
  venueFee?: number;
}

export interface InvalidOnelineInput {
  executorLineUserId: string;
}

export interface ContinueFlowInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  text: string;
  /** confirm 建立時 host_user_id 快照名（handler 以 getGroupMemberProfile 取得，§4 note）。 */
  hostDisplayName: string;
}

export interface ConfirmInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  hostDisplayName: string;
}

export interface AbortInput {
  executorLineUserId: string;
  messageId: string;
}

export interface LifecycleInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export interface EventServiceDeps {
  events: EventRepository;
  users: UserRepository;
  /** D-005 §3：主辦自動登記走既有 insertSlot（不繞過，G3）；§4 關閉重查正取數。 */
  registrations: RegistrationRepository;
  conversations: ConversationRepository;
  processed: ProcessedEventRepository;
  runInTransaction: TransactionRunner;
  /** host 授權白名單（來源 env ADMIN_USER_IDS，由 server.ts 注入；domain 不讀 env，G1）。 */
  hostUserIds: ReadonlyArray<string>;
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * 窄捕捉：判斷 err 是否為「命中 ux_events_active_group（同群一場 active）」的
 * SQLITE_CONSTRAINT_UNIQUE（architect 裁定 1）。結構化型別守衛，不 import better-sqlite3、
 * 不使用 any（G5/G6）。其餘任何錯誤（含其他 UNIQUE index）皆不匹配 → 由呼叫端 re-throw。
 *
 * 註：better-sqlite3 對此 partial unique index 撞約束時，訊息形如
 * `UNIQUE constraint failed: events.group_id`（回報**欄位**而非 index 名）。
 * 因 `ux_events_active_group` 是 events.group_id 上**唯一**的 unique index，
 * 故以 `events.group_id` 欄位簽章即可**唯一**指涉該 index；同時相容潛在的 index 名訊息。
 */
function isActiveGroupUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE' || typeof e.message !== 'string') return false;
  return e.message.includes('events.group_id') || e.message.includes('ux_events_active_group');
}

export class EventService {
  private readonly events: EventRepository;
  private readonly users: UserRepository;
  private readonly registrations: RegistrationRepository;
  private readonly conversations: ConversationRepository;
  private readonly processed: ProcessedEventRepository;
  private readonly tx: TransactionRunner;
  private readonly hostUserIds: ReadonlySet<string>;
  private readonly logError: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(deps: EventServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.registrations = deps.registrations;
    this.conversations = deps.conversations;
    this.processed = deps.processed;
    this.tx = deps.runInTransaction;
    this.hostUserIds = new Set(deps.hostUserIds);
    this.logError =
      deps.logError ??
      ((msg, meta): void => {
        console.error(msg, meta ?? {});
      });
  }

  /** 授權：只認注入白名單（G1）。 */
  private isAuthorized(lineUserId: string): boolean {
    return this.hostUserIds.has(lineUserId);
  }

  // ── `開團`（逐步問答入口，§3） ──────────────────────────────────────
  startCreation(input: StartCreationInput): CreateEntryResult {
    if (!this.isAuthorized(input.executorLineUserId)) return { kind: 'not_authorized' };

    // 入口先查（§6 fail fast）：已有 active（draft/open/closed）→ 拒絕、不寫 conversation。
    const active = this.events.findActiveByGroup(input.groupId);
    if (active !== undefined) return { kind: 'already_active', event: active };

    return this.tx<CreateEntryResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };
      this.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: FIRST_STATE,
        payload: serializeDraft({}),
      });
      return { kind: 'flow_started', state: FIRST_STATE };
    });
  }

  // ── `開團 <欄位…>`（一行式入口，§2 / D-005 §6.1） ──────────────────
  handleOneline(input: OnelineInput): CreateEntryResult {
    if (!this.isAuthorized(input.executorLineUserId)) return { kind: 'not_authorized' };

    const active = this.events.findActiveByGroup(input.groupId);
    if (active !== undefined) return { kind: 'already_active', event: active };

    const draft: CreateEventDraft = {
      date: input.date,
      time: input.time,
      location: input.location,
      capacity: input.capacity,
      price: input.price,
      priceMode: input.priceMode,
      ...(input.venueFee !== undefined ? { venueFee: input.venueFee } : {}),
    };

    return this.tx<CreateEntryResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };
      this.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: 'awaiting_confirm',
        payload: serializeDraft(draft),
      });
      return { kind: 'awaiting_confirm', draft };
    });
  }

  // ── invalid（create_event 格式畸形；§9 (K)/(H)） ───────────────────
  handleInvalidOneline(input: InvalidOnelineInput): InvalidOnelineResult {
    // 純拒絕/引導，無 DB 副作用、不 mark（§9 註）。
    if (!this.isAuthorized(input.executorLineUserId)) return { kind: 'not_authorized' };
    return { kind: 'format_help' };
  }

  // ── 進行中流程的一則訊息（§3.3/§3.4） ─────────────────────────────
  continueFlow(input: ContinueFlowInput): ContinueFlowResult {
    const conv = this.conversations.get(input.executorLineUserId);
    if (conv === undefined) return { kind: 'noop' }; // 安全網（handler 已先攔截存在者）

    const cmd = parseCommand(input.text);

    // `取消`（abort）：任一 state 皆放棄流程（§3.4）。
    if (cmd.type === 'abort') {
      const r = this.abort({
        executorLineUserId: input.executorLineUserId,
        messageId: input.messageId,
      });
      if (r.kind === 'aborted') return { kind: 'aborted' };
      if (r.kind === 'duplicate') return { kind: 'duplicate' };
      return { kind: 'noop' };
    }

    const state = conv.state as CreateState;

    if (state === 'awaiting_confirm') {
      // `確認` → 建立；其餘非 確認/取消 → 重新提示 (M)，停留、不建立（B2/§3.3）。
      if (cmd.type === 'confirm') {
        const r = this.confirm({
          groupId: input.groupId,
          executorLineUserId: input.executorLineUserId,
          messageId: input.messageId,
          hostDisplayName: input.hostDisplayName,
        });
        if (r.kind === 'created') return { kind: 'created', event: r.event };
        if (r.kind === 'already_active') return { kind: 'already_active' };
        if (r.kind === 'duplicate') return { kind: 'duplicate' };
        return { kind: 'noop' };
      }
      return { kind: 'confirm_reprompt' };
    }

    // 其餘 state：整串 text 當該欄答案（含使用者恰好輸入 `確認` → 多半格式錯重問）。
    const draft = parseDraft(conv.payload);
    const applied = applyAnswer(state, draft, input.text);
    if (!applied.ok) {
      // 欄位錯：停留同一 state、不前進、不 INSERT、不 mark（§3.2）。
      return { kind: 'field_error', state: applied.state };
    }

    // 前進一步（有 DB 副作用 → 交易內 markProcessed 首步，去重 AC-14）。
    return this.tx<ContinueFlowResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };
      this.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: applied.nextState,
        payload: serializeDraft(applied.payload),
      });
      if (applied.nextState === 'awaiting_confirm') {
        return { kind: 'awaiting_confirm', draft: applied.payload };
      }
      return { kind: 'advanced', state: applied.nextState };
    });
  }

  // ── `確認` 建立 open event + 主辦自動登記（§4 / D-005 §3） ───────────
  confirm(input: ConfirmInput): ConfirmResult {
    const conv = this.conversations.get(input.executorLineUserId);
    if (conv === undefined || conv.state !== 'awaiting_confirm') return { kind: 'noop' };
    const draft = parseDraft(conv.payload);
    if (!isComplete(draft)) return { kind: 'noop' }; // 欄位不齊不建立（AC-20）

    return this.tx<ConfirmResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };

      // G3 入口再確認（早退；真正安全網為 INSERT 撞 ux_events_active_group）。
      const active = this.events.findActiveByGroup(input.groupId);
      if (active !== undefined) {
        this.conversations.delete(input.executorLineUserId);
        return { kind: 'already_active' };
      }

      // G8：host_user_id = 建立者（白名單使用者）的 user.id。
      const host = this.users.upsert(input.executorLineUserId, input.hostDisplayName);

      let event: EventRow;
      try {
        event = this.events.create({
          groupId: input.groupId,
          hostUserId: host.id,
          eventDate: draft.date,
          eventTime: draft.time,
          location: draft.location,
          capacity: draft.capacity,
          pricePerPerson: draft.price,
          priceMode: draft.priceMode,
          venueFee: draft.venueFee,
          status: 'open',
        });
      } catch (err) {
        // G3 窄捕捉：僅命中 ux_events_active_group 的 UNIQUE → already_active；其餘一律 re-throw。
        if (!isActiveGroupUniqueViolation(err)) throw err;
        this.conversations.delete(input.executorLineUserId); // 清落敗者流程，不卡 awaiting_confirm（nit-2）
        return { kind: 'already_active' };
      }

      // D-005 §3：主辦自動登記為第 1 正取（名單第 1 位；均攤分母天然 >=1）。
      // 走既有 per-slot 交易原語 insertSlot（G3，不繞過；assertInTransaction 於本 DEFERRED
      // 交易內 markProcessed 首寫已取 RESERVED 鎖，db.inTransaction===true 守門通過）。
      // 空 event → seq=COALESCE(MAX(seq),0)+1=1；kind='self'、status='confirmed'、cancelled_at=NULL。
      this.registrations.insertSlot({
        eventId: event.id,
        ownerUserId: host.id,
        displayName: input.hostDisplayName,
        kind: 'self',
        status: 'confirmed',
      });

      this.conversations.delete(input.executorLineUserId);
      return { kind: 'created', event };
    });
  }

  // ── `取消`（abort，§3.4） ─────────────────────────────────────────
  abort(input: AbortInput): AbortResult {
    const conv = this.conversations.get(input.executorLineUserId);
    if (conv === undefined) return { kind: 'noop' }; // 無流程 → 靜默 no-op（G9）

    return this.tx<AbortResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };
      this.conversations.delete(input.executorLineUserId);
      return { kind: 'aborted' };
    });
  }

  // ── `關閉報名`（close_event，§5.2 / D-005 §4） ─────────────────────
  closeEvent(input: LifecycleInput): CloseResult {
    if (!this.isAuthorized(input.executorLineUserId)) return { kind: 'not_authorized' };

    return this.tx<CloseResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };
      const active = this.events.findActiveByGroup(input.groupId);
      if (active === undefined) return { kind: 'no_active' };
      if (active.status === 'closed') return { kind: 'already_closed' };
      if (active.status !== 'open') return { kind: 'no_active' }; // draft 未物化，其餘非法
      // G2：open → closed（讀當前 status 判定合法後才寫）。
      this.events.updateStatus(active.id, 'closed');

      // D-005 §4：凍結正取數（有效正取，G6 過濾），split 計算並持久化最終攤額。
      const confirmedCount = this.registrations.countConfirmed(active.id);
      const closed: EventRow = { ...active, status: 'closed' };
      if (active.price_mode === 'split_venue') {
        // G1：ceil + 分母 max(,1)（perPersonAmount 已保底）。同交易寫 settled_per_person（OP-3、architect N2）。
        const settled = perPersonAmount(closed, confirmedCount);
        this.events.updateSettledPerPerson(active.id, settled);
        return {
          kind: 'ok',
          event: { ...closed, settled_per_person: settled },
          confirmedCount,
          settledPerPerson: settled,
        };
      }
      // per_person：不寫 settled_per_person（維持 NULL），不附結算列（AC-8）。
      return { kind: 'ok', event: closed, confirmedCount, settledPerPerson: null };
    });
  }

  // ── `取消活動`（cancel_event，§5.2；刪除類 R2） ────────────────────
  cancelEvent(input: LifecycleInput): CancelResult {
    if (!this.isAuthorized(input.executorLineUserId)) return { kind: 'not_authorized' };

    return this.tx<CancelResult>(() => {
      if (!this.processed.markProcessed(input.messageId)) return { kind: 'duplicate' };
      const active = this.events.findActiveByGroup(input.groupId);
      if (active === undefined) return { kind: 'no_active' };
      // open 或 closed 皆可取消；draft 未物化（防禦）。
      if (active.status !== 'open' && active.status !== 'closed') return { kind: 'no_active' };
      // G2：open/closed → cancelled（終態）。G10：僅狀態轉移，不刪 registrations。
      this.events.updateStatus(active.id, 'cancelled');
      return { kind: 'ok', event: { ...active, status: 'cancelled' } };
    });
  }
}
