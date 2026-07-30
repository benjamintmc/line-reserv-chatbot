// src/webhook/handler.ts
//
// D-003 §6：webhook 接線。從 LINE WebhookEvent 抽 groupId/userId/messageId/text →
// parseCommand → 依 type 窮舉分派 → 取名（getGroupMemberProfile）→ 呼叫 service →
// 呼叫 formatter → 組出 messagingApi.Message[]（含 mention）。
//
// **LINE SDK 型別只在此層出現**（domain/formatter 對 LINE 零耦合）。嚴禁 any（G11）。
// unknown 一律不回覆、不 markProcessed（G5）。

import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { parseCommand } from '../commands';
import type { RegistrationRow } from '../db/schema';
import type { UserRepository } from '../db/repositories/user-repository';
import type {
  RegistrationService,
  SignupResult,
  CancelResult,
  ListResult,
} from '../domain/registration-service';
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

/**
 * 取群組成員顯示名的最小介面（結構相容 `messagingApi.MessagingApiClient.getGroupMemberProfile`）。
 * 用群組成員 profile 而非 `getProfile`：後者對未加 bot 好友者 404（AC-19、NFR-4）。
 */
export interface GroupProfileClient {
  getGroupMemberProfile(groupId: string, userId: string): Promise<{ displayName: string }>;
}

export interface WebhookHandlerDeps {
  service: RegistrationService;
  users: UserRepository;
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

  async function handleEvent(event: WebhookEvent): Promise<messagingApi.Message[]> {
    // 僅處理群組來源的文字訊息事件；其餘一律忽略（不回覆、不 mark；沿用骨架）。
    if (event.type !== 'message' || event.message.type !== 'text') return [];
    if (event.source.type !== 'group') return [];
    const groupId = event.source.groupId;
    const userId = event.source.userId;
    if (userId === undefined) return [];
    const messageId = event.message.id;
    const text = event.message.text;

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
      // M3 / D-004 開團流程；M4 我的ID → M2 一律 no-op（不回覆、不 mark）。
      case 'create_event_oneline':
      case 'create_event_start':
      case 'confirm':
      case 'abort':
      case 'close_event':
      case 'cancel_event':
      case 'my_id':
        return [];
      // invalid：signup/cancel 類靜默；create 類格式提示屬 M3（M2 no-op）。unknown 不回覆（G5）。
      case 'invalid':
      case 'unknown':
        return [];
      default: {
        const _exhaustive: never = cmd;
        return _exhaustive;
      }
    }
  }

  return { handleEvent };
}
