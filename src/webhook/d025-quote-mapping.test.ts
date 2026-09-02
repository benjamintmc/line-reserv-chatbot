import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import type { EventRow } from '../db/schema';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { createWebhookHandler, type WebhookHandler } from './handler';
import { handleMessages } from './__tests__/handle-messages';

/**
 * T-033b／D-025 §4.1：quote-reply → `message_event_map` 的**讀取**端（含 G14 跨群校驗）。
 *
 * 寫入端（`server.ts` 用 `sentMessages[].id`）與送出點枚舉見 `d029-emit-points.test.ts`。
 * 本檔一律以 repository 層直接構造映射列——測「讀到之後怎麼辦」，不依賴寫入路徑。
 */

const GX = 'G-x'; // 受測群組
const GY = 'G-y'; // 別群（AC-28 的資訊外洩來源）

const T_0815_0730 = '2999-08-14T23:30:00Z'; // 2999-08-15 07:30
const T_0920_0730 = '2999-09-19T23:30:00Z'; // 2999-09-20 07:30

function groupTextEvent(
  text: string,
  opts: { userId?: string; messageId?: string; groupId?: string; quotedMessageId?: string } = {},
): WebhookEvent {
  return {
    type: 'message',
    message: {
      type: 'text',
      id: opts.messageId ?? 'mid-1',
      text,
      ...(opts.quotedMessageId !== undefined ? { quotedMessageId: opts.quotedMessageId } : {}),
    },
    source: { type: 'group', groupId: opts.groupId ?? GX, userId: opts.userId ?? 'U-x' },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
}

function makeService(t: TestDb): RegistrationService {
  return new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    logError: () => {},
  });
}

function makeHandler(t: TestDb, service: RegistrationService): WebhookHandler {
  return createWebhookHandler({
    messageEventMap: t.messageEventMap,
    events: t.events,
    groups: t.groups,
    grouping: new GroupingService({
      events: t.events,
      users: t.users,
      registrations: t.registrations,
      conversations: t.conversations,
      processed: t.processed,
      runInTransaction: t.runInTransaction,
    }),
    service,
    eventService: new EventService({
      events: t.events,
      users: t.users,
      conversations: t.conversations,
      runInTransaction: t.runInTransaction,
      runImmediate: t.runImmediate,
      superAdminUserIds: [],
      logError: () => {},
    }),
    users: t.users,
    conversations: t.conversations,
    profile: { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: '王小明' }) },
  });
}

/** repository 層直接建一場 open 活動（開團側過渡期仍擋第二場，見 D-020 不變式 #1）。 */
async function mkEvent(
  t: TestDb,
  opts: { location: string; at: string; groupId?: string },
): Promise<EventRow> {
  const host = await t.users.upsert('U-host', '主辦人');
  return t.events.create({
    groupId: opts.groupId ?? GX,
    hostUserId: host.id,
    eventDatetime: opts.at,
    location: opts.location,
    capacity: 16,
    status: 'open',
  });
}

function textOf(msgs: messagingApi.Message[]): string {
  const m = msgs[0];
  if (m === undefined) return '';
  return (m as { text?: string }).text ?? '';
}

describe('D-025 機制 A：quote → message_event_map（讀取端 + G14 跨群校驗）', () => {
  let t: TestDb;
  let a: EventRow; // 旭陽球場 08/15
  let b: EventRow; // 東方球場 09/20
  let service: RegistrationService;
  let handler: WebhookHandler;

  beforeEach(async () => {
    t = await createTestDb();
    a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    b = await mkEvent(t, { location: '東方球場', at: T_0920_0730 });
    // 兩則「過去的 bot 訊息」各自屬於一場活動（正常情況由 server.ts 於 reply 後寫入）。
    await t.messageEventMap.record('bot-a', a.id);
    await t.messageEventMap.record('bot-b', b.id);
    service = makeService(t);
    handler = makeHandler(t, service);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-025 AC-13] 引用屬於活動 B 的 bot 訊息 + `+1`（無 selector）→ 報名到 B', async () => {
    await handleMessages(
      handler,
      groupTextEvent('+1', { messageId: 'm13', quotedMessageId: 'bot-b' }),
    );

    expect(await t.registrations.countConfirmed(b.id)).toBe(1);
    expect(await t.registrations.countConfirmed(a.id)).toBe(0);
  });

  it('[D-025 AC-14] 引用 A 的訊息但內文 `@東方 +1`（指向 B）→ 回衝突文案、不報名', async () => {
    const signupSpy = vi.spyOn(service, 'signup');
    const msgs = await handleMessages(
      handler,
      groupTextEvent('@東方 +1', { messageId: 'm14', quotedMessageId: 'bot-a' }),
    );

    expect(textOf(msgs)).toBe('回覆與內文球敘資訊不符，請修正再試');
    expect(signupSpy).not.toHaveBeenCalled();
    expect(await t.registrations.countConfirmed(a.id)).toBe(0);
    expect(await t.registrations.countConfirmed(b.id)).toBe(0);
  });

  it('[D-025 AC-15] 引用 A 的訊息且 `@旭陽` 也命中 A → 正常執行（不誤判 conflict）', async () => {
    await handleMessages(
      handler,
      groupTextEvent('@旭陽 +1', { messageId: 'm15', quotedMessageId: 'bot-a' }),
    );

    expect(await t.registrations.countConfirmed(a.id)).toBe(1);
    expect(await t.registrations.countConfirmed(b.id)).toBe(0);
  });

  it('[D-025 AC-28] 引用指向「別群」活動的映射 → 視為未引言，落既有 ambiguous，不外洩他群資訊', async () => {
    // 攻擊情境以資料層直接構造（LINE 用戶端實務上無法跨群引言，測試不依賴該限制）。
    const y = await mkEvent(t, { location: '桃園秘境球場', at: T_0815_0730, groupId: GY });
    await t.messageEventMap.record('bot-y', y.id);

    const signupSpy = vi.spyOn(service, 'signup');
    const msgs = await handleMessages(
      handler,
      groupTextEvent('+1', { messageId: 'm28', quotedMessageId: 'bot-y' }),
    );

    // 行為等同「群組 X 有 2 場、無引言、無 selector」。
    expect(textOf(msgs)).toBe('群組內有多場球敘進行中，請回覆或標註 @場地/@時間 以指定要操作的球敘');
    // 不含群組 Y 任一活動的場地／時間／id。
    const reply = textOf(msgs);
    expect(reply).not.toContain('桃園秘境球場');
    expect(reply).not.toContain('08-15');
    expect(reply).not.toContain(String(y.id));
    // 不呼叫任何 service、不誤判到 Y、不 markProcessed（D-026 具名例外 (b) 類）。
    expect(signupSpy).not.toHaveBeenCalled();
    expect(await t.registrations.countConfirmed(y.id)).toBe(0);
    expect(await t.processed.has('m28')).toBe(false);
  });

  it('[D-025 §4.1] 引用一則查無映射的訊息 → 等同沒有引言（不報錯、不特例）', async () => {
    const msgs = await handleMessages(
      handler,
      groupTextEvent('+1', { messageId: 'm-unknown', quotedMessageId: 'bot-never-seen' }),
    );

    expect(textOf(msgs)).toBe('群組內有多場球敘進行中，請回覆或標註 @場地/@時間 以指定要操作的球敘');
    expect(await t.registrations.countConfirmed(a.id)).toBe(0);
    expect(await t.registrations.countConfirmed(b.id)).toBe(0);
  });
});
