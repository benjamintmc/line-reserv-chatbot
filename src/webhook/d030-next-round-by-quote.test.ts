import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import type { EventRow } from '../db/schema';
import type { GroupingState } from '../domain/grouping';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { createWebhookHandler, type WebhookHandler } from './handler';
import { handleMessages } from './__tests__/handle-messages';

/**
 * D-030／T-035：`下一輪` 開放給「開團的人 + 該場有報名的人」（以 quote 指定 session）。
 *
 * 全檔走 handler（接線層）——因為受測行為的一半在 dispatch（G1：quote 只能經
 * `resolveQuotedEventInGroup`），service 單測看不到那條防線。
 */

const GA = 'G-a'; // 受測群組
const GB = 'G-b'; // 別群（AC-6 跨群）
const HOST = 'U-host';
const JIA = 'U-jia'; // 該場有報名
const YI = 'U-yi'; // 該場無報名
const ADMIN = 'U-admin'; // super-admin（AC-8）
const FUTURE = '2999-08-14T23:30:00Z';
/** 分組訊息與開團公告各一則 bot 訊息，皆映射到同一場（AC-1／AC-2）。 */
const QUOTE_GROUPING = 'bot-grouping';
const QUOTE_ANNOUNCE = 'bot-announce';
/** 凍結名單（quote 回覆不得外洩，AC-6）。 */
const ROSTER = ['阿一', '阿二', '阿三', '阿四', '阿五', '阿六', '阿七', '阿八'];

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
    source: { type: 'group', groupId: opts.groupId ?? GA, userId: opts.userId ?? HOST },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
}

function makeHandler(t: TestDb): WebhookHandler {
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
    service: new RegistrationService({
      events: t.events,
      users: t.users,
      registrations: t.registrations,
      processed: t.processed,
      runImmediate: t.runImmediate,
      logError: () => {},
    }),
    eventService: new EventService({
      events: t.events,
      users: t.users,
      conversations: t.conversations,
      runInTransaction: t.runInTransaction,
      runImmediate: t.runImmediate,
      superAdminUserIds: [ADMIN], // AC-8：確實是 super-admin，仍不得取得 `下一輪` 權限
      logError: () => {},
    }),
    users: t.users,
    conversations: t.conversations,
    profile: { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: '某人' }) },
  });
}

function textOf(msgs: messagingApi.Message[]): string {
  const m = msgs[0];
  if (m === undefined) return '';
  return (m as { text?: string }).text ?? '';
}

/** 讀 host 那一列 session 目前停在第幾輪（`undefined` = 無 session）。 */
async function sessionRound(t: TestDb, groupId: string, lineUserId: string): Promise<number | undefined> {
  const conv = await t.conversations.get(groupId, lineUserId);
  if (conv?.payload == null) return undefined;
  return (JSON.parse(conv.payload) as GroupingState).round;
}

describe('D-030 `下一輪` 以 quote 指定 session（host ∪ 有報名者）', () => {
  let t: TestDb;
  let handler: WebhookHandler;
  let event: EventRow;

  beforeEach(async () => {
    t = await createTestDb();
    const host = await t.users.upsert(HOST, '主辦人');
    event = await t.events.create({
      groupId: GA,
      hostUserId: host.id,
      eventDatetime: FUTURE,
      location: '北區場地',
      capacity: 20,
      status: 'open',
    });
    for (const name of ROSTER) {
      await t.registrations.insertSlot({
        eventId: event.id,
        ownerUserId: host.id,
        displayName: name,
        kind: 'proxy',
        status: 'confirmed',
      });
    }
    // 甲：該場自己的未取消報名列（授權來源）。乙／admin 皆無。
    const jia = await t.users.upsert(JIA, '甲');
    await t.registrations.insertSlot({
      eventId: event.id,
      ownerUserId: jia.id,
      displayName: '甲',
      kind: 'self',
      status: 'confirmed',
    });
    await t.users.upsert(YI, '乙');
    await t.users.upsert(ADMIN, '管理員');
    // 兩則 bot 訊息映射到這場（正常由 server.ts 於 reply 後寫入）。
    await t.messageEventMap.record(QUOTE_GROUPING, event.id);
    await t.messageEventMap.record(QUOTE_ANNOUNCE, event.id);
    handler = makeHandler(t);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  /** host 起一段多輪 session（第 1 輪）。`rounds` 選填，用於 AC-9 的上限情境。 */
  async function startSession(rounds?: number): Promise<void> {
    const cmd = rounds === undefined ? '分組 2場' : `分組 2場 ${rounds}輪`;
    const out = await handleMessages(handler, groupTextEvent(cmd, { messageId: 'm-start' }));
    expect(textOf(out)).toContain('第 1 輪');
  }

  it('[D-030 AC-1] 該場有報名的甲，引用分組訊息打「下一輪」→ 正常產出第 2 輪', async () => {
    await startSession();
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: JIA, messageId: 'm1', quotedMessageId: QUOTE_GROUPING }),
    );
    expect(textOf(out)).toContain('第 2 輪');
  });

  it('[D-030 AC-2] 甲改引用該場的開團公告（非分組訊息）→ 同樣產出第 2 輪', async () => {
    await startSession();
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: JIA, messageId: 'm2', quotedMessageId: QUOTE_ANNOUNCE }),
    );
    expect(textOf(out)).toContain('第 2 輪');
  });

  it('[D-030 AC-3] 該場沒有報名的乙引用 → not_authorized 文案，且輪次不推進', async () => {
    await startSession();
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: YI, messageId: 'm3', quotedMessageId: QUOTE_GROUPING }),
    );
    expect(textOf(out)).toBe('只有開團的人或有報名的人可以喊下一輪。');
    expect(await t.processed.has('m3')).toBe(false); // 零寫入早退（§4 例外 (b)）
    expect(await sessionRound(t, GA, HOST)).toBe(1); // 未推進

    // host 接著打 `下一輪` 拿到的是第 2 輪（不是第 3 輪）。
    const hostOut = await handleMessages(handler, groupTextEvent('下一輪', { messageId: 'm3b' }));
    expect(textOf(hostOut)).toContain('第 2 輪');
  });

  it('[D-030 AC-4]（G2）甲以 quote 推進後，只有 host 那一列被更新，甲名下無任何 grouping 列', async () => {
    await startSession();
    await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: JIA, messageId: 'm4', quotedMessageId: QUOTE_GROUPING }),
    );

    expect(await sessionRound(t, GA, HOST)).toBe(2); // host 那一列被更新
    expect(await t.conversations.get(GA, JIA)).toBeUndefined(); // 發話者名下沒開新 session
    // 直接對表斷言：發話者名下**任何群**都沒有 grouping 列（session 不得易主／複製）。
    const rows = await t.pool.query(
      'SELECT group_id FROM conversation_states WHERE line_user_id = $1',
      [JIA],
    );
    expect(rows.rows).toEqual([]);
  });

  it('[D-030 AC-5] host 不引用打「下一輪」→ 與 D-011 AC-21 行為一致（零回歸）', async () => {
    await startSession();
    const out = await handleMessages(handler, groupTextEvent('下一輪', { messageId: 'm5' }));
    expect(textOf(out)).toContain('第 2 輪');
    expect(await sessionRound(t, GA, HOST)).toBe(2);
    expect(await t.processed.has('m5')).toBe(true);
  });

  it('[D-030 AC-6]（G1 跨群）甲在 B 群引用映射到 A 群活動的訊息 → no_session，A 群 session 不推進', async () => {
    await startSession();
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', {
        userId: JIA,
        groupId: GB,
        messageId: 'm6',
        quotedMessageId: QUOTE_GROUPING,
      }),
    );
    const reply = textOf(out);
    expect(reply).toContain('目前沒有進行中的分組');
    for (const name of ROSTER) expect(reply).not.toContain(name); // A 群資訊零外洩
    expect(reply).not.toContain('北區場地');
    expect(await sessionRound(t, GA, HOST)).toBe(1); // A 群未被推進
    expect(await t.processed.has('m6')).toBe(false);
  });

  it('[D-030 AC-7]（G4）壞列與正常 session 共存時，不拋例外且仍撈到正確那一列', async () => {
    // design-reviewer 2026-10-18：原測未先 `startSession()`，期望值本就是 `no_session`
    // ⇒ `getGroupingByEvent` 永遠回 `undefined` 也會綠。改為「壞列共存下仍要撈對」。
    await startSession();
    // T-033b 前的 session（無 eventId），以及更早的壞列（根本不是 JSON）。
    await t.conversations.upsert({
      lineUserId: 'U-legacy',
      groupId: GA,
      state: 'grouping',
      payload: JSON.stringify({ labels: ROSTER, round: 1, mode: 'doubles' }),
    });
    await t.conversations.upsert({
      lineUserId: 'U-corrupt',
      groupId: GA,
      state: 'grouping',
      payload: 'not json at all',
    });

    // 甲 quote 進來，必須越過兩列壞資料找到 host 那一列 ⇒ 第 2 輪（不是 no_session）。
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: JIA, messageId: 'm7', quotedMessageId: QUOTE_GROUPING }),
    );
    expect(textOf(out)).toContain('第 2 輪');
    // repository 直接呼叫亦不得拋（AC-7 的根因在此層），且撈回的是 host 那一列。
    const found = await t.conversations.getGroupingByEvent(GA, event.id);
    expect(found?.line_user_id).toBe(HOST);
  });

  it('[D-030 AC-8]（G3）super-admin 且該場無報名，引用後打「下一輪」→ not_authorized', async () => {
    await startSession();
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: ADMIN, messageId: 'm8', quotedMessageId: QUOTE_GROUPING }),
    );
    expect(textOf(out)).toBe('只有開團的人或有報名的人可以喊下一輪。');
    expect(await sessionRound(t, GA, HOST)).toBe(1);
  });

  it('[D-030 AC-9] 達 roundsLimit 後，有報名者引用打「下一輪」→ exhausted（文案不變）', async () => {
    await startSession(1); // 上限 1 輪 ⇒ 第 1 輪後即已用盡
    const out = await handleMessages(
      handler,
      groupTextEvent('下一輪', { userId: JIA, messageId: 'm9', quotedMessageId: QUOTE_GROUPING }),
    );
    expect(textOf(out)).toBe('已達輪數上限');
  });

  it('[D-030 AC-11] 有報名者「不引用」打「下一輪」→ 完整兩行引導文案（新文案的 handler 端覆蓋）', async () => {
    await startSession();
    const out = await handleMessages(handler, groupTextEvent('下一輪', { userId: JIA, messageId: 'm11' }));
    expect(textOf(out)).toBe(
      '目前沒有進行中的分組，請先『分組 …』\n（已經有人分組了？請引用那則分組訊息再打「下一輪」）',
    );
    expect(await sessionRound(t, GA, HOST)).toBe(1); // 別人的 session 不受影響
  });

  it('[D-030 AC-12]（B1）交易外讀到 session 後、交易內寫入前該列已被改動 → 早退 no_session，不覆寫', async () => {
    await startSession();
    // 模擬窗口：host 在甲的 `下一輪` 進入交易後、upsert 前開始 `開團`（同一列被改成 draft）。
    const racing = new GroupingService({
      events: t.events,
      users: t.users,
      registrations: t.registrations,
      conversations: t.conversations,
      processed: t.processed,
      runInTransaction: async (work) => {
        await t.conversations.upsert({
          lineUserId: HOST,
          groupId: GA,
          state: 'event_draft',
          payload: JSON.stringify({ location: '北區場地' }),
        });
        return t.runInTransaction(work);
      },
    });
    const result = await racing.nextRound({
      groupId: GA,
      executorLineUserId: JIA,
      messageId: 'm12',
      quotedEventId: event.id,
    });

    expect(result.kind).toBe('no_session');
    // host 的開團 draft 必須原封不動（不得被靜默覆寫回 grouping）。
    const row = await t.conversations.get(GA, HOST);
    expect(row?.state).toBe('event_draft');
  });
});

describe('D-030 真機腳本（AC-10）', () => {
  it('[D-030 AC-10] `docs/manual-test-T-035.md` 存在且含 2 帳號 1 群組的逐則腳本', () => {
    const doc = readFileSync(
      path.resolve(__dirname, '../../docs/manual-test-T-035.md'),
      'utf-8',
    );
    // 腳本必須可照打：每個步驟都要有「要打的字」與「預期回覆」。
    expect(doc).toContain('要打的字');
    expect(doc).toContain('預期回覆');
    expect(doc).toContain('下一輪');
    expect(doc).toContain('只有開團的人或有報名的人可以喊下一輪。');
    expect(doc.match(/^\|\s*\*{0,2}S\d+/gm)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});
