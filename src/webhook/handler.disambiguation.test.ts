import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import type { EventRow, EventStatus } from '../db/schema';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { formatNotAuthorized } from '../domain/event-formatter';
import { createWebhookHandler, type WebhookHandler } from './handler';

/**
 * T-033a 全鏈路消歧義（D-026 §5.2 dispatch 管線 + D-023 語意解析 + D-024 文案 + D-022 名單回退）。
 *
 * **多場並存一律以 repository 層構造**（連續 `events.create`）——依 D-020 不變式 #1，T-033a
 * 期間開團側仍拒第二場，走 `開團` 流程構造第二場必然假紅。
 */

const G = 'G-multi';

// 台灣本地時刻 → UTC（Asia/Taipei 固定 +8）。
const T_0815_0730 = '2999-08-14T23:30:00Z'; // 2999-08-15 07:30
const T_0815_0900 = '2999-08-15T01:00:00Z'; // 2999-08-15 09:00
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
    source: { type: 'group', groupId: opts.groupId ?? G, userId: opts.userId ?? 'U-x' },
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
  opts: { service?: RegistrationService; displayName?: string } = {},
): WebhookHandler {
  return createWebhookHandler({
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
    service: opts.service ?? makeService(t),
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
    profile: { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: opts.displayName ?? '王小明' }) },
  });
}

/** repository 層直接建一場活動（繞過開團側的過渡期單場限制）。 */
async function mkEvent(
  t: TestDb,
  opts: { location: string; at: string; hostLineId?: string; status?: EventStatus; groupId?: string },
): Promise<EventRow> {
  const host = await t.users.upsert(opts.hostLineId ?? 'U-host', '主辦人');
  return t.events.create({
    groupId: opts.groupId ?? G,
    hostUserId: host.id,
    eventDatetime: opts.at,
    location: opts.location,
    capacity: 16,
    status: opts.status ?? 'open',
  });
}

function textOf(msgs: messagingApi.Message[]): string {
  const m = msgs[0];
  if (m === undefined) return '';
  return (m as { text?: string }).text ?? '';
}

describe('T-033a 全鏈路消歧義（dispatch → service）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  // ── D-023：語意解析核心 ─────────────────────────────────────────────
  it('[D-023 AC-6] 單場時零回歸：裸 +1／亂打的 @selector／引用無關訊息，三者皆照常報名該場', async () => {
    const only = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const handler = makeHandler(t);

    // (a) 無 selector、無引言。
    await handler.handleEvent(groupTextEvent('+1', { messageId: 'm1' }));
    // (b) selector 存在但與該場地完全不符 → resolveTargetEvent 回 single，**不驗證** selector 內容。
    await handler.handleEvent(groupTextEvent('@隨便打的文字 +1', { messageId: 'm2' }));
    // (c) 引用一則與該活動無關的訊息（機制 A 屬 T-033b，本批 quote 恆解出 undefined ＝未引言）。
    await handler.handleEvent(
      groupTextEvent('+1', { messageId: 'm3', quotedMessageId: 'unrelated-bot-message' }),
    );

    expect(await t.registrations.countConfirmed(only.id)).toBe(3);
  });

  it('[D-023 AC-8] 2 場 open（旭陽／東方），`@旭陽 +1` → 報名到旭陽那場', async () => {
    const a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const b = await mkEvent(t, { location: '東方球場', at: T_0920_0730 });
    const handler = makeHandler(t);

    await handler.handleEvent(groupTextEvent('@旭陽 +1', { messageId: 'm1' }));

    expect(await t.registrations.countConfirmed(a.id)).toBe(1);
    expect(await t.registrations.countConfirmed(b.id)).toBe(0);
  });

  it('[D-023 AC-11] 同場地不同日期，`@旭陽 8/15 +1` → 精準命中該日期那場', async () => {
    const aug = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const sep = await mkEvent(t, { location: '旭陽球場', at: T_0920_0730 });
    const handler = makeHandler(t);

    await handler.handleEvent(groupTextEvent('@旭陽 8/15 +1', { messageId: 'm1' }));

    expect(await t.registrations.countConfirmed(aug.id)).toBe(1);
    expect(await t.registrations.countConfirmed(sep.id)).toBe(0);
  });

  it('[D-023 AC-12] 同場地同日期不同時間：日期不夠精準 → 補時間後命中恰一場', async () => {
    const early = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const late = await mkEvent(t, { location: '旭陽球場', at: T_0815_0900 });
    const handler = makeHandler(t);

    // (a) 只給場地+日期 → 命中 2 場 → too_many，不報名。
    const r1 = await handler.handleEvent(groupTextEvent('@旭陽 8/15 +1', { messageId: 'm1' }));
    expect(textOf(r1)).toBe('有超過一場 旭陽 8/15 的球敘，請修正再試');
    expect(await t.registrations.countConfirmed(early.id)).toBe(0);
    expect(await t.registrations.countConfirmed(late.id)).toBe(0);

    // (b) 補上時間 → 命中恰一場。
    await handler.handleEvent(groupTextEvent('@旭陽 8/15 07:30 +1', { messageId: 'm2' }));
    expect(await t.registrations.countConfirmed(early.id)).toBe(1);
    expect(await t.registrations.countConfirmed(late.id)).toBe(0);
  });

  // ── D-024：selector 命中 0／多場的文案 ──────────────────────────────
  it('[D-024 AC-9] `@不存在的場地 +1` → 「找不到符合 … 的球敘，請確認後再試」（{xxx} 為原文）', async () => {
    const a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const b = await mkEvent(t, { location: '東方球場', at: T_0920_0730 });
    const handler = makeHandler(t);

    const msgs = await handler.handleEvent(groupTextEvent('@不存在的場地 +1', { messageId: 'm1' }));

    expect(textOf(msgs)).toBe('找不到符合 不存在的場地 的球敘，請確認後再試');
    expect(await t.registrations.countConfirmed(a.id)).toBe(0);
    expect(await t.registrations.countConfirmed(b.id)).toBe(0);
    expect(await t.processed.has('m1')).toBe(false); // 純判斷拒絕：不消費 message.id
  });

  it('[D-024 AC-10] 3 場 open 皆含「球場」，`@球場 +1` → 「有超過一場 球場 的球敘，請修正再試」', async () => {
    const a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const b = await mkEvent(t, { location: '東方球場', at: T_0815_0900 });
    const c = await mkEvent(t, { location: '大溪球場', at: T_0920_0730 });
    const handler = makeHandler(t);

    const msgs = await handler.handleEvent(groupTextEvent('@球場 +1', { messageId: 'm1' }));

    expect(textOf(msgs)).toBe('有超過一場 球場 的球敘，請修正再試');
    for (const e of [a, b, c]) expect(await t.registrations.countConfirmed(e.id)).toBe(0);
  });

  // ── D-026：dispatch 管線 ────────────────────────────────────────────
  it('[D-026 AC-7] 2 場 open、裸 `+1` → 多場提示；不呼叫任何 service、不 markProcessed', async () => {
    await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    await mkEvent(t, { location: '東方球場', at: T_0920_0730 });
    const service = makeService(t);
    const signupSpy = vi.spyOn(service, 'signup');
    const handler = makeHandler(t, { service });

    const msgs = await handler.handleEvent(groupTextEvent('+1', { messageId: 'm1' }));

    expect(textOf(msgs)).toBe('群組內有多場球敘進行中，請回覆或標註 @場地/@時間 以指定要操作的球敘');
    expect(signupSpy).not.toHaveBeenCalled();
    expect(await t.processed.has('m1')).toBe(false);
  });

  it('[D-026 AC-20] 批次僅認第一行 selector：`@旭陽\\n+1\\n-1 陳先生` 兩行皆作用於旭陽那場', async () => {
    const a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
    const b = await mkEvent(t, { location: '東方球場', at: T_0920_0730 });
    // 先在旭陽場布一筆由 U-x 代報的「陳先生」，供第 3 行取消。
    const owner = await t.users.upsert('U-x', '王小明');
    await t.registrations.insertSlot({
      eventId: a.id,
      ownerUserId: owner.id,
      displayName: '陳先生',
      kind: 'proxy',
      status: 'confirmed',
    });
    expect(await t.registrations.countConfirmed(a.id)).toBe(1);

    const handler = makeHandler(t);
    await handler.handleEvent(groupTextEvent('@旭陽\n+1\n-1 陳先生', { messageId: 'm1' }));

    // 旭陽：+1（王小明）與 -1 陳先生 各作用一次 → 仍 1 筆有效正取，且是王小明。
    const confirmed = await t.registrations.listConfirmed(a.id);
    expect(confirmed.map((r) => r.display_name)).toEqual(['王小明']);
    // 東方場完全未被觸及（G12：整批共用同一次消歧義結果）。
    expect(await t.registrations.countConfirmed(b.id)).toBe(0);
  });

  it('[D-026 AC-21] 多場並行下 `下一輪` 不需 selector（G11：目標由 grouping session 決定）', async () => {
    const a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730, hostLineId: 'U-a' });
    await mkEvent(t, { location: '東方球場', at: T_0920_0730, hostLineId: 'U-b' });
    const hostA = await t.users.upsert('U-a', '甲');
    for (const name of ['P1', 'P2', 'P3', 'P4']) {
      await t.registrations.insertSlot({
        eventId: a.id,
        ownerUserId: hostA.id,
        displayName: name,
        kind: 'proxy',
        status: 'confirmed',
      });
    }
    const handler = makeHandler(t);

    // 啟動分組（多場並行 → `分組` 屬 NEEDS_EVENT_SET，需 @selector 指定）。
    const started = await handler.handleEvent(
      groupTextEvent('@旭陽 分組 1場 2輪', { userId: 'U-a', messageId: 'm1' }),
    );
    expect(textOf(started)).toContain('第 1 輪');

    // `下一輪`：**無 selector、無引言**，仍須正常推進（不落入 ambiguous）。
    const next = await handler.handleEvent(groupTextEvent('下一輪', { userId: 'U-a', messageId: 'm2' }));
    expect(textOf(next)).toContain('第 2 輪');
    expect(textOf(next)).not.toContain('群組內有多場球敘進行中');
  });

  it('[D-026 AC-23] 授權判定作用於已解析的那場：甲對乙的場下 `取消活動` → not_authorized', async () => {
    const a = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730, hostLineId: 'U-a' });
    const b = await mkEvent(t, { location: '東方球場', at: T_0920_0730, hostLineId: 'U-b' });
    const handler = makeHandler(t);

    const msgs = await handler.handleEvent(
      groupTextEvent('@東方 取消活動', { userId: 'U-a', messageId: 'm1' }),
    );

    expect(textOf(msgs)).toBe(formatNotAuthorized().text);
    // 兩場皆未被取消——尤其不得誤用 A 場（甲為其 host）的授權放行而取消 B 場。
    expect((await t.events.getById(b.id))?.status).toBe('open');
    expect((await t.events.getById(a.id))?.status).toBe('open');
  });

  // ── D-022：`名單` 的 0-候選回退（G9） ───────────────────────────────
  it('[D-022 AC-18] `名單` 不被較新的 closed 活動蓋掉（顯示仍 open 的較舊那場）', async () => {
    const open = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 }); // id 較小、仍 open
    const closed = await mkEvent(t, {
      location: '東方球場',
      at: T_0920_0730,
      status: 'closed',
    }); // id 較大、已 closed
    expect(closed.id).toBeGreaterThan(open.id);
    const handler = makeHandler(t);

    const msgs = await handler.handleEvent(groupTextEvent('名單', { messageId: 'm1' }));

    // candidates = [旭陽]（closed 不在 active 集合）→ single → 顯示旭陽的即時名單。
    expect(textOf(msgs)).toContain('[旭陽球場 球敘]');
    expect(textOf(msgs)).not.toContain('東方球場');
    expect(textOf(msgs)).not.toContain('報名已截止'); // 非 closed 的截止名單
  });

  it('[D-022 AC-19] 0 候選時 `名單` 回退不變（顯示唯一的歷史 closed 活動）', async () => {
    await mkEvent(t, { location: '東方球場', at: T_0920_0730, status: 'closed' });
    const handler = makeHandler(t);

    const msgs = await handler.handleEvent(groupTextEvent('名單', { messageId: 'm1' }));

    expect(textOf(msgs)).toContain('[東方球場 球敘]（報名已截止）');
  });
});
