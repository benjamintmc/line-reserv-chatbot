import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { handleMessages } from './__tests__/handle-messages';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { taipeiToUtcIso } from '../db/time';
import type { EventRow, PriceMode } from '../db/schema';
import { RegistrationService } from '../domain/registration-service';
import { EventService, MAX_MENTIONS_PER_MESSAGE } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { createWebhookHandler, type GroupProfileClient, type WebhookHandler } from './handler';

/**
 * D-015 編輯活動資訊：webhook 接線驗收。
 * 重點在 **handler 新分支**（`edit_event`／`edit_help`／`invalid(edit_event)`）——
 * 這三條若照抄舊寫法（`invalid` 一律 `return []`）就會「有回覆卻未消費 message.id」（G5）。
 */

const G = 'G';
const HOST = 'U-host';

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

function makeHandler(
  t: TestDb,
  profile: GroupProfileClient,
  superAdmins: string[] = [],
): WebhookHandler {
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
    runImmediate: t.runImmediate,
    superAdminUserIds: superAdmins,
    logError: () => {},
  });
  const grouping = new GroupingService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: t.runInTransaction,
  });
  return createWebhookHandler({
    messageEventMap: t.messageEventMap, // D-025 §4.1：quote 查表來源（必填）
    events: t.events, // D-026 §5.2：dispatch 消歧義的候選集合來源
    groups: t.groups, // D-018：觀測依賴（必填）
    grouping,
    service,
    eventService,
    users: t.users,
    conversations: t.conversations,
    profile,
  });
}

async function seed(
  t: TestDb,
  o: { date: string; time: string; capacity?: number; priceMode?: PriceMode } = {
    date: '2999-08-15',
    time: '07:30',
  },
): Promise<EventRow> {
  const host = await t.users.upsert(HOST, '主辦人');
  return t.events.create({
    groupId: G,
    hostUserId: host.id,
    eventDatetime: taipeiToUtcIso(o.date, o.time),
    location: '東方場地',
    capacity: o.capacity ?? 16,
    priceMode: o.priceMode ?? 'per_person',
    ...(o.priceMode === 'split_venue' ? { venueFee: 3000 } : { pricePerPerson: 2000 }),
    status: 'open',
  });
}

function textOf(msgs: messagingApi.Message[]): string {
  const m = msgs[0];
  if (m === undefined) return '';
  if (m.type === 'text') return m.text;
  if (m.type === 'textV2') return m.text;
  return '';
}

describe('webhook handler — 編輯活動資訊（D-015）', () => {
  let t: TestDb;
  let profile: GroupProfileClient;
  let getProfileSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    t = await createTestDb();
    getProfileSpy = vi.fn().mockResolvedValue({ displayName: '主辦人' });
    profile = { getGroupMemberProfile: getProfileSpy as GroupProfileClient['getGroupMemberProfile'] };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });

  // ── AC-8：兩條經 handler 新分支的路徑必須有回覆且已消費 message.id ──────────
  it('[D-015 AC-8] `編輯`（edit_help）：第一次回 help、同 messageId 第二次不回覆', async () => {
    await seed(t);
    const h = makeHandler(t, profile);
    const first = await handleMessages(h, groupTextEvent('編輯', { messageId: 'm-help' }));
    expect(first).toHaveLength(1);
    expect(textOf(first)).toContain('活動目前資訊：');
    const second = await handleMessages(h, groupTextEvent('編輯', { messageId: 'm-help' }));
    expect(second).toEqual([]);
  });

  it('[D-015 AC-8] `編輯 日期 2026-13-99`（invalid(edit_event)）：有回覆且已消費 message.id', async () => {
    await seed(t);
    const h = makeHandler(t, profile);
    const first = await handleMessages(h, groupTextEvent('編輯 日期 2026-13-99', { messageId: 'm-inv' }));
    expect(first).toHaveLength(1);
    expect(textOf(first)).toContain('日期格式不正確，請輸入「編輯 日期 YYYY/MM/DD」');
    // 舊寫法（invalid → return []）會在這裡「回了話卻沒 mark」→ 重送再回一次。
    const second = await handleMessages(h, groupTextEvent('編輯 日期 2026-13-99', { messageId: 'm-inv' }));
    expect(second).toEqual([]);
  });

  it('[D-015 AC-11] `編輯 場地 <41 字>` → bad_location 文案帶實際字數，location 不變', async () => {
    const ev = await seed(t);
    const h = makeHandler(t, profile);
    const long = 'ㄅ'.repeat(41);
    const msgs = await handleMessages(h, groupTextEvent(`編輯 場地 ${long}`, { messageId: 'm-loc' }));
    expect(textOf(msgs)).toBe('場地名稱請控制在 40 字以內（你輸入了 41 字）。');
    expect((await t.events.getById(ev.id))?.location).toBe('東方場地');
  });

  it('[D-015 AC-7] `編輯 人數 12` → 導向文案（不落 help）', async () => {
    await seed(t);
    const h = makeHandler(t, profile);
    const msgs = await handleMessages(h, groupTextEvent('編輯 人數 12', { messageId: 'm-cap' }));
    expect(textOf(msgs)).toBe(
      '人數不能直接編輯。要增加名額請輸入「加開 N」（例：加開 2）；縮減名額目前不支援。',
    );
    expect(textOf(msgs)).not.toContain('活動目前資訊：');
  });

  it('[D-015 AC-5] 無活動時 `編輯 場地 X` → 沿用「目前沒有進行中的活動。」', async () => {
    const h = makeHandler(t, profile);
    const msgs = await handleMessages(h, groupTextEvent('編輯 場地 X', { messageId: 'm-na' }));
    expect(textOf(msgs)).toBe('目前沒有進行中的活動。');
  });

  // ── AC-12 / AC-14：mention 訊息型別與零 profile 查詢 ───────────────────
  it('[D-015 AC-12] 成功 → textV2 + {mN} substitution，恰 tag 不重複 owner、不含候補', async () => {
    await seed(t, { date: '2999-08-15', time: '07:30', capacity: 3 });
    const h = makeHandler(t, profile);

    // A 兩列自報名、B 代報一列（owner=B）→ 去重後 2 個 owner，正取滿 3；C 候補。
    await handleMessages(h, groupTextEvent('+2', { userId: 'U-A', messageId: 'r1' }));
    await handleMessages(h, groupTextEvent('+1 陳大哥', { userId: 'U-B', messageId: 'r2' }));
    await handleMessages(h, groupTextEvent('+1', { userId: 'U-C', messageId: 'r3' }));
    // 顯示名快照：A/B/C 依序（profile stub 對每次呼叫回同一名字，改為逐次指定）。
    await t.users.upsert('U-A', '阿明');
    await t.users.upsert('U-B', '小華');
    await t.users.upsert('U-C', '候補仔');

    getProfileSpy.mockClear();
    const msgs = await handleMessages(h, groupTextEvent('編輯 場地 新場地', { messageId: 'm-ok' }));
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m?.type).toBe('textV2');
    if (m?.type !== 'textV2') return;

    expect(m.text).toContain('已更新場地：東方場地 → 新場地');
    expect(m.text).toContain('活動資訊已更新，已報名的各位請確認：');
    // {m0} {m1} 兩個 placeholder，且 substitution 皆為 user mention。
    expect(m.text).toContain('{m0}');
    expect(m.text).toContain('{m1}');
    expect(m.text).not.toContain('{m2}');
    const sub = m.substitution ?? {};
    expect(Object.keys(sub).sort()).toEqual(['m0', 'm1']);
    for (const v of Object.values(sub)) {
      expect(v.type).toBe('mention');
    }
    const ids = Object.values(sub)
      .map((v) => (v.type === 'mention' && v.mentionee.type === 'user' ? v.mentionee.userId : null))
      .sort();
    expect(ids).toEqual(['U-A', 'U-B']); // 代報列 tag 代報者本人；候補 U-C 不在內
    expect(m.text).not.toContain('陳大哥'); // 不得 tag 被代報者

    // [D-015 AC-14] 組 mention 不得新增任何 LINE profile API 呼叫。
    expect(getProfileSpy).toHaveBeenCalledTimes(0);
  });

  it('[D-015 AC-13] tag 數 = 上限 → 正常 tag；= 上限 + 1 → 整則退化、單一則、無 mention', async () => {
    const cap = MAX_MENTIONS_PER_MESSAGE + 1;
    await seed(t, { date: '2999-08-15', time: '07:30', capacity: cap });
    const h = makeHandler(t, profile);

    // 先撐到「恰好上限」人（各自 owner，皆為正取）。
    for (let i = 0; i < MAX_MENTIONS_PER_MESSAGE; i += 1) {
      await handleMessages(h, groupTextEvent('+1', { userId: `U-${i}`, messageId: `s${i}` }));
    }
    const atLimit = await handleMessages(h, groupTextEvent('編輯 場地 場地A', { messageId: 'm-at' }));
    expect(atLimit).toHaveLength(1);
    expect(atLimit[0]?.type).toBe('textV2');
    if (atLimit[0]?.type === 'textV2') {
      expect(Object.keys(atLimit[0].substitution ?? {})).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
      expect(atLimit[0].text).toContain('已報名的各位請確認：');
    }

    // 再加一人 → 上限 + 1 → overflow。
    await handleMessages(h, groupTextEvent('+1', { userId: 'U-extra', messageId: 's-extra' }));
    const over = await handleMessages(h, groupTextEvent('編輯 場地 場地B', { messageId: 'm-over' }));
    expect(over).toHaveLength(1); // 不拆多則
    expect(over[0]?.type).toBe('text'); // 無 mention → 退回純 TextMessage
    expect(textOf(over)).toBe('已更新場地：場地A → 場地B\n活動資訊已更新，已報名的各位請確認。');
    expect(textOf(over)).not.toContain('@');
  });

  it('[D-015 AC-10] `編輯` 的 help 依 price_mode 給對應費用範例（split 不得示範 per_person 寫法）', async () => {
    await seed(t, { date: '2999-08-15', time: '07:30', priceMode: 'split_venue' });
    const h = makeHandler(t, profile);
    const msgs = await handleMessages(h, groupTextEvent('編輯', { messageId: 'm-h2' }));
    const text = textOf(msgs);
    expect(text).toContain('編輯 費用 場地費4000');
    expect(text).not.toContain('\n編輯 費用 2500');
    expect(text).not.toContain('編輯 地點'); // F1
  });
});
