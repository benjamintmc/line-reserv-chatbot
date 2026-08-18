// src/domain/event-service.ts
//
// D-004 §1–§6 / D-005 §3–§4 / D-006 §1–§2：開團 domain。組合 D-001 repository 原語 + create-flow 純邏輯。
// D-006（授權簡化）：開團全開（無授權，G1）；`關閉報名`/`取消活動` 授權 = canManageEvent
// （event.host_user_id ∪ super-admin，唯讀 getByLineUserId，非授權零副作用，G2）；狀態轉移合法性（G2）、
// 同群一場 active（G3）、交易 + 去重（G4）、host_user_id=建立者（G8）、取消活動不刪 registrations（G6/D-004 G10）。
//
// D-005：`確認` 建立 open event 後於同交易插入主辦第 1 正取（§3、走既有 insertSlot）；
// `關閉報名`(split) 於同交易計算 ceil 最終攤額並持久化 settled_per_person（§4、OP-3）。
//
// D-007 移植：sync→async（呼叫 repo/runner 處加 await）＋路線 A——交易閉包 (repos)=>Promise<T>，
// 閉包**內** this.<repo> 改用注入的 repos.<repo>（同一 client）；閉包**外**唯讀查詢仍用 this.<repo>。
// 窄捕捉改判 PG `23505` + `constraint==='ux_events_active_group'`。
//
// D-008 T-014（單場名額自動釋放）：
//   - 入口早退放寬為 `active && !isExpired`（過期 open 於入口放行、不 flip，§1b）。
//   - `確認` 交易內、insert 新 open 前：現存 active 若未過期 → already_active（清 conversation，nit-1）；
//     若過期 → updateStatus('done') flip 釋放索引槽，再 insert（原子，§1b/G1）。
//   - `確認` 建立前以 taipeiToUtcIso 合併 draft.date/time → event_datetime（UTC，§3）。
//   - close/cancel 遇過期 open → no_active（不 flip，OP-7/G5）；closed 已釋放 → 不再由 findActiveByGroup 返回。
//
// D-004 errata（跨群語意，2026-08-18）：`conversation_states` PK 為 line_user_id（跨群唯一），故
// continueFlow/confirm/abort 皆先比對 `conv.group_id === input.groupId`，不同群一律 noop
// （別群訊息不被當流程答案、不建立活動、不放棄流程）。handler 亦於攔截處同步比對。
//
// 本層**回傳結構化 domain 結果物件（非 LINE 訊息）**，對 LINE SDK 零耦合、可純測。
// 嚴禁 any（D-006 G4）；不得出現 SQL 字串或直接存取 db（D-006 G4）——一律經 repository / tx runner。
// super-admin 集合只認注入的 superAdminUserIds、不讀環境變數（由 server.ts 注入，D-006 G3）。

import { parseCommand } from '../commands';
import type { ConversationStateRow, EventRow, PriceMode } from '../db/schema';
import { GROUPING_STATE } from './grouping-service';
import type { EventReader } from '../db/repositories/event-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ConversationReader } from '../db/repositories/conversation-repository';
import type { TransactionRunner } from '../db/tx';
import { nowIso, taipeiToUtcIso } from '../db/time';
import { isExpired } from './event-status';
import { perPersonAmount } from './billing';
import { canManageEvent as canManageEventAuthz } from './authz';
import {
  applyAnswer,
  FIRST_STATE,
  isComplete,
  parseDraft,
  serializeDraft,
  type CreateEventDraft,
  type CreateState,
} from './create-flow';

// ── 結果物件型別（D-004 §7.1 / D-006 §2；嚴禁 any） ─────────────────────

/**
 * 被新流程覆寫掉的「前一段未完成流程」種類（D-004 errata 跨群，2026-08-18）。
 * `conversation_states` PK 為 line_user_id ⇒ 一人同時只有一段流程；開新流程必然覆寫舊列。
 * **刻意不帶來源群資訊**：回覆若能讓讀者判斷前一段流程在哪一群，等同洩漏他群活動的存在。
 */
export type AbandonedKind = 'create' | 'grouping';

/** `開團`（一行式 / 逐步）入口結果。D-006：開團全開，移除 not_authorized。 */
export type CreateEntryResult =
  | { kind: 'already_active'; event: EventRow }
  | { kind: 'duplicate' }
  | { kind: 'flow_started'; state: CreateState; abandoned?: AbandonedKind }
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft; abandoned?: AbandonedKind };

/** 一行式格式畸形（invalid create_event）結果。D-006：開團全開，收斂為單一 format_help。 */
export type InvalidOnelineResult = { kind: 'format_help' };

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
 * D-006：not_authorized（非建立者非 super-admin）於進交易前 early-return。
 * D-008：`already_closed` 因 closed 不再由 findActiveByGroup 返回 → 不可達（保留供防禦，errata D-004 §5.1）。
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
  /** D-004 errata（跨群語意）：只放棄**同一來源群**的進行中流程；別群的 `取消` 一律 noop。 */
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export interface LifecycleInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export interface EventServiceDeps {
  events: EventReader;
  users: UserRepository;
  conversations: ConversationReader;
  runInTransaction: TransactionRunner;
  /** super-admin 集合（來源 env ADMIN_USER_IDS，由 server.ts 注入；跨群安全網、domain 不讀 env，D-006 G3）。 */
  superAdminUserIds: ReadonlyArray<string>;
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * 窄捕捉：判斷 err 是否為「命中 ux_events_active_group（同群一場 active）」的 PG 唯一約束違反。
 * PG 錯誤帶 `code` 與 `constraint` 欄：`code==='23505'`（unique_violation）且
 * `constraint==='ux_events_active_group'`（較 SQLite 訊息比對精確）。結構化型別守衛，不 import pg、
 * 不使用 any（G5/G6）。其餘任何錯誤（含其他 UNIQUE index）皆不匹配 → 由呼叫端 re-throw。
 */
function isActiveGroupUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === 'ux_events_active_group';
}

export class EventService {
  private readonly events: EventReader;
  private readonly users: UserRepository;
  private readonly conversations: ConversationReader;
  private readonly tx: TransactionRunner;
  private readonly superAdmins: ReadonlySet<string>;
  private readonly logError: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(deps: EventServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.conversations = deps.conversations;
    this.tx = deps.runInTransaction;
    this.superAdmins = new Set(deps.superAdminUserIds);
    this.logError =
      deps.logError ??
      ((msg, meta): void => {
        console.error(msg, meta ?? {});
      });
  }

  /**
   * D-006 §1.2：生命週期管理授權（`關閉報名`/`取消活動`）。
   * = super-admin（注入，跨群、純 line_user_id 比對、不查 DB）
   *   ∨ 該活動建立者（executor 經**唯讀** getByLineUserId 解析出的 user.id === event.host_user_id）。
   * **唯讀不 upsert**：對非授權者不寫任何 users 列 → 滿足「非授權者無 DB 變更」（G2）。
   */
  private async canManageEvent(event: EventRow, executorLineUserId: string): Promise<boolean> {
    // D-010 nit N1：委派共享謂詞（src/domain/authz.ts），與 registration-service 的 addCapacity 共用。
    return canManageEventAuthz(this.users, this.superAdmins, event, executorLineUserId);
  }

  /**
   * 判定「即將被新流程覆寫的前一段流程」種類（D-004 errata 跨群，2026-08-18）。
   *
   * 背景：跨群守衛使一條原本不可達的路徑變成可達——修正前，在別群輸入 `開團` 會被 handler
   * 攔截成原群當前欄位的答案（格式錯→重問），draft 不會被覆寫；修正後不再攔截，`startCreation`
   * 無條件 upsert（PK=line_user_id）會**靜默**吃掉舊列，使用者回原群作答則因 `unknown` 而無回覆
   * （＝D-004 §3.3 刻意消除過的靜默死角）。故此處偵測並由 handler 附一句告知，消除「靜默」。
   *
   * **必於交易內以 client-bound repos 讀取**（與隨後的 upsert 同連線，避免 TOCTOU）。
   * 同群 create 流程回 undefined：該情形 handler 已攔截為流程答案，走不到這裡。
   */
  private detectAbandoned(
    prev: ConversationStateRow | undefined,
    groupId: string,
  ): AbandonedKind | undefined {
    if (prev === undefined) return undefined;
    if (prev.state === GROUPING_STATE) return 'grouping'; // 分組 session 被覆寫（同群/別群皆可達）
    if (prev.group_id !== groupId) return 'create'; // 別群未完成的開團流程被覆寫
    return undefined;
  }

  // ── `開團`（逐步問答入口，§3；D-006 §1.1 開團全開） ──────────────────
  async startCreation(input: StartCreationInput): Promise<CreateEntryResult> {
    // 入口先查（§6 fail fast）：已有**未過期** active（open）→ 拒絕、不寫 conversation。
    // D-008 §1b：過期 open 於入口放行（不 flip、不建立），實際 flip 延至 `確認` 交易。
    const active = await this.events.findActiveByGroup(input.groupId);
    if (active !== undefined && !isExpired(active, nowIso())) {
      return { kind: 'already_active', event: active };
    }

    return this.tx<CreateEntryResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      // errata（跨群）：upsert 前先看有無將被覆寫的舊流程，供 handler 附告知句（消除靜默死角）。
      const abandoned = this.detectAbandoned(
        await repos.conversations.get(input.executorLineUserId),
        input.groupId,
      );
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: FIRST_STATE,
        payload: serializeDraft({}),
      });
      return {
        kind: 'flow_started',
        state: FIRST_STATE,
        ...(abandoned !== undefined ? { abandoned } : {}),
      };
    });
  }

  // ── `開團 <欄位…>`（一行式入口，§2 / D-005 §6.1；D-006 §1.1 開團全開） ──
  async handleOneline(input: OnelineInput): Promise<CreateEntryResult> {
    const active = await this.events.findActiveByGroup(input.groupId);
    if (active !== undefined && !isExpired(active, nowIso())) {
      return { kind: 'already_active', event: active };
    }

    const draft: CreateEventDraft = {
      date: input.date,
      time: input.time,
      location: input.location,
      capacity: input.capacity,
      price: input.price,
      priceMode: input.priceMode,
      ...(input.venueFee !== undefined ? { venueFee: input.venueFee } : {}),
    };

    return this.tx<CreateEntryResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      // errata（跨群）：同 startCreation——一行式亦會覆寫舊列，須告知。
      const abandoned = this.detectAbandoned(
        await repos.conversations.get(input.executorLineUserId),
        input.groupId,
      );
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: 'awaiting_confirm',
        payload: serializeDraft(draft),
      });
      return {
        kind: 'awaiting_confirm',
        draft,
        ...(abandoned !== undefined ? { abandoned } : {}),
      };
    });
  }

  // ── invalid（create_event 格式畸形；§9 (K′)；D-006 §1.1 開團全開，恆回 format_help） ──
  handleInvalidOneline(): InvalidOnelineResult {
    // 純引導、無 DB 副作用、不 mark（§9 註）。開團全開 → 無授權分支。
    return { kind: 'format_help' };
  }

  // ── 進行中流程的一則訊息（§3.3/§3.4） ─────────────────────────────
  async continueFlow(input: ContinueFlowInput): Promise<ContinueFlowResult> {
    const conv = await this.conversations.get(input.executorLineUserId);
    if (conv === undefined) return { kind: 'noop' }; // 安全網（handler 已先攔截存在者）
    // D-004 errata（跨群語意，2026-08-18）：conversation_states 以 line_user_id 為 PK（跨群唯一），
    // 只有**流程發生的那個群**的訊息才是流程答案；別群訊息 → noop（不前進、不寫、不 mark）。
    if (conv.group_id !== input.groupId) return { kind: 'noop' };

    const cmd = parseCommand(input.text);

    // `取消`（abort）：任一 state 皆放棄流程（§3.4）。
    if (cmd.type === 'abort') {
      const r = await this.abort({
        groupId: input.groupId,
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
        const r = await this.confirm({
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
    return this.tx<ContinueFlowResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      await repos.conversations.upsert({
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

  // ── `確認` 建立 open event + 主辦自動登記（§4 / D-005 §3 / D-008 §1b/§3） ───────────
  async confirm(input: ConfirmInput): Promise<ConfirmResult> {
    const conv = await this.conversations.get(input.executorLineUserId);
    if (conv === undefined || conv.state !== 'awaiting_confirm') return { kind: 'noop' };
    // D-004 errata（跨群語意）：draft 屬於 conv.group_id 那一群，**不得**因別群的 `確認` 而在別群建立活動。
    if (conv.group_id !== input.groupId) return { kind: 'noop' };
    const draft = parseDraft(conv.payload);
    if (!isComplete(draft)) return { kind: 'noop' }; // 欄位不齊不建立（AC-20）

    try {
      return await this.tx<ConfirmResult>(async (repos) => {
        if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };

        // G3 入口再確認（交易內權威重讀）。D-008 §1b：
        //   未過期 active → already_active（清 conversation，nit-1）；
        //   過期 open → flip done（釋放索引槽），再於同交易 insert 新 open（原子，G1）。
        const active = await repos.events.findActiveByGroup(input.groupId);
        if (active !== undefined) {
          if (!isExpired(active, nowIso())) {
            await repos.conversations.delete(input.executorLineUserId);
            return { kind: 'already_active' };
          }
          await repos.events.updateStatus(active.id, 'done');
        }

        // G8：host_user_id = 建立者（任一群成員，D-006 開團全開）的 user.id。
        const host = await repos.users.upsert(input.executorLineUserId, input.hostDisplayName);

        // D-008 §3：台灣本地 draft.date/time → UTC event_datetime（一行式與逐步問答皆匯流至此）。
        const eventDatetime = taipeiToUtcIso(draft.date, draft.time);

        // 真正安全網：INSERT 撞 ux_events_active_group（並行競態）。PG 下唯一違反會 abort 整個交易，
        // 故此處**不** catch-and-continue；讓錯誤逸出 → 交易 runner ROLLBACK + rethrow → 由下方 catch
        // 於**另一交易**清落敗者流程（nit-2）並回 already_active。
        const event = await repos.events.create({
          groupId: input.groupId,
          hostUserId: host.id,
          eventDatetime,
          location: draft.location,
          capacity: draft.capacity,
          pricePerPerson: draft.price,
          priceMode: draft.priceMode,
          venueFee: draft.venueFee,
          status: 'open',
        });

        // D-005 §3：主辦自動登記為第 1 正取（名單第 1 位；均攤分母天然 >=1）。
        // 走既有 per-slot 交易原語 insertSlot（G3，不繞過）；此 DEFERRED 交易內 event 尚未 COMMIT、
        // 無並行 signup 可觀察 → 無超賣風險（G2 carve-out，ADR-004）。空 event → seq=1。
        await repos.registrations.insertSlot({
          eventId: event.id,
          ownerUserId: host.id,
          displayName: input.hostDisplayName,
          kind: 'self',
          status: 'confirmed',
        });

        await repos.conversations.delete(input.executorLineUserId);
        return { kind: 'created', event };
      });
    } catch (err) {
      // G3 窄捕捉：僅命中 ux_events_active_group 的 UNIQUE → already_active；其餘一律 re-throw。
      if (!isActiveGroupUniqueViolation(err)) throw err;
      // 落敗者：上方交易已整批 ROLLBACK（含 markProcessed）。另起交易清落敗者流程，不卡 awaiting_confirm（nit-2）。
      await this.tx(async (repos) => {
        await repos.conversations.delete(input.executorLineUserId);
        return undefined;
      });
      return { kind: 'already_active' };
    }
  }

  // ── `取消`（abort，§3.4） ─────────────────────────────────────────
  async abort(input: AbortInput): Promise<AbortResult> {
    const conv = await this.conversations.get(input.executorLineUserId);
    if (conv === undefined) return { kind: 'noop' }; // 無流程 → 靜默 no-op（G9）
    // D-004 errata（跨群語意）：別群的 `取消` 不得放棄本人在他群的流程 → 靜默 noop。
    if (conv.group_id !== input.groupId) return { kind: 'noop' };

    return this.tx<AbortResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      await repos.conversations.delete(input.executorLineUserId);
      return { kind: 'aborted' };
    });
  }

  // ── `關閉報名`（close_event，§5.2 / D-005 §4 / D-006 §1.2·§2 / D-008 OP-7） ───────
  async closeEvent(input: LifecycleInput): Promise<CloseResult> {
    // D-006 §2：授權需先讀 active 取 host_user_id → no_active 與 not_authorized 皆於**進交易前**
    // early-return（不 mark、無 DB 變更，G2）。
    // D-008 OP-7：過期 open → no_active、不 flip（讀寫最小，reads 不寫，G5）。
    const active0 = await this.events.findActiveByGroup(input.groupId);
    if (active0 === undefined) return { kind: 'no_active' };
    if (isExpired(active0, nowIso())) return { kind: 'no_active' };
    if (!(await this.canManageEvent(active0, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }

    return this.tx<CloseResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      const active = await repos.events.findActiveByGroup(input.groupId); // 交易內權威重讀（D-004 §5.2）
      if (active === undefined) return { kind: 'no_active' };
      if (isExpired(active, nowIso())) return { kind: 'no_active' }; // 交易內重檢（OP-7）
      if (active.status === 'closed') return { kind: 'already_closed' }; // D-008：不可達（防禦保留）
      if (active.status !== 'open') return { kind: 'no_active' }; // draft 未物化，其餘非法
      // G2：open → closed（讀當前 status 判定合法後才寫）。
      await repos.events.updateStatus(active.id, 'closed');

      // D-005 §4：凍結正取數（有效正取），split 計算並持久化最終攤額。
      const confirmedCount = await repos.registrations.countConfirmed(active.id);
      const closed: EventRow = { ...active, status: 'closed' };
      if (active.price_mode === 'split_venue') {
        // ceil + 分母 max(,1)（perPersonAmount 已保底）。同交易寫 settled_per_person（OP-3）。
        const settled = perPersonAmount(closed, confirmedCount);
        await repos.events.updateSettledPerPerson(active.id, settled);
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

  // ── `取消活動`（cancel_event，§5.2；刪除類 R2 / D-006 §1.2·§2 / D-008 OP-7） ──────
  async cancelEvent(input: LifecycleInput): Promise<CancelResult> {
    // D-006 §2：授權於進交易前判定（不 mark、無 DB 變更，G2）。
    // D-008 OP-7：過期 open → no_active、不 flip；closed 已釋放（findActiveByGroup 不回）→ no_active。
    const active0 = await this.events.findActiveByGroup(input.groupId);
    if (active0 === undefined) return { kind: 'no_active' };
    if (isExpired(active0, nowIso())) return { kind: 'no_active' };
    if (!(await this.canManageEvent(active0, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }

    return this.tx<CancelResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      const active = await repos.events.findActiveByGroup(input.groupId); // 交易內權威重讀
      if (active === undefined) return { kind: 'no_active' };
      if (isExpired(active, nowIso())) return { kind: 'no_active' }; // 交易內重檢（OP-7）
      // open 可取消；draft 未物化、closed 不再由 findActiveByGroup 返回（防禦）。
      if (active.status !== 'open' && active.status !== 'closed') return { kind: 'no_active' };
      // G2：open → cancelled（終態）。G6：僅狀態轉移，不刪 registrations。
      await repos.events.updateStatus(active.id, 'cancelled');
      return { kind: 'ok', event: { ...active, status: 'cancelled' } };
    });
  }
}
