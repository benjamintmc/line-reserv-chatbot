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
import { parseCommand, splitSelector } from '../commands';
import type { InvalidReason, ParsedCommand } from '../commands/types';
import type { RegistrationRow } from '../db/schema';
import type { EventReader } from '../db/repositories/event-repository';
import { resolveTargetEvent } from '../domain/event-disambiguation';
import {
  formatAmbiguousEvent,
  formatEventConflict,
  formatEventNotFound,
  formatEventTooMany,
} from '../domain/disambiguation-formatter';
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
  EditEventRequest,
  EditEventResult,
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
  formatEditOk,
  formatEditHelp,
  formatEditCapacityRedirect,
  formatEditFormatError,
  formatEditPastDatetime,
  formatEditBadFee,
  formatEditNotAuthorized,
  formatEditClosedNotEditable,
  formatEditEventEnded,
  type EditMentionTarget,
} from '../domain/event-formatter';
import { nowIso } from '../db/time';
import {
  formatPartition,
  formatRound,
  formatInsufficientForRounds,
  formatNoGroupingSession,
  formatRoundsExhausted,
  formatGroupNotHost,
  formatGroupFormatHelp,
} from '../domain/grouping-formatter';
import { redactId } from '../log-redact';
import type { GroupRepository } from '../db/repositories/group-repository';

/**
 * D-012 §2.4：多行批次一次可執行的 +/-（signup/cancel）行數上限。
 * **只計可執行行**（空行/被忽略行不計）；超過 → 整則拒絕、不部分執行（G6）。
 */
const MAX_BATCH_LINES = 20;

/**
 * D-026 §5.2 `NEEDS_EVENT_SET`：需要「目標活動」才能執行的指令型別。其餘（my_id/confirm/abort/
 * `create_event_start`／`create_event_oneline`／`group_next`／`unknown`／非 edit_event 的 invalid
 * 皆屬此類）照舊分派——**不查候選、不消歧義**。
 *
 * `group_next`（`下一輪`）刻意不在集合內（G11）：目標活動完全由既有 grouping session 決定。
 */
const NEEDS_EVENT_SET: ReadonlySet<ParsedCommand['type']> = new Set([
  'signup',
  'cancel',
  'list',
  'add_capacity',
  'group',
  'close_event',
  'cancel_event',
  'edit_event',
  'edit_help',
]);

/**
 * 該指令是否需要先解出目標活動。
 * `invalid{command:'edit_event'}` 亦需要——它會被送進 `editEvent`（D-015 N4/G5，要回覆就要消費
 * message.id），故與 `edit_event` 同樣屬 `NEEDS_EVENT_SET`（D-026 §5.2 步驟 3 的「非 edit_event
 * 的 invalid」反面）。
 */
function needsEventResolution(cmd: ParsedCommand): boolean {
  if (cmd.type === 'invalid') return cmd.command === 'edit_event';
  return NEEDS_EVENT_SET.has(cmd.type);
}

/**
 * B1 修復（G14）：quote 解出的 eventId 必須先確認屬於當前群組，才可交給 `resolveTargetEvent`。
 * 不符/查無 → 視為未引言（undefined），不建立專屬錯誤訊息、不洩漏別群任何資訊。
 *
 * **跨群防線只設在此一處**：service 內 `getById(eventId)` 不重複比對 `group_id`。
 *
 * 相位（D-026）：機制 A（`message_event_map` 的**寫入**）屬 T-033b，故本批 `rawEventId` 恆為
 * `undefined`，本函式恆解出 `undefined`（＝「未引言」，落既有分支，無新行為）。
 */
async function resolveQuotedEventInGroup(
  rawEventId: number | undefined,
  groupId: string,
  events: EventReader,
): Promise<number | undefined> {
  if (rawEventId === undefined) return undefined;
  const row = await events.getById(rawEventId);
  return row !== undefined && row.group_id === groupId ? rawEventId : undefined;
}

/**
 * 取群組成員顯示名的最小介面（結構相容 `messagingApi.MessagingApiClient.getGroupMemberProfile`）。
 * 用群組成員 profile 而非 `getProfile`：後者對未加 bot 好友者 404（AC-19、NFR-4）。
 */
export interface GroupProfileClient {
  getGroupMemberProfile(groupId: string, userId: string): Promise<{ displayName: string }>;
}

/**
 * 取群組名稱摘要的最小介面（結構相容 `messagingApi.MessagingApiClient.getGroupSummary`）。
 * 純供人辨識 `groupId`（32 位十六進位，肉眼無法對應到實際群組），不參與任何邏輯。
 */
export interface GroupSummaryClient {
  getGroupSummary(groupId: string): Promise<{ groupName: string }>;
}

export interface WebhookHandlerDeps {
  service: RegistrationService;
  eventService: EventService;
  grouping: GroupingService;
  /**
   * D-026 §5.2：dispatch 層消歧義需要候選集合（`listActiveByGroup`）與跨群校驗（`getById`）。
   * 唯讀介面（pool-bound）；本層不寫任何 event。
   */
  events: EventReader;
  users: UserRepository;
  conversations: ConversationReader;
  profile: GroupProfileClient;
  /**
   * D-018：觸及與擴散觀測。**必填**——若做成選填，忘了接線時指標會靜默歸零，
   * 而「指標無聲少計」正是本案要消滅的問題（既有盲點見 D-018 §一）。
   */
  groups: GroupRepository;
  /**
   * D-018 §1.4：群組名稱快照來源。**選填**——名稱本就是 best-effort（取不到即 NULL，G1），
   * 「未接線」與「API 失敗」在資料上同義，故不強制注入；未提供時 `group_name` 一律留白。
   */
  groupSummary?: GroupSummaryClient;
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

/**
 * 跳脫**非本次 substitution 產生**的 `{`／`}`（資安 M4）。
 *
 * `textV2` 以 `{key}` 為佔位符，字面大括號須寫成 `{{`／`}}`。而顯示名與代報名字皆為使用者可控、
 * 且 `normalize` 明確保留非白名單字元 ⇒ `{`／`}` 會原樣進入訊息文字。不跳脫的後果有二：
 * ①`+1 {m0}` 之類可偽造成 @ 別人；②未配對的單一 `{` 會被 LINE API 直接拒絕
 * （`Single '{' encountered at index N`）⇒ **整則回覆漏送**，且是靜默的（只在伺服器留 log）。
 *
 * 僅套用於 mention 分支：純 `text` 訊息不解析佔位符，跳脫反而會多出括號。
 */
function escapeBraces(s: string): string {
  return s.replace(/\{/g, '{{').replace(/\}/g, '}}');
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
    out += escapeBraces(d.text.slice(cursor, m.index));
    out += `{${key}}`;
    substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: m.lineUserId } };
    cursor = m.index + m.length;
  });
  out += escapeBraces(d.text.slice(cursor));
  const msg: messagingApi.TextMessageV2 = { type: 'textV2', text: out, substitution };
  return msg;
}

export function createWebhookHandler(deps: WebhookHandlerDeps): WebhookHandler {
  const logError =
    deps.logError ??
    ((msg, meta): void => {
      console.error(msg, meta ?? {});
    });

  /**
   * D-018 §1.4：取一次群組名稱寫回 `groups.group_name`。
   *
   * **只在該群的列剛被新增時呼叫**（呼叫端以 recordSeen/recordJoin 的回傳值把關，G4）⇒
   * 每群一生最多一次 LINE API，不會落在每則訊息的熱路徑上。
   * 失敗即維持 NULL——名稱純供人辨識，取不到不影響任何指標（G1）。
   */
  async function fillGroupName(groupId: string): Promise<void> {
    if (deps.groupSummary === undefined) return;
    try {
      const summary = await deps.groupSummary.getGroupSummary(groupId);
      if (summary.groupName.length > 0) await deps.groups.setName(groupId, summary.groupName);
    } catch (err) {
      logError('getGroupSummary 失敗，group_name 留白（D-018 G1）', {
        group: redactId(groupId),
        err: String(err),
      });
    }
  }

  /**
   * D-018 §1.2：機器人被加入／被移出群組。
   *
   * **本函式永不拋出**（G1）——這是對 CLAUDE.md §4「不吞例外」的顯式申報偏離：觀測資料寫入
   * 失敗不得使報名／開團失效。既有 `resolveDisplayName` 的 best-effort 取名為同型先例。
   */
  async function recordGroupLifecycle(kind: 'join' | 'leave', groupId: string): Promise<void> {
    try {
      if (kind === 'leave') {
        await deps.groups.recordLeave(groupId);
        return;
      }
      if (await deps.groups.recordJoin(groupId)) await fillGroupName(groupId);
    } catch (err) {
      logError('groups 生命週期寫入失敗，已略過（D-018 G1）', {
        group: redactId(groupId),
        kind,
        err: String(err),
      });
    }
  }

  /**
   * D-018 §1.3：群組訊息路徑的首見補登。功能上線前既已在群的機器人不會再收到 join 事件，
   * 這是「加了機器人卻從未開團」的唯一觀測來源。
   *
   * 熱路徑成本為 **1 次 `INSERT … ON CONFLICT DO NOTHING`**（該路徑原已有 conversations.get，
   * 由 1 次往返增為 2 次）；名稱查詢只在真的新增列時觸發（G4）。同樣永不拋出（G1）。
   */
  async function recordGroupSeen(groupId: string): Promise<void> {
    try {
      if (await deps.groups.recordSeen(groupId, 'message')) await fillGroupName(groupId);
    } catch (err) {
      logError('groups 首見補登失敗，已略過（D-018 G1）', {
        group: redactId(groupId),
        err: String(err),
      });
    }
  }

  /** 取顯示名快照（AC-19、§7 fallback：getGroupMemberProfile → users.display_name → 「使用者」）。 */
  async function resolveDisplayName(groupId: string, userId: string): Promise<string> {
    try {
      const p = await deps.profile.getGroupMemberProfile(groupId, userId);
      if (p.displayName.length > 0) return p.displayName;
    } catch (err) {
      // M5：不記原始 groupId/userId（永久識別碼），改記雜湊——除錯只需可比對性。
      logError('getGroupMemberProfile 失敗，改用 fallback', {
        group: redactId(groupId),
        user: redactId(userId),
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
        const base = formatFlowPrompt(result.state, nowIso());
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
        return [toLineMessage(formatFieldError(result.state, nowIso()))]; // (C)
      case 'advanced':
        return [toLineMessage(formatFlowPrompt(result.state, nowIso()))]; // (A)
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

  // ── D-015 render（編輯活動資訊；單一則 reply，成功時同則附 @ 正取者） ──────────
  //
  // `users.getById` 的逐人解析刻意留在**這裡**（交易外、鎖已釋放），
  // 不進 domain 的 FOR UPDATE 區段（N5/G9），比照既有 buildPromotionNotice／renderAddCapacity。
  async function renderEdit(result: EditEventResult): Promise<messagingApi.Message[]> {
    switch (result.kind) {
      case 'duplicate':
        return []; // 重送：不回覆、不二次寫入
      case 'ok': {
        // G9：overflow 為真 → 整則退化，**不新增任何解析查詢**（連 users.getById 都不打）。
        const targets: EditMentionTarget[] = result.overflow
          ? []
          : await Promise.all(
              result.tagOwnerIds.map(async (id) => {
                const owner = await deps.users.getById(id);
                return {
                  displayName: owner?.display_name ?? '使用者',
                  lineUserId: owner?.line_user_id ?? null,
                };
              }),
            );
        return [toLineMessage(formatEditOk(result, targets))];
      }
      case 'help':
        return [toLineMessage(formatEditHelp(result.event, result.confirmedCount, result.now))];
      case 'capacity':
        return [toLineMessage(formatEditCapacityRedirect())];
      case 'format_error':
        // 時鐘於邊界層注入（formatter 不得自取，G7）；沿用既有 formatOnelineFormatHelp(nowIso()) 的作法。
        return [toLineMessage(formatEditFormatError(result.field, nowIso(), result.detail))];
      case 'bad_fee':
        return [toLineMessage(formatEditBadFee())];
      case 'past_datetime':
        return [toLineMessage(formatEditPastDatetime(result.now))];
      case 'not_authorized':
        return [toLineMessage(formatEditNotAuthorized())];
      case 'no_active':
        return [toLineMessage(formatNoActiveEvent())]; // (J) 沿用既有字串
      case 'closed_not_editable':
        return [toLineMessage(formatEditClosedNotEditable())];
      case 'event_ended':
        return [toLineMessage(formatEditEventEnded())];
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  /**
   * `invalid{command:'edit_event'}` 的原因碼 → 編輯專用格式錯的欄位（D-015 §1）。
   *
   * D-017：原簽名為 `(reason: string)` 且以 `return 'location'` 收尾——parser 日後為
   * `edit_event` 新增第 4 個原因碼時會**靜默套上錯誤的欄位文案**，編譯器不會有意見。
   * 改吃 `InvalidReason` 並窮舉：新增原因碼時 `_exhaustive` 會直接編譯失敗。
   */
  function editErrorField(reason: InvalidReason): 'date' | 'time' | 'location' {
    switch (reason) {
      case 'create_bad_date':
        return 'date';
      case 'create_bad_time':
        return 'time';
      case 'bad_location':
        return 'location';
      // 以下原因碼不會由 `編輯 …` 產生（只出現在開團／報名／分組路徑）。
      // 顯式列出而非以 default 吞掉，是為了讓「新增原因碼」這件事在此處現形。
      case 'count_out_of_range':
      case 'create_wrong_arity':
      case 'create_bad_capacity':
      case 'create_bad_price':
      case 'create_bad_venue_fee':
      case 'group_bad_args':
        return 'location';
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }

  function renderInvalidOneline(result: InvalidOnelineResult): messagingApi.Message[] {
    // D-006：開團全開 → InvalidOnelineResult 收斂為單一 format_help。
    switch (result.kind) {
      case 'format_help':
        return [toLineMessage(formatOnelineFormatHelp(nowIso()))]; // (K′)
      default: {
        const _exhaustive: never = result.kind;
        return _exhaustive;
      }
    }
  }

  /**
   * D-026 §5.2 消歧義結果：`ok` 帶目標活動（`undefined` = 候選數 0，由 service 沿用既有
   * 「查無 active」分支）；`reject` 為四種純判斷、無副作用的拒絕。
   */
  type EventResolution =
    | { kind: 'ok'; eventId: number | undefined }
    | { kind: 'reject'; messages: messagingApi.Message[] };

  /**
   * D-026 §5.2 步驟 4：解出這則訊息要作用在哪一場活動。
   *
   * `ambiguous`/`conflict`/`not_found`/`too_many` 一律**直接回覆、不呼叫任何 service、
   * 不 markProcessed**——這些是純判斷、零 DB 副作用的早退拒絕，屬 `CLAUDE.md` §4 去重政策的
   * **具名例外 (b) 類**（授權依據見 `design/D-026` 的 errata，2026-09-02 使用者裁決）。
   * 同型先例：`closeEvent`／`cancelEvent` 的 `not_authorized` 於 `event-service.ts:601-603`
   * early-return，早於 `this.tx` 內的 `markProcessed`。
   * 已知代價（接受，非缺陷）：LINE 重送時使用者會重複收到同一則提示。
   */
  async function resolveEventForCommand(
    groupId: string,
    selectorRaw: string | undefined,
  ): Promise<EventResolution> {
    const candidates = await deps.events.listActiveByGroup(groupId);
    // 相位：機制 A（message_event_map 寫入）屬 T-033b ⇒ 本批無引言來源，恆 undefined。
    const rawQuotedEventId: number | undefined = undefined;
    const quotedEventId = await resolveQuotedEventInGroup(rawQuotedEventId, groupId, deps.events);
    const resolution = resolveTargetEvent(candidates, quotedEventId, selectorRaw, nowIso());
    switch (resolution.kind) {
      case 'ambiguous':
        return { kind: 'reject', messages: [toLineMessage(formatAmbiguousEvent())] };
      case 'conflict':
        return { kind: 'reject', messages: [toLineMessage(formatEventConflict())] };
      case 'not_found':
        return {
          kind: 'reject',
          messages: [toLineMessage(formatEventNotFound(resolution.selectorRaw))],
        };
      case 'too_many':
        return {
          kind: 'reject',
          messages: [toLineMessage(formatEventTooMany(resolution.selectorRaw))],
        };
      case 'none':
        return { kind: 'ok', eventId: undefined };
      case 'single':
      case 'resolved':
        return { kind: 'ok', eventId: resolution.eventId };
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }
  }

  /**
   * 單指令分派（D-003~D-011 既有路徑）。多行批次以外一律走此（單行、或批次以外的分派）。
   * G5：`lines.length <= 1` 時必須走與此完全相同的路徑，行為不得改變。
   *
   * D-026 §5.2：`text` 為 `splitSelector` 切出的 `rest`（呼叫端已切；無 `@` 前綴時 `rest === 原文`
   * ⇒ 既有路徑零回歸），`selectorRaw` 為選擇器原文。需要目標活動的指令（`NEEDS_EVENT_SET`）
   * 先跑一次消歧義解出 `eventId` 再呼叫 service；其餘照舊分派、不查候選。
   */
  async function dispatchSingle(
    groupId: string,
    userId: string,
    messageId: string,
    text: string,
    selectorRaw?: string,
  ): Promise<messagingApi.Message[]> {
    const cmd = parseCommand(text);
    let eventId: number | undefined;
    if (needsEventResolution(cmd)) {
      const resolved = await resolveEventForCommand(groupId, selectorRaw);
      if (resolved.kind === 'reject') return resolved.messages;
      eventId = resolved.eventId;
    }
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
          eventId,
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
          eventId,
        });
        return renderCancel(result, cmd.proxyName);
      }
      case 'list': {
        const result = await deps.service.getListView({ groupId, messageId, eventId });
        return renderList(result);
      }
      // D-010：加開名額（`加開 N`）——service 內 canManageEvent 授權 + 鎖內加開遞補。
      case 'add_capacity': {
        const result = await deps.service.addCapacity({
          groupId,
          executorLineUserId: userId,
          messageId,
          count: cmd.count,
          eventId,
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
            eventId,
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
          eventId,
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
          eventId,
        });
        return renderClose(result);
      }
      case 'cancel_event': {
        // D-006：service 內 canManageEvent 判定；非授權回 (H′)。
        const result = await deps.eventService.cancelEvent({
          groupId,
          executorLineUserId: userId,
          messageId,
          eventId,
        });
        return renderCancelEvent(result);
      }
      case 'my_id':
        // D-006 §3：接線回 (MyID)——傳訊人自身 userId（群回、唯讀、不 mark）。
        return [toLineMessage(formatMyId(userId))];
      // D-015：編輯活動資訊。`人數` 轉導向請求（domain 零異動），其餘為單欄 set。
      case 'edit_event': {
        const request: EditEventRequest =
          cmd.field === 'capacity'
            ? { kind: 'capacity' }
            : { kind: 'set', field: cmd.field, value: cmd.value };
        return renderEdit(
          await deps.eventService.editEvent({
            groupId,
            executorLineUserId: userId,
            messageId,
            request,
            eventId,
          }),
        );
      }
      // D-015 N3：`edit_help` 也**必須**進 editEvent（要回覆就要消費 message.id，G5），
      // 不可在此直接組文案——現值來自鎖內權威重讀的 event。
      case 'edit_help': {
        return renderEdit(
          await deps.eventService.editEvent({
            groupId,
            executorLineUserId: userId,
            messageId,
            request: { kind: 'help' },
            eventId,
          }),
        );
      }
      case 'invalid': {
        // create_event 類 → 格式提示 (K′)；group 類 → 分組格式提示；signup/cancel/add_capacity 類 → 靜默（D-010 §一.1）。
        if (cmd.command === 'create_event') {
          const result = deps.eventService.handleInvalidOneline();
          return renderInvalidOneline(result);
        }
        if (cmd.command === 'group') {
          return [textMessage(formatGroupFormatHelp())];
        }
        // D-015 N4/G5：edit_event 類**不得**照抄下方 `return []`——那會「有回覆卻未消費 message.id」。
        // 一律送進 editEvent（轉 format_error），由 domain 在交易內先 markProcessed。
        if (cmd.command === 'edit_event') {
          const field = editErrorField(cmd.reason);
          const request: EditEventRequest =
            cmd.detail === undefined
              ? { kind: 'format_error', field }
              : { kind: 'format_error', field, detail: cmd.detail };
          return renderEdit(
            await deps.eventService.editEvent({
              groupId,
              executorLineUserId: userId,
              messageId,
              request,
              eventId,
            }),
          );
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
   *
   * D-026 §5.2：`lines` 為 `splitSelector` 切出的 `rest` 拆行結果（`splitSelector` 對整段原文
   * 只呼叫**一次**、且在拆行之前 ⇒「第一行 selector」的既定語意由換行穿越規則自然滿足）；
   * `resolveTargetEvent` 針對整批也只解一次，解出的 `eventId` 套用到批次內每一行
   * （**G12**：不支援批次內以第 2 行以後的 `@` 切換活動）。
   */
  async function handleBatch(
    groupId: string,
    userId: string,
    messageId: string,
    lines: string[],
    selectorRaw?: string,
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
    // **置於消歧義之前**：雜訊多行訊息不應查候選集合（熱路徑零新增查詢）。
    if (executables.length === 0) return [];

    // G12：整批只解一次目標活動；拒絕時整則短路（不呼叫任何 service、不 markProcessed、
    // 連 getGroupMemberProfile 都不打）。
    const resolved = await resolveEventForCommand(groupId, selectorRaw);
    if (resolved.kind === 'reject') return resolved.messages;
    const eventId = resolved.eventId;

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
          eventId,
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
          eventId,
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
    // D-018 §1.2：join/leave 只寫觀測資料，**一律不回覆、不 markProcessed**（G2）——屬 CLAUDE.md
    // §4 去重政策中「本來就不回覆」的例外路徑。非群組來源（1:1／room）一律不記（G7）。
    // D-003 §5 errata：原規格「非 text 事件一律忽略」自此僅適用於 message 類事件。
    if (event.type === 'join' || event.type === 'leave') {
      if (event.source.type === 'group') await recordGroupLifecycle(event.type, event.source.groupId);
      return [];
    }
    // 僅處理群組來源的文字訊息事件；其餘一律忽略（不回覆、不 mark；沿用骨架）。
    if (event.type !== 'message' || event.message.type !== 'text') return [];
    if (event.source.type !== 'group') return [];
    const groupId = event.source.groupId;
    const userId = event.source.userId;
    if (userId === undefined) return [];
    const messageId = event.message.id;
    const text = event.message.text;

    // D-018 §1.3：首見補登。置於指令分派**之前**——雜訊訊息同樣代表「機器人在這個群裡」，
    // 是「加了不用」的唯一訊號；若移到可識別指令之後，該類群組將永遠觀測不到。
    await recordGroupSeen(groupId);

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

    // D-026 §5.2 步驟 1：`splitSelector` 對整段原文呼叫**一次**，且在 D-012 既有拆行**之前**
    // （置於 conversation 攔截之後——開團問答/分組 session 的答案不吃 `@selector` 語法）。
    // 無 `@` 前綴時 `rest === text`（原樣不動）⇒ 既有拆行與分派路徑零回歸。
    const { selectorRaw, rest } = splitSelector(text);

    // D-012：以 /\r?\n/ 拆行。行數 ≤1 → 現行單指令路徑（零回歸，G5）；行數 ≥2 → 批次路徑。
    const lines = rest.split(/\r?\n/);
    if (lines.length >= 2) {
      return handleBatch(groupId, userId, messageId, lines, selectorRaw);
    }
    return dispatchSingle(groupId, userId, messageId, rest, selectorRaw);
  }

  return { handleEvent };
}
