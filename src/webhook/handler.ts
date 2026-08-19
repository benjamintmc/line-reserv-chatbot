// src/webhook/handler.ts
//
// D-003 §6 / D-004 §9 / D-005 §9 / D-006 §4：webhook 接線。從 LINE WebhookEvent 抽
// groupId/userId/messageId/text → **先查 conversation_states 攔截進行中開團流程（per-user 隔離）** →
// 否則 parseCommand → 依 type 窮舉分派 → 取名（getGroupMemberProfile）→ 呼叫 service →
// 呼叫 formatter → 組出 messagingApi.Message[]（含 mention）。
//
// D-006：開團全開（create_* 不再產生 not_authorized）；close/cancel 授權於 service 內 canManageEvent
// 判定（非授權回 (H′)）；`my_id` 由 no-op 接線回 (MyID)。
//
// D-007 移植：domain/repo 皆 async → 呼叫處加 await（含 conversations.get / buildPromotionNotice 的
// users.getById / resolveDisplayName 的 users.getByLineUserId）；renderCancel 因需 await 遞補通知而轉 async。
//
// D-008 T-014：signup/cancel 新增 event_ended → 拒絕文案（formatEventEnded）；
// 名單依 domain 傳回之 phase（live/ended/closed）組版（formatList(view, phase)）。
//
// D-011 T-018：新增 `分組`/`下一輪` 接線 → GroupingService。conversation_states 同一列也被開團問答用，
// 故頂層攔截只攔非 'grouping' 狀態（開團 awaiting_*），grouping session 交由 parseCommand→`下一輪` 讀取。
//
// D-012 T-020：多行批次報名。conversation 攔截優先不變；否則以 /\r?\n/ 拆行——
// 行數 ≤1 走現行單指令路徑（零回歸，G5）；行數 ≥2 走批次路徑（handleBatch）：逐行 parseCommand、
// **僅** signup/cancel 可執行（G1）、依序 await、messageId 傳複合鍵 `${messageId}#${lineIndex}`（G2/G3），
// 合併為**一次 reply（≤5 則）**（G4）；可執行行數 > MAX_BATCH_LINES → 整則拒絕不部分執行（G6）。
//
// **LINE SDK 型別只在此層出現**（domain/formatter 對 LINE 零耦合）。嚴禁 any。
// unknown / 無流程 confirm·abort / 未攔截雜訊一律不回覆、不 markProcessed（G9）。

import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { parseCommand } from '../commands';
import type { RegistrationRow } from '../db/schema';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ConversationReader } from '../db/repositories/conversation-repository';
import type {
  RegistrationService,
  SignupResult,
  CancelResult,
  ListResult,
  AddCapacityResult,
  RegistrationView,
} from '../domain/registration-service';
import type {
  EventService,
  CreateEntryResult,
  ContinueFlowResult,
  ConfirmResult,
  AbortResult,
  CloseResult,
  CancelResult as EventCancelResult,
  InvalidOnelineResult,
} from '../domain/event-service';
import type {
  GroupingService,
  BalancedResult,
  StartRoundsResult,
  NextRoundResult,
} from '../domain/grouping-service';
import {
  formatSignup,
  formatCancel,
  formatList,
  formatNoOpenEvent,
  formatEventEnded,
  formatNothingToCancel,
  formatPromotionNotice,
  formatAddCapacity,
  formatAddCapacityNotAuthorized,
  formatAddCapacityEnded,
  formatAddCapacityOverLimit,
  formatBatchSummary,
  formatBatchOverLimit,
  type MessageDescriptor,
  type PromotionNotice,
  type BatchSummaryItem,
} from '../domain/list-formatter';
import {
  formatFlowPrompt,
  formatConfirmSummary,
  withAbandonedNotice,
  formatFieldError,
  formatOpenAnnouncement,
  formatClosed,
  formatCancelled,
  formatAborted,
  formatNotAuthorized,
  formatMyId,
  formatAlreadyActiveEntry,
  formatAlreadyClosed,
  formatNoActiveEvent,
  formatOnelineFormatHelp,
  formatRaceLost,
  formatConfirmReprompt,
} from '../domain/event-formatter';
import {
  formatPartition,
  formatRound,
  formatInsufficientForRounds,
  formatNoGroupingSession,
  formatRoundsExhausted,
  formatGroupNotHost,
  formatGroupFormatHelp,
} from '../domain/grouping-formatter';

/**
 * D-012 §2.4：多行批次一次可執行的 +/-（signup/cancel）行數上限。
 * **只計可執行行**（空行/被忽略行不計）；超過 → 整則拒絕、不部分執行（G6）。
 */
const MAX_BATCH_LINES = 20;

/**
 * 取群組成員顯示名的最小介面（結構相容 `messagingApi.MessagingApiClient.getGroupMemberProfile`）。
 * 用群組成員 profile 而非 `getProfile`：後者對未加 bot 好友者 404（AC-19、NFR-4）。
 */
export interface GroupProfileClient {
  getGroupMemberProfile(groupId: string, userId: string): Promise<{ displayName: string }>;
}

export interface WebhookHandlerDeps {
  service: RegistrationService;
  eventService: EventService;
  grouping: GroupingService;
  users: UserRepository;
  conversations: ConversationReader;
  profile: GroupProfileClient;
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface WebhookHandler {
  /** 處理單一 WebhookEvent，回傳待 reply 的 LINE 訊息陣列（空陣列＝不回覆）。 */
  handleEvent(event: WebhookEvent): Promise<messagingApi.Message[]>;
}

/** 純文字 LINE 訊息（分組回覆無 mention，直接組 TextMessage）。 */
function textMessage(text: string): messagingApi.Message {
  return { type: 'text', text };
}

/** MessageDescriptor → LINE 訊息：無 mention→TextMessage；含 mention→TextMessageV2 + substitution。 */
function toLineMessage(d: MessageDescriptor): messagingApi.Message {
  if (d.mentionees.length === 0) {
    return { type: 'text', text: d.text };
  }
  const sorted = [...d.mentionees].sort((a, b) => a.index - b.index);
  const substitution: Record<string, messagingApi.SubstitutionObject> = {};
  let out = '';
  let cursor = 0;
  sorted.forEach((m, i) => {
    const key = `m${i}`;
    out += d.text.slice(cursor, m.index);
    out += `{${key}}`;
    substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: m.lineUserId } };
    cursor = m.index + m.length;
  });
  out += d.text.slice(cursor);
  const msg: messagingApi.TextMessageV2 = { type: 'textV2', text: out, substitution };
  return msg;
}

export function createWebhookHandler(deps: WebhookHandlerDeps): WebhookHandler {
  const logError =
    deps.logError ??
    ((msg, meta): void => {
      console.error(msg, meta ?? {});
    });

  /** 取顯示名快照（AC-19、§7 fallback：getGroupMemberProfile → users.display_name → 「使用者」）。 */
  async function resolveDisplayName(groupId: string, userId: string): Promise<string> {
    try {
      const p = await deps.profile.getGroupMemberProfile(groupId, userId);
      if (p.displayName.length > 0) return p.displayName;
    } catch (err) {
      logError('getGroupMemberProfile 失敗，改用 fallback', {
        groupId,
        userId,
        err: String(err),
      });
    }
    const existing = await deps.users.getByLineUserId(userId);
    if (existing !== undefined) return existing.display_name;
    return '使用者';
  }

  /** 被遞補列 → 遞補通知（以 userRepo 解析 owner 的 line_user_id 與代報者稱謂；§4）。 */
  async function buildPromotionNotice(row: RegistrationRow): Promise<PromotionNotice> {
    const owner = await deps.users.getById(row.owner_user_id);
    const ownerLineUserId = owner?.line_user_id ?? null;
    if (row.kind === 'proxy') {
      return {
        isProxy: true,
        displayName: row.display_name,
        proxyAgentName: owner?.display_name ?? '代報者',
        ownerLineUserId,
      };
    }
    return { isProxy: false, displayName: row.display_name, ownerLineUserId };
  }

  // ── D-003 render（D-008：新增 event_ended / 名單 phase） ────────────────
  function renderSignup(result: SignupResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'event_ended':
        return [toLineMessage(formatEventEnded())]; // D-008 §8(1)/AC-4
      case 'duplicate':
        return [];
      case 'ok':
        return [toLineMessage(formatSignup(result))];
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  async function renderCancel(
    result: CancelResult,
    proxyName?: string,
  ): Promise<messagingApi.Message[]> {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'event_ended':
        return [toLineMessage(formatEventEnded())]; // D-008 §8(1)/AC-4
      case 'duplicate':
        return [];
      case 'nothing_to_cancel':
        return [toLineMessage(formatNothingToCancel(proxyName))];
      case 'ok': {
        const messages = [toLineMessage(formatCancel(result))];
        if (result.promoted.length > 0) {
          const notices = await Promise.all(result.promoted.map((row) => buildPromotionNotice(row)));
          messages.push(toLineMessage(formatPromotionNotice(notices)));
        }
        return messages;
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderList(result: ListResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'duplicate':
        return [];
      case 'ok':
        return [toLineMessage(formatList(result.view, result.phase))]; // D-008 §8(3)：phase 化
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  // ── D-010 render（加開名額；單一則：公告 + 名單 + 同則遞補 @，需 await 解析 owner） ──
  async function renderAddCapacity(result: AddCapacityResult): Promise<messagingApi.Message[]> {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'event_ended':
        return [toLineMessage(formatAddCapacityEnded())];
      case 'not_authorized':
        return [toLineMessage(formatAddCapacityNotAuthorized())];
      case 'over_limit':
        return [toLineMessage(formatAddCapacityOverLimit())];
      case 'duplicate':
        return [];
      case 'ok': {
        const notices = await Promise.all(result.promoted.map((row) => buildPromotionNotice(row)));
        return [toLineMessage(formatAddCapacity(result, notices))];
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  // ── D-011 render（分組；中性純文字，無 mention） ───────────────────────
  function renderBalanced(result: BalancedResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'not_authorized':
        return [textMessage(formatGroupNotHost())]; // errata：分組 host-only（非主辦含 super-admin 皆拒）
      case 'duplicate':
        return []; // B2：策略A 唯讀去重（重送不重算、不二次回覆）
      case 'balanced':
        return [textMessage(formatPartition(result.result))];
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderStartRounds(result: StartRoundsResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'not_authorized':
        return [textMessage(formatGroupNotHost())]; // errata：分組 host-only
      case 'duplicate':
        return [];
      case 'insufficient':
        return [textMessage(formatInsufficientForRounds())];
      case 'round':
        return [textMessage(formatRound(result.round))];
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderNextRound(result: NextRoundResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_session':
        return [textMessage(formatNoGroupingSession())];
      case 'duplicate':
        return [];
      case 'exhausted':
        return [textMessage(formatRoundsExhausted())];
      case 'round':
        return [textMessage(formatRound(result.round))];
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  // ── D-004 / D-006 render ─────────────────────────────────────────────
  function renderCreateEntry(result: CreateEntryResult): messagingApi.Message[] {
    // D-006：開團全開 → CreateEntryResult 無 not_authorized 成員。
    switch (result.kind) {
      case 'already_active':
        return [toLineMessage(formatAlreadyActiveEntry(result.event))]; // (I)
      case 'duplicate':
        return [];
      case 'flow_started': {
        // (A) ＋ (N2)：若本次開新流程覆寫掉前一段未完成流程，附一句告知（D-004 errata 跨群）。
        const base = formatFlowPrompt(result.state);
        return [
          toLineMessage(
            result.abandoned === 'grouping' ? withAbandonedNotice(base) : base,
          ),
        ];
      }
      case 'awaiting_confirm': {
        // (B) ＋ (N2)：同上（一行式路徑）。
        const base = formatConfirmSummary(result.draft);
        return [
          toLineMessage(
            result.abandoned === 'grouping' ? withAbandonedNotice(base) : base,
          ),
        ];
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderContinue(result: ContinueFlowResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'noop':
      case 'duplicate':
        return [];
      case 'field_error':
        return [toLineMessage(formatFieldError(result.state))]; // (C)
      case 'advanced':
        return [toLineMessage(formatFlowPrompt(result.state))]; // (A)
      case 'awaiting_confirm':
        return [toLineMessage(formatConfirmSummary(result.draft))]; // (B)
      case 'confirm_reprompt':
        return [toLineMessage(formatConfirmReprompt())]; // (M)
      case 'aborted':
        return [toLineMessage(formatAborted())]; // (G)
      case 'created':
        return [toLineMessage(formatOpenAnnouncement(result.event))]; // (D)
      case 'already_active':
        return [toLineMessage(formatRaceLost())]; // (L)
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderConfirm(result: ConfirmResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'noop':
      case 'duplicate':
        return [];
      case 'already_active':
        return [toLineMessage(formatRaceLost())]; // (L)
      case 'created':
        return [toLineMessage(formatOpenAnnouncement(result.event))]; // (D)
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderAbort(result: AbortResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'noop':
      case 'duplicate':
        return [];
      case 'aborted':
        return [toLineMessage(formatAborted())]; // (G)
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderClose(result: CloseResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'not_authorized':
        return [toLineMessage(formatNotAuthorized())]; // (H′) 非建立者非 super-admin
      case 'duplicate':
        return [];
      case 'no_active':
        return [toLineMessage(formatNoActiveEvent())]; // (J)
      case 'already_closed':
        return [toLineMessage(formatAlreadyClosed())]; // (J)（D-008：不可達，保留防禦）
      case 'ok':
        // D-005 §4：settledPerPerson 為結算唯一真相來源（split 才有值），confirmedCount 供顯示 K。
        return [
          toLineMessage(formatClosed(result.event, result.settledPerPerson, result.confirmedCount)),
        ]; // (E)
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderCancelEvent(result: EventCancelResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'not_authorized':
        return [toLineMessage(formatNotAuthorized())]; // (H′) 非建立者非 super-admin
      case 'duplicate':
        return [];
      case 'no_active':
        return [toLineMessage(formatNoActiveEvent())]; // (J)
      case 'ok':
        return [toLineMessage(formatCancelled(result.event))]; // (F)
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  function renderInvalidOneline(result: InvalidOnelineResult): messagingApi.Message[] {
    // D-006：開團全開 → InvalidOnelineResult 收斂為單一 format_help。
    switch (result.kind) {
      case 'format_help':
        return [toLineMessage(formatOnelineFormatHelp())]; // (K′)
      default: {
        const _exhaustive: never = result.kind;
        return _exhaustive;
      }
    }
  }

  /**
   * 單指令分派（D-003~D-011 既有路徑）。多行批次以外一律走此（單行、或批次以外的分派）。
   * G5：`lines.length <= 1` 時必須走與此完全相同的路徑，行為不得改變。
   */
  async function dispatchSingle(
    groupId: string,
    userId: string,
    messageId: string,
    text: string,
  ): Promise<messagingApi.Message[]> {
    const cmd = parseCommand(text);
    switch (cmd.type) {
      case 'signup': {
        const displayName = await resolveDisplayName(groupId, userId);
        const result = await deps.service.signup({
          groupId,
          executorLineUserId: userId,
          executorDisplayName: displayName,
          messageId,
          count: cmd.count,
          proxyName: cmd.proxyName,
        });
        return renderSignup(result);
      }
      case 'cancel': {
        const displayName = await resolveDisplayName(groupId, userId);
        const result = await deps.service.cancel({
          groupId,
          executorLineUserId: userId,
          executorDisplayName: displayName,
          messageId,
          count: cmd.count,
          proxyName: cmd.proxyName,
        });
        return renderCancel(result, cmd.proxyName);
      }
      case 'list': {
        const result = await deps.service.getListView({ groupId, messageId });
        return renderList(result);
      }
      // D-010：加開名額（`加開 N`）——service 內 canManageEvent 授權 + 鎖內加開遞補。
      case 'add_capacity': {
        const result = await deps.service.addCapacity({
          groupId,
          executorLineUserId: userId,
          messageId,
          count: cmd.count,
        });
        return renderAddCapacity(result);
      }
      // D-011：分組（`分組` 均分 / `分組 {M}場…` 多輪）與 `下一輪` ─────────
      case 'group': {
        if (cmd.strategy === 'balanced') {
          const result = await deps.grouping.groupBalanced({
            groupId,
            executorLineUserId: userId,
            messageId,
          });
          return renderBalanced(result);
        }
        const result = await deps.grouping.startRounds({
          groupId,
          executorLineUserId: userId,
          messageId,
          courts: cmd.courts,
          rounds: cmd.rounds,
          mode: cmd.mode,
        });
        return renderStartRounds(result);
      }
      case 'group_next': {
        // B1：傳來源 groupId，service 比對 session 的 group_id（跨群 → no_session，不外洩他群名單）。
        const result = await deps.grouping.nextRound({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderNextRound(result);
      }
      // D-004 M3 開團流程（D-006：開團全開，無授權前置） ────────────────
      case 'create_event_oneline': {
        const result = await deps.eventService.handleOneline({
          groupId,
          executorLineUserId: userId,
          messageId,
          date: cmd.date,
          time: cmd.time,
          location: cmd.location,
          capacity: cmd.capacity,
          price: cmd.price,
          priceMode: cmd.priceMode,
          venueFee: cmd.venueFee,
        });
        return renderCreateEntry(result);
      }
      case 'create_event_start': {
        const result = await deps.eventService.startCreation({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderCreateEntry(result);
      }
      case 'confirm': {
        // 走到此代表無進行中流程（有流程已於上方攔截）→ 靜默 no-op（G9）。
        const result = await deps.eventService.confirm({
          groupId,
          executorLineUserId: userId,
          messageId,
          hostDisplayName: '',
        });
        return renderConfirm(result);
      }
      case 'abort': {
        // 同上：無流程 → 靜默 no-op（G9）。D-004 errata（跨群）：傳 groupId，
        // 別群的 `取消` 不得放棄本人在他群的進行中流程（service 內比對 conv.group_id）。
        const result = await deps.eventService.abort({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderAbort(result);
      }
      case 'close_event': {
        // D-006：service 內 canManageEvent 判定；非授權回 (H′)。
        const result = await deps.eventService.closeEvent({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderClose(result);
      }
      case 'cancel_event': {
        // D-006：service 內 canManageEvent 判定；非授權回 (H′)。
        const result = await deps.eventService.cancelEvent({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderCancelEvent(result);
      }
      case 'my_id':
        // D-006 §3：接線回 (MyID)——傳訊人自身 userId（群回、唯讀、不 mark）。
        return [toLineMessage(formatMyId(userId))];
      case 'invalid': {
        // create_event 類 → 格式提示 (K′)；group 類 → 分組格式提示；signup/cancel/add_capacity 類 → 靜默（D-010 §一.1）。
        if (cmd.command === 'create_event') {
          const result = deps.eventService.handleInvalidOneline();
          return renderInvalidOneline(result);
        }
        if (cmd.command === 'group') {
          return [textMessage(formatGroupFormatHelp())];
        }
        return [];
      }
      case 'unknown':
        return []; // G9：不回覆、不 mark。
      default: {
        const _exhaustive: never = cmd;
        return _exhaustive;
      }
    }
  }

  /**
   * D-012 多行批次分派（`lines.length >= 2`）。逐行 trim；空行忽略但保留 lineIndex（split 陣列索引）；
   * 每非空行 parseCommand，**僅** signup/cancel 可執行（G1），其餘型別忽略；**依序 await**、
   * messageId 傳複合鍵 `${messageId}#${lineIndex}`（G2/G3，後行看得到前行效果）；合併為一次 reply（≤5 則，G4）。
   * 可執行 +/- 行數 > MAX_BATCH_LINES → 整則拒絕、不執行任何行、不 markProcessed（G6）。
   */
  async function handleBatch(
    groupId: string,
    userId: string,
    messageId: string,
    lines: string[],
  ): Promise<messagingApi.Message[]> {
    // 逐行 trim 取可執行行（保留原 split 索引 i 作複合去重鍵）。空行/非 signup·cancel 一律忽略（G1）。
    type Executable = { index: number; cmd: Extract<ReturnType<typeof parseCommand>, { type: 'signup' | 'cancel' }> };
    const executables: Executable[] = [];
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (line === '') return; // 空行忽略，但 lineIndex（i）已保留供去重鍵穩定
      const cmd = parseCommand(line);
      if (cmd.type === 'signup' || cmd.type === 'cancel') {
        executables.push({ index: i, cmd });
      }
      // 其餘型別（list/create_*/confirm/abort/group*/my_id/invalid/unknown）忽略（G1）。
    });

    // G6：可執行行數超過上限 → 整則拒絕，不執行任何行、不 markProcessed。
    if (executables.length > MAX_BATCH_LINES) {
      return [toLineMessage(formatBatchOverLimit(MAX_BATCH_LINES))];
    }
    // 無任何可執行行 → 回空（沿用「只回應可識別指令」，避免洗版）。
    if (executables.length === 0) return [];

    // 同一 executor：顯示名快照取一次即可（signup/cancel 皆用）。
    const displayName = await resolveDisplayName(groupId, userId);

    const summary: BatchSummaryItem[] = [];
    const promotedRows: RegistrationRow[] = [];
    let lastView: RegistrationView | undefined;
    // 無成功行時的 fallback 原因（依序 await，取最後一筆非 duplicate 的原因呈現一次）。
    let fallback: MessageDescriptor | undefined;

    for (const { index, cmd } of executables) {
      const compositeId = `${messageId}#${index}`; // G2：複合去重鍵，重送整則時每行命中各自鍵
      if (cmd.type === 'signup') {
        const result = await deps.service.signup({
          groupId,
          executorLineUserId: userId,
          executorDisplayName: displayName,
          messageId: compositeId,
          count: cmd.count,
          proxyName: cmd.proxyName,
        });
        switch (result.kind) {
          case 'ok':
            summary.push({
              kind: 'signup',
              subjectDisplayName: result.subjectDisplayName,
              waitlisted: result.outcome === 'waitlisted',
            });
            lastView = result.view;
            break;
          case 'duplicate':
            break; // 逐行 duplicate 不產摘要行（G9）
          case 'no_open_event':
            fallback = formatNoOpenEvent();
            break;
          case 'event_ended':
            fallback = formatEventEnded();
            break;
          default: {
            const _exhaustive: never = result;
            return _exhaustive;
          }
        }
      } else {
        const result = await deps.service.cancel({
          groupId,
          executorLineUserId: userId,
          executorDisplayName: displayName,
          messageId: compositeId,
          count: cmd.count,
          proxyName: cmd.proxyName,
        });
        switch (result.kind) {
          case 'ok':
            summary.push({ kind: 'cancel', subjectDisplayName: result.subjectDisplayName });
            lastView = result.view;
            if (result.promoted.length > 0) promotedRows.push(...result.promoted);
            break;
          case 'duplicate':
            break;
          case 'no_open_event':
            fallback = formatNoOpenEvent();
            break;
          case 'event_ended':
            fallback = formatEventEnded();
            break;
          case 'nothing_to_cancel':
            fallback = formatNothingToCancel(cmd.proxyName);
            break;
          default: {
            const _exhaustive: never = result;
            return _exhaustive;
          }
        }
      }
    }

    // 有成功行 → 一次 reply（G4）：摘要（同一則多文字行）+ 一次更新後名單 +（有遞補則）@ 通知。
    if (summary.length > 0 && lastView !== undefined) {
      const messages: messagingApi.Message[] = [
        toLineMessage(formatBatchSummary(summary)),
        toLineMessage(formatList(lastView)), // 批次僅對 open 生效 → phase 恆 live（預設）
      ];
      if (promotedRows.length > 0) {
        const notices = await Promise.all(promotedRows.map((row) => buildPromotionNotice(row)));
        messages.push(toLineMessage(formatPromotionNotice(notices)));
      }
      return messages;
    }

    // 無成功行：全 duplicate → 回空、不 reply（G9/AC-2）；否則呈現最後一筆原因一次。
    if (fallback !== undefined) return [toLineMessage(fallback)];
    return [];
  }

  async function handleEvent(event: WebhookEvent): Promise<messagingApi.Message[]> {
    // 僅處理群組來源的文字訊息事件；其餘一律忽略（不回覆、不 mark；沿用骨架）。
    if (event.type !== 'message' || event.message.type !== 'text') return [];
    if (event.source.type !== 'group') return [];
    const groupId = event.source.groupId;
    const userId = event.source.userId;
    if (userId === undefined) return [];
    const messageId = event.message.id;
    const text = event.message.text;

    // D-004 §3.3：先查 conversation_states 攔截進行中開團流程（per-user PK 隔離）。
    // 只有正在開團的 host 自己的訊息被攔截為流程答案；同群其他成員完全不受影響（AC-15）。
    // **D-004 errata（跨群語意，2026-08-18）**：攔截**必須**比對來源群——同一人在**別群**的發言
    // 不攔截，照走一般 dispatch（`+1`/`名單`/雜訊靜默各自正常），且原群那段流程原封保留
    // （不前進、不放棄）。domain 層另有同義防線（continueFlow/confirm/abort）。
    // **D-013 T-022**：conversation 以 `(group_id, line_user_id)` 為 PK，此處以 `(groupId, userId)`
    // 為查詢鍵 ⇒ 只可能撈到本群那一列；`conv.group_id === groupId` 因而恆成立，依 G3 保留為
    // 縱深防禦與回歸錨點。同一人在多群可各有一段流程，彼此並行不互相覆寫。
    // D-011：grouping session（state='grouping'）**不**在此攔截——它不吞任意訊息，
    // 交由 parseCommand 讓 `下一輪`（及其他指令）正常分派（AC-24 已知取捨：開團與分組 session 互斥）。
    // D-012：conversation 攔截優先於拆行——進行中開團流程仍以整段 text 走 continueFlow（批次不介入流程答案）。
    const conv = await deps.conversations.get(groupId, userId);
    if (conv !== undefined && conv.state !== 'grouping' && conv.group_id === groupId) {
      const hostDisplayName = await resolveDisplayName(groupId, userId);
      const result = await deps.eventService.continueFlow({
        groupId,
        executorLineUserId: userId,
        messageId,
        text,
        hostDisplayName,
      });
      return renderContinue(result);
    }

    // D-012：以 /\r?\n/ 拆行。行數 ≤1 → 現行單指令路徑（零回歸，G5）；行數 ≥2 → 批次路徑。
    const lines = text.split(/\r?\n/);
    if (lines.length >= 2) {
      return handleBatch(groupId, userId, messageId, lines);
    }
    return dispatchSingle(groupId, userId, messageId, text);
  }

  return { handleEvent };
}
