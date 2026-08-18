import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent } from '@line/bot-sdk';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { createWebhookHandler, type GroupProfileClient, type WebhookHandler } from './handler';

// D-012 T-020：多行批次報名 handler 分派測試（AC-1..9）。
// 逐行 parseCommand、僅 signup/cancel 可執行、依序 await、複合去重鍵 `${id}#${lineIndex}`、
// 合併為一次 reply（≤5 則）；上限整則拒絕；單行零回歸；全 duplicate 不 reply。

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

function makeHandler(
  t: TestDb,
  opts: { service?: RegistrationService; profile: GroupProfileClient },
): WebhookHandler {
  const service = opts.service ?? makeService(t);
  return createWebhookHandler({
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
      superAdminUserIds: [],
      logError: () => {},
    }),
    users: t.users,
    conversations: t.conversations,
    profile: opts.profile,
  });
}

function profileReturning(name: string): GroupProfileClient {
  return { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: name }) };
}

/** out 內第一個 text/textV2 訊息的文字（測試斷言用）。 */
function textOf(msg: { type: string; text?: string }): string {
  return msg.text ?? '';
}

describe('webhook handler（D-012 §二/§三 多行批次報名）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-012 AC-1] +1 陳小姐\\n+1 張先生 → 兩次代報名（proxy）、一次 reply（摘要 + 名單）', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const handler = makeHandler(t, { service, profile: profileReturning('報名者') });

    const out = await handler.handleEvent(
      groupTextEvent('+1 陳小姐\n+1 張先生', { userId: 'U-x', messageId: 'm' }),
    );

    // 兩行各一次 signup，各 count=1、proxyName 分別、複合去重鍵 m#0 / m#1。
    expect(signupSpy).toHaveBeenCalledTimes(2);
    expect(signupSpy.mock.calls[0]![0]).toMatchObject({
      count: 1,
      proxyName: '陳小姐',
      messageId: 'm#0',
    });
    expect(signupSpy.mock.calls[1]![0]).toMatchObject({
      count: 1,
      proxyName: '張先生',
      messageId: 'm#1',
    });

    // 產生兩筆代報名。
    const confirmed = await t.registrations.listConfirmed(event.id);
    expect(confirmed).toHaveLength(2);
    expect(confirmed.every((r) => r.kind === 'proxy')).toBe(true);
    expect(confirmed.map((r) => r.display_name).sort()).toEqual(['張先生', '陳小姐']);

    // 一次 reply：摘要（D-012 §一.3 聚合為一行）+ 名單，共 2 則。
    expect(out).toHaveLength(2);
    expect(textOf(out[0]!)).toBe('已報名：陳小姐、張先生');
    expect(textOf(out[1]!)).toContain('報名名單（2/16）：');
  });

  it('[D-012 AC-2] 整則重送（同一 message.id）→ 每行各自 duplicate → 不新增列、回空不 reply', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('報名者') });

    const first = await handler.handleEvent(
      groupTextEvent('+1\n+1', { userId: 'U-x', messageId: 'm' }),
    );
    expect(first).toHaveLength(2); // 摘要 + 名單
    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(2);

    // 同一 message.id 重送 → m#0 / m#1 皆 duplicate。
    const second = await handler.handleEvent(
      groupTextEvent('+1\n+1', { userId: 'U-x', messageId: 'm' }),
    );
    expect(second).toEqual([]); // 全 duplicate → 回空、不 reply（G9）
    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(2); // 不新增
  });

  it('[D-012 AC-3] 混合行 +1 A\\n今天天氣真好\\n-1 → 只執行第1/3行、中間忽略、lineIndex 0/2 穩定', async () => {
    await seedEvent(t, { capacity: 16, groupId: 'G' });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const cancelSpy = vi.spyOn(service, 'cancel');
    const handler = makeHandler(t, { service, profile: profileReturning('報名者') });

    await handler.handleEvent(
      groupTextEvent('+1 A\n今天天氣真好\n-1', { userId: 'U-x', messageId: 'm' }),
    );

    // 中間非 +/- 行忽略（G1）；lineIndex 保留 → 複合鍵 m#0 / m#2。
    expect(signupSpy).toHaveBeenCalledTimes(1);
    expect(signupSpy.mock.calls[0]![0]).toMatchObject({ proxyName: 'A', messageId: 'm#0' });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy.mock.calls[0]![0]).toMatchObject({ messageId: 'm#2' });
  });

  it('[D-012 AC-4] 單行 +3（無換行）→ 走現行單指令路徑（零回歸；含活動摘要與名單、非複合鍵）', async () => {
    await seedEvent(t, { capacity: 16, groupId: 'G' });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const handler = makeHandler(t, { service, profile: profileReturning('王小明') });

    const out = await handler.handleEvent(groupTextEvent('+3', { userId: 'U-wang', messageId: 'm1' }));

    // 單行路徑：messageId 為原始 message.id（非複合鍵）。
    expect(signupSpy.mock.calls[0]![0].messageId).toBe('m1');
    expect(out).toHaveLength(1);
    expect(textOf(out[0]!)).toContain('已為「王小明」報名 3 位（正取）。');
    expect(textOf(out[0]!)).toContain('報名名單（3/16）：');
  });

  it('[D-012 AC-5] 中途容量填滿：capacity 1、+1\\n+1 → 第1行正取、第2行整批候補（無超賣）', async () => {
    const { event } = await seedEvent(t, { capacity: 1, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('阿明') });

    const out = await handler.handleEvent(
      groupTextEvent('+1\n+1', { userId: 'U-x', messageId: 'm' }),
    );

    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(1); // 無超賣
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(1);
    // 摘要：聚合一行，第2位落候補者自己標「（候補）」。
    expect(textOf(out[0]!)).toBe('已報名：阿明、阿明（候補）');
  });

  it('[D-012 AC-6] -1 A\\n-1 B 兩行 cancel 皆執行（各以複合鍵去重）', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('報名者') });

    // 先由 U-x 代報 A、B 各一位。
    await handler.handleEvent(groupTextEvent('+1 A', { userId: 'U-x', messageId: 'a1' }));
    await handler.handleEvent(groupTextEvent('+1 B', { userId: 'U-x', messageId: 'b1' }));
    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(2);

    const service = makeService(t);
    // 用同一 t 的新 handler 附 spy 驗複合鍵。
    const cancelSpy = vi.spyOn(service, 'cancel');
    const handler2 = makeHandler(t, { service, profile: profileReturning('報名者') });
    await handler2.handleEvent(groupTextEvent('-1 A\n-1 B', { userId: 'U-x', messageId: 'c' }));

    expect(cancelSpy).toHaveBeenCalledTimes(2);
    expect(cancelSpy.mock.calls[0]![0]).toMatchObject({ proxyName: 'A', messageId: 'c#0' });
    expect(cancelSpy.mock.calls[1]![0]).toMatchObject({ proxyName: 'B', messageId: 'c#1' });
    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(0);
  });

  it('[D-012 AC-7] 可執行行數 > MAX_BATCH_LINES(20) → 整則拒絕、未執行任何行、無 markProcessed', async () => {
    await seedEvent(t, { capacity: 100, groupId: 'G' });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const handler = makeHandler(t, { service, profile: profileReturning('阿明') });

    const text21 = Array.from({ length: 21 }, () => '+1').join('\n');
    const out = await handler.handleEvent(groupTextEvent(text21, { userId: 'U-x', messageId: 'm' }));

    expect(out).toHaveLength(1);
    expect(textOf(out[0]!)).toBe('一次最多報名 20 筆，請分次輸入。');
    expect(signupSpy).not.toHaveBeenCalled(); // 不部分執行（G6）
    expect(await t.processed.has('m#0')).toBe(false);
  });

  it('[D-012 AC-7] 恰 20 可執行行 → 正常執行', async () => {
    const { event } = await seedEvent(t, { capacity: 100, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('阿明') });

    const text20 = Array.from({ length: 20 }, () => '+1').join('\n');
    const out = await handler.handleEvent(groupTextEvent(text20, { userId: 'U-x', messageId: 'm' }));

    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(20);
    expect(out).toHaveLength(2); // 摘要 + 名單
  });

  it('[D-012 AC-8] part-resend：第1行已 commit+mark、第2行未達 → 重送 → 第1行 dup、第2行首次執行（不重複）', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const service = makeService(t);
    const handler = makeHandler(t, { service, profile: profileReturning('阿明') });

    // 模擬半途中斷：第1行（m#0）已成功 commit + markProcessed，第2行尚未執行。
    await service.signup({
      groupId: 'G',
      executorLineUserId: 'U-x',
      executorDisplayName: '阿明',
      messageId: 'm#0',
      count: 1,
    });
    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(1);
    expect(await t.processed.has('m#0')).toBe(true);

    // 整則重送：m#0 → duplicate 略過；m#1 → 首次執行成功。
    const out = await handler.handleEvent(
      groupTextEvent('+1\n+1', { userId: 'U-x', messageId: 'm' }),
    );

    expect(await t.registrations.listConfirmed(event.id)).toHaveLength(2); // 各 1 筆、不重複
    // 只有第2行產生摘要行（第1行 duplicate 不產摘要）。
    expect(textOf(out[0]!)).toBe('已報名：阿明');
  });

  it('[D-012 AC-9] +1 陳小姐\\n+1 陳小姐 → index 0/1 為不同鍵 → 皆執行，roster 顯示「陳小姐」「陳小姐(2)」', async () => {
    const { event } = await seedEvent(t, { capacity: 16, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('報名者') });

    const out = await handler.handleEvent(
      groupTextEvent('+1 陳小姐\n+1 陳小姐', { userId: 'U-x', messageId: 'm' }),
    );

    const confirmed = await t.registrations.listConfirmed(event.id);
    expect(confirmed).toHaveLength(2); // 刻意兩人，非重複 bug
    // 名單以 roster 後綴消歧同一人的多名額。
    expect(textOf(out[1]!)).toContain('陳小姐(2)');
  });

  it('多行全為非 signup/cancel（名單\\n名單）→ 忽略、回空不 reply', async () => {
    await seedEvent(t, { capacity: 16, groupId: 'G' });
    const handler = makeHandler(t, { profile: profileReturning('X') });
    const out = await handler.handleEvent(
      groupTextEvent('名單\n名單', { userId: 'U-x', messageId: 'm' }),
    );
    expect(out).toEqual([]);
  });
});
