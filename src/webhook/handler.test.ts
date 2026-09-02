import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { createWebhookHandler, type GroupProfileClient, type WebhookHandler } from './handler';
import { GroupingService } from '../domain/grouping-service';

/** 建立群組文字訊息事件（測試用最小 shape）。 */
function makeGroupingSvc(t: TestDb): GroupingService {
  return new GroupingService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: t.runInTransaction,
  });
}

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

function makeEventService(t: TestDb, superAdminUserIds: string[] = []): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds,
    logError: () => {},
  });
}

/** 組裝 handler（D-003 分派測試預設不需 host 白名單；D-004 測試另傳）。 */
function makeHandler(
  t: TestDb,
  opts: { service?: RegistrationService; profile: GroupProfileClient; superAdminUserIds?: string[] },
): WebhookHandler {
  const service = opts.service ?? makeService(t);
  return createWebhookHandler({
    events: t.events, // D-026 §5.2：dispatch 消歧義的候選集合來源
    groups: t.groups, // D-018：觀測依賴（必填）
    grouping: makeGroupingSvc(t),
    service,
    eventService: makeEventService(t, opts.superAdminUserIds ?? []),
    users: t.users,
    conversations: t.conversations,
    profile: opts.profile,
  });
}

function profileReturning(name: string): GroupProfileClient {
  return { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: name }) };
}

describe('webhook handler（D-003 §6 分派）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-003 AC-10] unknown（閒聊）→ 回空陣列、不呼叫 profile、不 markProcessed', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G' });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const profile = profileReturning('任何人');
    const handler = makeHandler(t, { service, profile });

    const out = await handler.handleEvent(groupTextEvent('今天天氣真好', { messageId: 'mx' }));
    expect(out).toEqual([]);
    expect(profile.getGroupMemberProfile).not.toHaveBeenCalled();
    expect(signupSpy).not.toHaveBeenCalled();
    expect(await t.processed.has('mx')).toBe(false);
  });

  it('[D-003 AC-15] +99（invalid signup count_out_of_range）→ 靜默不回覆', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G' });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const handler = makeHandler(t, { service, profile: profileReturning('X') });

    const out = await handler.handleEvent(groupTextEvent('+99', { messageId: 'mv' }));
    expect(out).toEqual([]);
    expect(signupSpy).not.toHaveBeenCalled();
    expect(await t.processed.has('mv')).toBe(false);
  });

  it('[D-003 AC-19] 以 getGroupMemberProfile 取群組顯示名並存為快照（非 getProfile）', async () => {
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G' });
    const profile = profileReturning('群組顯示名');
    const handler = makeHandler(t, { profile });

    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-new', messageId: 'm1' }));
    expect(profile.getGroupMemberProfile).toHaveBeenCalledWith('G', 'U-new');
    // 快照存入 registrations（display_name）與 users。
    const confirmed = await t.registrations.listConfirmed(event.id);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.display_name).toBe('群組顯示名');
    expect((await t.users.getByLineUserId('U-new'))!.display_name).toBe('群組顯示名');
  });

  it('[D-003 AC-19] 取名失敗 fallback：既有 users.display_name → 否則「使用者」', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G' });
    const service = makeService(t);
    const failing: GroupProfileClient = {
      getGroupMemberProfile: vi.fn().mockRejectedValue(new Error('404 not friend')),
    };
    const handler = createWebhookHandler({
    events: t.events, // D-026 §5.2：dispatch 消歧義的候選集合來源
    groups: t.groups, // D-018：觀測依賴（必填）
    grouping: makeGroupingSvc(t),
      service,
      eventService: makeEventService(t),
      users: t.users,
      conversations: t.conversations,
      profile: failing,
      logError: () => {},
    });

    // 既有快照存在 → 用之。
    await t.users.upsert('U-known', '舊名快照');
    const signupSpy = vi.spyOn(service, 'signup');
    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-known', messageId: 'm1' }));
    expect(signupSpy.mock.calls[0]![0].executorDisplayName).toBe('舊名快照');

    // 無既有快照 → 「使用者」。
    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-nobody', messageId: 'm2' }));
    expect(signupSpy.mock.calls[1]![0].executorDisplayName).toBe('使用者');
  });

  it('[D-003 AC-14] 取消觸發遞補 → 追加 textV2 訊息、substitution 含被遞補者 userId', async () => {
    await seedEvent(t, { capacity: 1, groupId: 'G' }); // host = U-host
    const handler = makeHandler(t, { profile: profileReturning('報名者') });

    // A 佔滿唯一正取，W 進候補。
    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-a', messageId: 'ma' }));
    await handler.handleEvent(groupTextEvent('+1', { userId: 'U-w', messageId: 'mw' }));
    // A 取消 → 釋出、W 遞補。
    const out = await handler.handleEvent(groupTextEvent('-1', { userId: 'U-a', messageId: 'mc' }));

    expect(out).toHaveLength(2); // 取消名單 + 遞補通知
    const notice = out[1]!;
    expect(notice.type).toBe('textV2');
    if (notice.type !== 'textV2') return;
    const subs = notice.substitution ?? {};
    const targets = Object.values(subs)
      .filter((s): s is messagingApi.MentionSubstitutionObject => s.type === 'mention')
      .map((s) => (s.mentionee.type === 'user' ? s.mentionee.userId : undefined));
    expect(targets).toContain('U-w'); // 被遞補者 W 的 line userId
  });

  it('[D-003 AC-10] 非群組來源 / 非文字事件一律忽略', async () => {
    const handler = makeHandler(t, { profile: profileReturning('X') });
    const sticker = { type: 'message', message: { type: 'sticker', id: '1' }, source: { type: 'group', groupId: 'G', userId: 'U' }, replyToken: 'rt' } as unknown as WebhookEvent;
    const oneToOne = { type: 'message', message: { type: 'text', id: '2', text: '+1' }, source: { type: 'user', userId: 'U' }, replyToken: 'rt' } as unknown as WebhookEvent;
    expect(await handler.handleEvent(sticker)).toEqual([]);
    expect(await handler.handleEvent(oneToOne)).toEqual([]);
  });

  it('signup 正常回覆為單一文字訊息（含活動摘要與名單）', async () => {
    await seedEvent(t, { capacity: 16, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('王小明') });
    const out = await handler.handleEvent(groupTextEvent('+3', { userId: 'U-wang', messageId: 'm1' }));
    expect(out).toHaveLength(1);
    const msg = out[0]!;
    expect(msg.type).toBe('text');
    if (msg.type !== 'text') return;
    expect(msg.text).toContain('已為「王小明」報名 3 位（正取）。');
    expect(msg.text).toContain('報名名單（3/16）：');
  });

  it('list 重送（相同 message_id）→ 第二次不回覆（唯讀去重）', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('X') });
    const first = await handler.handleEvent(groupTextEvent('名單', { messageId: 'ml' }));
    const second = await handler.handleEvent(groupTextEvent('名單', { messageId: 'ml' }));
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
  // ── D-011 errata 2026-08-18（T-018 review B1/B2）：分組接線 ────────────────
  it('[D-011 AC-24 errata 去重] 分組（策略A）重送相同 message_id → 第二次回空（不重算、不二次回覆）', async () => {
    const { event, host } = await seedEvent(t, { capacity: 8, groupId: 'G', hostLineId: 'U-host' });
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      await t.registrations.insertSlot({
        eventId: event.id,
        ownerUserId: host.id,
        displayName: name,
        kind: 'proxy',
        status: 'confirmed',
      });
    }
    const handler = makeHandler(t, { profile: profileReturning('主辦人') });
    const first = await handler.handleEvent(
      groupTextEvent('分組', { userId: 'U-host', messageId: 'gp' }),
    );
    expect(first).toHaveLength(1);
    expect((first[0] as messagingApi.TextMessage).text).toContain('第 1 組：');

    const second = await handler.handleEvent(
      groupTextEvent('分組', { userId: 'U-host', messageId: 'gp' }),
    );
    expect(second).toEqual([]); // 重送不再回覆（避免第二份不同分組）
  });

  it('[D-011 AC-23 errata 跨群] A 群開分組後於 B 群「下一輪」→ 回「沒有進行中的分組」、不外洩 A 群名單', async () => {
    const { event, host } = await seedEvent(t, { capacity: 8, groupId: 'G', hostLineId: 'U-host' });
    for (const name of ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']) {
      await t.registrations.insertSlot({
        eventId: event.id,
        ownerUserId: host.id,
        displayName: name,
        kind: 'proxy',
        status: 'confirmed',
      });
    }
    const handler = makeHandler(t, { profile: profileReturning('主辦人') });
    const started = await handler.handleEvent(
      groupTextEvent('分組 2場', { userId: 'U-host', messageId: 'gr1' }),
    );
    expect((started[0] as messagingApi.TextMessage).text).toContain('第 1 輪');

    const crossOut = await handler.handleEvent(
      groupTextEvent('下一輪', { userId: 'U-host', messageId: 'gr2', groupId: 'G-B' }),
    );
    const crossText = (crossOut[0] as messagingApi.TextMessage).text;
    expect(crossText).toContain('目前沒有進行中的分組');
    for (const name of ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']) {
      expect(crossText).not.toContain(name); // A 群凍結名單零外洩
    }

    // 回 A 群 `下一輪` → 正常第 2 輪。
    const aOut = await handler.handleEvent(
      groupTextEvent('下一輪', { userId: 'U-host', messageId: 'gr3' }),
    );
    expect((aOut[0] as messagingApi.TextMessage).text).toContain('第 2 輪');
  });
});
