import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent } from '@line/bot-sdk';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { createWebhookHandler, type GroupProfileClient, type WebhookHandler } from './handler';
import { redactId } from '../log-redact';

/**
 * 資安 M4（`textV2` 的 `{}` 未跳脫）與 M5（log 寫入永久識別碼）的回歸測試。
 */

function groupTextEvent(
  text: string,
  opts: { userId?: string; messageId?: string; groupId?: string } = {},
): WebhookEvent {
  return {
    type: 'message',
    message: { type: 'text', id: opts.messageId ?? 'mid-1', text },
    source: { type: 'group', groupId: opts.groupId ?? 'G', userId: opts.userId ?? 'U-x' },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
}

function makeHandler(
  t: TestDb,
  profile: GroupProfileClient,
  logError?: (msg: string, meta?: Record<string, unknown>) => void,
): WebhookHandler {
  return createWebhookHandler({
    groups: t.groups, // D-018：觀測依賴（必填）
    grouping: new GroupingService({
      events: t.events,
      users: t.users,
      registrations: t.registrations,
      conversations: t.conversations,
      processed: t.processed,
      runInTransaction: t.runInTransaction,
    }),
    service: new RegistrationService({
      events: t.events,
      users: t.users,
      registrations: t.registrations,
      processed: t.processed,
      runImmediate: t.runImmediate,
      logError: () => {},
      runInTransaction: t.runInTransaction,
    }),
    eventService: new EventService({
      events: t.events,
      users: t.users,
      registrations: t.registrations,
      conversations: t.conversations,
      processed: t.processed,
      runInTransaction: t.runInTransaction,
      runImmediate: t.runImmediate,
      superAdminUserIds: [],
    }),
    users: t.users,
    conversations: t.conversations,
    profile,
    logError,
  });
}

describe('資安 M4：textV2 大括號跳脫', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-016 AC-1] 使用者可控文字中的 { } 被跳脫為 {{ }}，不產生偽造佔位符', async () => {
    await seedEvent(t, { capacity: 1, groupId: 'G' });
    const handler = makeHandler(t, {
      getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: '代報者甲' }),
    });

    // 代報名字是使用者可控、且**落在 mention 範圍之外**的文字 ⇒ M4 的真實利用路徑。
    // 未跳脫時 `{m0}` 會被 LINE 當成第 0 個 mention 佔位符（冒名），或整則被 API 拒絕。
    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-a', messageId: 'ma' }));
    await handler.handleEvent(groupTextEvent('+1 {m0}壞人', { userId: 'U-w', messageId: 'mw' }));
    const out = await handler.handleEvent(groupTextEvent('-1', { userId: 'U-a', messageId: 'mc' }));

    const notice = out[out.length - 1]!;
    expect(notice.type).toBe('textV2');
    if (notice.type !== 'textV2') return;

    // 顯示名的括號已跳脫；真正的佔位符仍為單括號。
    expect(notice.text).toContain('{{m0}}壞人');
    const keys = Object.keys(notice.substitution ?? {});
    // 文字中的單括號佔位符數量 == substitution key 數量（無多餘、無遺漏）。
    const placeholders = notice.text.replace(/\{\{|\}\}/g, '').match(/\{[a-zA-Z0-9_]{1,20}\}/g) ?? [];
    expect(placeholders).toHaveLength(keys.length);
    for (const p of placeholders) {
      expect(keys).toContain(p.slice(1, -1));
    }
  });

  it('[D-016 AC-2] 無 mention 的純文字訊息不做跳脫（type=text 不解析佔位符）', async () => {
    const handler = makeHandler(t, {
      getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: 'X' }),
    });
    // 無進行中活動 → 純拒絕文案，type 應為 text。
    const out = await handler.handleEvent(groupTextEvent('+1', { userId: 'U-a', messageId: 'm0' }));
    expect(out[0]?.type).toBe('text');
  });
});

describe('資安 M5：log 識別碼去識別化', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-016 AC-3] redactId 產出穩定 8 位雜湊，且不等於原值', () => {
    const id = 'Uabcdef0123456789';
    expect(redactId(id)).toMatch(/^[0-9a-f]{8}$/);
    expect(redactId(id)).toBe(redactId(id)); // 可比對性：同一主體同一雜湊
    expect(redactId(id)).not.toBe(id);
    expect(redactId('U-other')).not.toBe(redactId(id));
    expect(redactId(undefined)).toBeUndefined();
    expect(redactId('')).toBeUndefined();
  });

  it('[D-016 AC-4] profile 失敗的錯誤 log 不含原始 groupId / userId', async () => {
    await seedEvent(t, { capacity: 5, groupId: 'G' });
    const logged: Record<string, unknown>[] = [];
    const handler = makeHandler(
      t,
      { getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('404 not friend')) },
      (_msg, meta) => {
        if (meta !== undefined) logged.push(meta);
      },
    );

    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-secret', messageId: 'm1' }));

    expect(logged.length).toBeGreaterThan(0);
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain('U-secret');
    expect(dump).not.toContain('"G"');
    expect(logged[0]!.user).toBe(redactId('U-secret'));
    expect(logged[0]!.group).toBe(redactId('G'));
  });
});
