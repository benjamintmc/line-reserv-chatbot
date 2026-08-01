import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent } from '@line/bot-sdk';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { createWebhookHandler, type GroupProfileClient, type WebhookHandler } from './handler';
import { formatMyId } from '../domain/event-formatter';

/**
 * D-006 授權簡化 handler/整合 Acceptance Checks：
 * [D-006 AC-9] 我的ID 接線、[D-006 AC-11] 開團後 M2 報名銜接（開團全開）。
 */

const G = 'G';

function groupTextEvent(
  text: string,
  opts: { userId?: string; messageId?: string; groupId?: string } = {},
): WebhookEvent {
  return {
    type: 'message',
    message: { type: 'text', id: opts.messageId ?? 'mid-1', text },
    source: { type: 'group', groupId: opts.groupId ?? G, userId: opts.userId ?? 'U-x' },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
}

function profileReturning(name: string): GroupProfileClient {
  return { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: name }) };
}

function makeHandler(t: TestDb, profile: GroupProfileClient, superAdmins: string[] = []): WebhookHandler {
  const service = new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    logError: () => {},
  });
  const eventService = new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds: superAdmins,
    logError: () => {},
  });
  return createWebhookHandler({
    service,
    eventService,
    users: t.users,
    conversations: t.conversations,
    profile,
  });
}

function textOf(msgs: Awaited<ReturnType<WebhookHandler['handleEvent']>>): string {
  const m = msgs[0];
  if (m === undefined || m.type !== 'text') return '';
  return m.text;
}

describe('webhook handler 授權簡化（D-006）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-006 AC-9] 我的ID → (MyID) 含傳訊人自身 userId、不 mark、無 DB 副作用（不呼叫 profile）', async () => {
    const profile = profileReturning('任何人');
    const handler = makeHandler(t, profile);
    const out = await handler.handleEvent(groupTextEvent('我的ID', { userId: 'U-me', messageId: 'mid9' }));
    expect(out).toHaveLength(1);
    expect(textOf(out)).toBe(formatMyId('U-me').text);
    expect(textOf(out)).toContain('你的 LINE 使用者 ID');
    expect(textOf(out)).toContain('U-me');
    // 唯讀、無副作用：不 mark、不寫 users、不呼叫 profile。
    expect(await t.processed.has('mid9')).toBe(false);
    expect(await t.users.getByLineUserId('U-me')).toBeUndefined();
    expect(profile.getGroupMemberProfile).not.toHaveBeenCalled();
  });

  it('[D-006 AC-9] 小寫「我的id」亦回 (MyID)', async () => {
    const handler = makeHandler(t, profileReturning('X'));
    const out = await handler.handleEvent(groupTextEvent('我的id', { userId: 'U-abc', messageId: 'mid9b' }));
    expect(textOf(out)).toContain('U-abc');
  });

  it('[D-006 AC-11] 一般成員開團（全開）→ 確認 open 後成員 +2 可報名（主辦 1 + 2 = 3/16）', async () => {
    // 無 super-admin：驗證開團全開下完整銜接 M2。
    const handler = makeHandler(t, profileReturning('主辦人'), []);
    const X = 'U-plain'; // 一般成員（非 super-admin）
    const summary = await handler.handleEvent(
      groupTextEvent('開團 2026/08/15 07:30 東方球場 16人 2200元', { userId: X, messageId: 'o1' }),
    );
    expect(textOf(summary)).toContain('請確認開團資訊');
    const announce = await handler.handleEvent(groupTextEvent('確認', { userId: X, messageId: 'o2' }));
    expect(textOf(announce)).toContain('開團成功');
    const event = await t.events.findActiveByGroup(G);
    expect(event?.status).toBe('open');
    expect(await t.registrations.countConfirmed(event!.id)).toBe(1); // 主辦自動第 1 正取

    const signup = await handler.handleEvent(groupTextEvent('+2', { userId: 'U-m', messageId: 'o3' }));
    expect(textOf(signup)).toContain('報名名單（3/16）');
    expect(await t.registrations.countConfirmed(event!.id)).toBe(3);
  });
});
