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
// **LINE SDK 型別只在此層出現**（domain/formatter 對 LINE 零耦合）。嚴禁 any。
// unknown / 無流程 confirm·abort / 未攔截雜訊一律不回覆、不 markProcessed（G9）。

import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { parseCommand } from '../commands';
import type { RegistrationRow } from '../db/schema';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ConversationRepository } from '../db/repositories/conversation-repository';
import type {
  RegistrationService,
  SignupResult,
  CancelResult,
  ListResult,
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
import {
  formatSignup,
  formatCancel,
  formatList,
  formatNoOpenEvent,
  formatNothingToCancel,
  formatPromotionNotice,
  type MessageDescriptor,
  type PromotionNotice,
} from '../domain/list-formatter';
import {
  formatFlowPrompt,
  formatConfirmSummary,
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
  users: UserRepository;
  conversations: ConversationRepository;
  profile: GroupProfileClient;
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface WebhookHandler {
  /** 處理單一 WebhookEvent，回傳待 reply 的 LINE 訊息陣列（空陣列＝不回覆）。 */
  handleEvent(event: WebhookEvent): Promise<messagingApi.Message[]>;
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
    const existing = deps.users.getByLineUserId(userId);
    if (existing !== undefined) return existing.display_name;
    return '使用者';
  }

  /** 被遞補列 → 遞補通知（以 userRepo 解析 owner 的 line_user_id 與代報者稱謂；§4）。 */
  function buildPromotionNotice(row: RegistrationRow): PromotionNotice {
    const owner = deps.users.getById(row.owner_user_id);
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

  // ── D-003 render（不變） ─────────────────────────────────────────────
  function renderSignup(result: SignupResult): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
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

  function renderCancel(result: CancelResult, proxyName?: string): messagingApi.Message[] {
    switch (result.kind) {
      case 'no_open_event':
        return [toLineMessage(formatNoOpenEvent())];
      case 'duplicate':
        return [];
      case 'nothing_to_cancel':
        return [toLineMessage(formatNothingToCancel(proxyName))];
      case 'ok': {
        const messages = [toLineMessage(formatCancel(result))];
        if (result.promoted.length > 0) {
          const notices = result.promoted.map((row) => buildPromotionNotice(row));
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
        return [toLineMessage(formatList(result.view))];
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
      case 'flow_started':
        return [toLineMessage(formatFlowPrompt(result.state))]; // (A)
      case 'awaiting_confirm':
        return [toLineMessage(formatConfirmSummary(result.draft))]; // (B)
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
        return [toLineMessage(formatAlreadyClosed())]; // (J)
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
    const conv = deps.conversations.get(userId);
    if (conv !== undefined) {
      const hostDisplayName = await resolveDisplayName(groupId, userId);
      const result = deps.eventService.continueFlow({
        groupId,
        executorLineUserId: userId,
        messageId,
        text,
        hostDisplayName,
      });
      return renderContinue(result);
    }

    const cmd = parseCommand(text);
    switch (cmd.type) {
      case 'signup': {
        const displayName = await resolveDisplayName(groupId, userId);
        const result = deps.service.signup({
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
        const result = deps.service.cancel({
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
        const result = deps.service.getListView({ groupId, messageId });
        return renderList(result);
      }
      // D-004 M3 開團流程（D-006：開團全開，無授權前置） ────────────────
      case 'create_event_oneline': {
        const result = deps.eventService.handleOneline({
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
        const result = deps.eventService.startCreation({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderCreateEntry(result);
      }
      case 'confirm': {
        // 走到此代表無進行中流程（有流程已於上方攔截）→ 靜默 no-op（G9）。
        const result = deps.eventService.confirm({
          groupId,
          executorLineUserId: userId,
          messageId,
          hostDisplayName: '',
        });
        return renderConfirm(result);
      }
      case 'abort': {
        // 同上：無流程 → 靜默 no-op（G9）。
        const result = deps.eventService.abort({ executorLineUserId: userId, messageId });
        return renderAbort(result);
      }
      case 'close_event': {
        // D-006：service 內 canManageEvent 判定；非授權回 (H′)。
        const result = deps.eventService.closeEvent({
          groupId,
          executorLineUserId: userId,
          messageId,
        });
        return renderClose(result);
      }
      case 'cancel_event': {
        // D-006：service 內 canManageEvent 判定；非授權回 (H′)。
        const result = deps.eventService.cancelEvent({
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
        // create_event 類 → 格式提示 (K′)（D-006：開團全開，無非授權分支）；signup/cancel 類 → 靜默。
        if (cmd.command === 'create_event') {
          const result = deps.eventService.handleInvalidOneline();
          return renderInvalidOneline(result);
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

  return { handleEvent };
}
