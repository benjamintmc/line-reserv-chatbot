import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent } from '@line/bot-sdk';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { createWebhookHandler, type GroupProfileClient, type WebhookHandler } from './handler';
import { GroupingService } from '../domain/grouping-service';

const HOST = 'U-host';
const G = 'G';

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
    source: { type: 'group', groupId: opts.groupId ?? G, userId: opts.userId ?? HOST },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
}

function profileReturning(name: string): GroupProfileClient {
  return { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: name }) };
}

function makeHandler(t: TestDb, superAdminUserIds: string[] = [HOST]): WebhookHandler {
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
    superAdminUserIds,
    logError: () => {},
  });
  return createWebhookHandler({
    grouping: makeGroupingSvc(t),
    service,
    eventService,
    users: t.users,
    conversations: t.conversations,
    profile: profileReturning('主辦人'),
  });
}

function textOf(msgs: Awaited<ReturnType<WebhookHandler['handleEvent']>>): string {
  const m = msgs[0];
  if (m === undefined || m.type !== 'text') return '';
  return m.text;
}

describe('webhook handler（D-004 §9 開團接線）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-004 AC-2] 白名單 host「開團 缺欄位」→ 格式提示 (K′)、不寫 conversation、不 INSERT', async () => {
    const handler = makeHandler(t);
    const out = await handler.handleEvent(groupTextEvent('開團 只有一個參數', { messageId: 'm1' }));
    expect(textOf(out)).toContain('格式：開團');
    expect(await t.conversations.get(HOST)).toBeUndefined();
    expect(await t.events.findActiveByGroup(G)).toBeUndefined();
    expect(await t.processed.has('m1')).toBe(false);
  });

  it('[D-004 AC-2 errata(2026-07-31 D-006 #7)] 非 super-admin「開團 缺欄位」→ 格式提示 (K′)（開團全開，無非授權分支）', async () => {
    const handler = makeHandler(t, []); // 無 super-admin：開團仍全開
    const out = await handler.handleEvent(groupTextEvent('開團 只有一個參數', { userId: 'U-bad', messageId: 'm1' }));
    expect(textOf(out)).toContain('格式：開團');
  });

  it('[D-004 AC-15] mid-flow per-user 隔離：host 開團中，成員 +1 照走 D-003（不被當作答案）', async () => {
    const handler = makeHandler(t);
    // host 啟動逐步問答 → awaiting_date。
    const start = await handler.handleEvent(groupTextEvent('開團', { userId: HOST, messageId: 'h0' }));
    expect(textOf(start)).toContain('請輸入活動日期');
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_date');

    // 成員 B（無 conversation）+1 → 走 signup 分派；此時無 open 活動 → 回定型句（D-003 處理）。
    const bOut = await handler.handleEvent(groupTextEvent('+1', { userId: 'U-b', messageId: 'b0' }));
    expect(textOf(bOut)).toBe('目前沒有開放報名的活動');
    // host 的流程未被 B 的訊息影響。
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_date');
    expect(JSON.parse((await t.conversations.get(HOST))!.payload ?? '{}').date).toBeUndefined();

    // host 下一則才是 date 答案 → 前進（D-005 中性化：提問為「請輸入時間」）。
    const dateOut = await handler.handleEvent(groupTextEvent('2999/08/15', { userId: HOST, messageId: 'h1' }));
    expect(textOf(dateOut)).toContain('請輸入時間');
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_time');
  });

  it('[D-004 AC-18 / D-005 AC-3] 開團（一行式→確認→open）後主辦佔第 1 位，成員 +2 可報名（3/16）', async () => {
    const handler = makeHandler(t);
    // 一行式 → 確認摘要 (B)。
    const summary = await handler.handleEvent(
      groupTextEvent('開團 2999/08/15 07:30 東方球場 16人 2200元', { userId: HOST, messageId: 'o1' }),
    );
    expect(textOf(summary)).toContain('請確認開團資訊');
    // 確認 → 開團公告 (D)（走 conversation 攔截 → continueFlow confirm）。
    const announce = await handler.handleEvent(groupTextEvent('確認', { userId: HOST, messageId: 'o2' }));
    expect(textOf(announce)).toContain('開團成功');
    const event = await t.events.findActiveByGroup(G);
    expect(event?.status).toBe('open');
    // D-005 §3：主辦自動登記為第 1 正取。
    expect(await t.registrations.countConfirmed(event!.id)).toBe(1);

    // 成員 +2 → D-003 signup 正常（主辦 1 + 成員 2 = 3）。
    const signup = await handler.handleEvent(groupTextEvent('+2', { userId: 'U-m', messageId: 'o3' }));
    expect(textOf(signup)).toContain('報名名單（3/16）');
    expect(await t.registrations.countConfirmed(event!.id)).toBe(3);
  });

  it('[D-004 AC-16] 無流程時 confirm/abort 經 handler → 空陣列', async () => {
    const handler = makeHandler(t);
    expect(await handler.handleEvent(groupTextEvent('確認', { messageId: 'c' }))).toEqual([]);
    expect(await handler.handleEvent(groupTextEvent('取消', { messageId: 'a' }))).toEqual([]);
  });

  it('[D-004 AC-8] 關閉報名經 handler → (E) 回覆', async () => {
    const handler = makeHandler(t);
    await handler.handleEvent(groupTextEvent('開團 2999/08/15 07:30 東方球場 16人 2200元', { messageId: 'o1' }));
    await handler.handleEvent(groupTextEvent('確認', { messageId: 'o2' }));
    const out = await handler.handleEvent(groupTextEvent('關閉報名', { messageId: 'o3' }));
    expect(textOf(out)).toContain('報名已截止');
  });
  // ── D-004 errata（跨群語意，2026-08-18；使用者回報之 bug）─────────────────
  // conversation_states 以 line_user_id 為 PK（跨群唯一）。攔截必須再比對來源群：
  // 同一人在 A 群開團到一半，於 B 群的發言**不得**被當成 A 群流程的答案。
  it('[D-004 errata 跨群] A 群開團中，同一人在 B 群 +1 → 不被攔截、照走 signup；A 群流程原封保留', async () => {
    const handler = makeHandler(t);
    await seedEvent(t, { capacity: 16, groupId: 'G-B', hostLineId: 'U-other-host' });

    // A 群（G）啟動逐步問答 → awaiting_date。
    const start = await handler.handleEvent(groupTextEvent('開團', { userId: HOST, messageId: 'a0' }));
    expect(textOf(start)).toContain('請輸入活動日期');
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_date');

    // 同一人在 B 群 +1 → 走 D-003 signup（非流程答案）。
    const bOut = await handler.handleEvent(
      groupTextEvent('+1', { userId: HOST, messageId: 'b0', groupId: 'G-B' }),
    );
    expect(textOf(bOut)).toContain('報名名單（');
    const eventB = await t.events.findActiveByGroup('G-B');
    expect(await t.registrations.countConfirmed(eventB!.id)).toBe(1);

    // B 群「名單」照常唯讀查詢；B 群雜訊靜默不回覆。
    const listOut = await handler.handleEvent(
      groupTextEvent('名單', { userId: HOST, messageId: 'b1', groupId: 'G-B' }),
    );
    expect(textOf(listOut)).toContain('報名名單（');
    expect(
      await handler.handleEvent(groupTextEvent('今天天氣真好', { userId: HOST, messageId: 'b2', groupId: 'G-B' })),
    ).toEqual([]);

    // A 群流程完全未被 B 群訊息破壞（state 未前進、draft 未被誤填）。
    const conv = await t.conversations.get(HOST);
    expect(conv?.state).toBe('awaiting_date');
    expect(conv?.group_id).toBe(G);
    expect(JSON.parse(conv!.payload ?? '{}').date).toBeUndefined();

    // A 群下一則才是答案 → 正常前進。
    const dateOut = await handler.handleEvent(groupTextEvent('2999/08/15', { userId: HOST, messageId: 'a1' }));
    expect(textOf(dateOut)).toContain('請輸入時間');
  });

  it('[D-004 errata 跨群] A 群 awaiting_confirm 時，B 群輸入「確認」→ 不建立任何活動、A 群流程保留', async () => {
    const handler = makeHandler(t);
    await handler.handleEvent(
      groupTextEvent('開團 2999/08/15 07:30 東方球場 16人 2200元', { userId: HOST, messageId: 'a0' }),
    );
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm');

    const bOut = await handler.handleEvent(
      groupTextEvent('確認', { userId: HOST, messageId: 'b0', groupId: 'G-B' }),
    );
    expect(bOut).toEqual([]); // 別群的「確認」→ noop、不回覆
    expect(await t.events.findActiveByGroup('G-B')).toBeUndefined(); // 不得在 B 群建立
    expect(await t.events.findActiveByGroup(G)).toBeUndefined(); // 也不得提前在 A 群建立
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm'); // A 群流程保留

    // 回 A 群「確認」→ 正常建立於 A 群。
    const aOut = await handler.handleEvent(groupTextEvent('確認', { userId: HOST, messageId: 'a1' }));
    expect(textOf(aOut)).toContain('開團成功');
    expect((await t.events.findActiveByGroup(G))?.group_id).toBe(G);
  });

  it('[D-004 errata 跨群] A 群流程進行中，B 群輸入「取消」→ 不放棄 A 群流程', async () => {
    const handler = makeHandler(t);
    await handler.handleEvent(groupTextEvent('開團', { userId: HOST, messageId: 'a0' }));
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_date');

    const bOut = await handler.handleEvent(
      groupTextEvent('取消', { userId: HOST, messageId: 'b0', groupId: 'G-B' }),
    );
    expect(bOut).toEqual([]); // 別群的「取消」→ 靜默 noop
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_date'); // 流程未被放棄
    expect(await t.processed.has('b0')).toBe(false); // 不 mark

    // A 群「取消」才真的放棄。
    const aOut = await handler.handleEvent(groupTextEvent('取消', { userId: HOST, messageId: 'a1' }));
    expect(textOf(aOut)).toContain('已取消開團');
    expect(await t.conversations.get(HOST)).toBeUndefined();
  });

  // ── D-004 errata (N2)：跨群守衛新暴露的靜默死角 ───────────────────────────
  // 加了跨群守衛後，B 群的 `開團` 不再被攔截 → startCreation 無條件 upsert 會靜默吃掉
  // A 群的半成品 draft，使用者回 A 群作答則因 unknown 而無回覆。故須附一句告知。
  it('[D-004 errata N2] A 群 awaiting_confirm 時 B 群「開團」→ 附放棄告知，且不洩漏 A 群任何內容', async () => {
    const handler = makeHandler(t);
    // A 群一行式 → awaiting_confirm（draft 含場地/人數/費用）。
    await handler.handleEvent(
      groupTextEvent('開團 2999/08/15 07:30 東方球場 16人 2200元', { userId: HOST, messageId: 'a0' }),
    );
    expect((await t.conversations.get(HOST))?.state).toBe('awaiting_confirm');

    // B 群開新團 → 開始新流程 + 告知舊流程已被放棄。
    const bOut = await handler.handleEvent(
      groupTextEvent('開團', { userId: HOST, messageId: 'b0', groupId: 'G-B' }),
    );
    const txt = textOf(bOut);
    expect(txt).toContain('已放棄你先前未完成的開團。');
    expect(txt).toContain('請輸入活動日期'); // 新流程照常開始（不拒絕）
    // **不得洩漏 A 群的存在或其內容**：群組識別與 draft 各欄位皆不可出現。
    for (const leak of ['東方球場', '2999/08/15', '07:30', '16', '2200', G]) {
      expect(txt).not.toContain(leak);
    }

    // A 群 draft 確實已被新流程取代（同一列改屬 B 群、回到首問狀態）。
    const conv = await t.conversations.get(HOST);
    expect(conv?.group_id).toBe('G-B');
    expect(conv?.state).toBe('awaiting_date');
    expect(JSON.parse(conv!.payload ?? '{}').location).toBeUndefined();
  });

  it('[D-004 errata N2] 無前一段流程時「開團」→ 不附放棄告知（不擾民）', async () => {
    const handler = makeHandler(t);
    const out = await handler.handleEvent(groupTextEvent('開團', { userId: HOST, messageId: 'n0' }));
    expect(textOf(out)).toContain('請輸入活動日期');
    expect(textOf(out)).not.toContain('已放棄');
    expect(textOf(out)).not.toContain('已結束');
  });
});
