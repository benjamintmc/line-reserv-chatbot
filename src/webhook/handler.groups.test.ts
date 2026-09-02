import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { handleMessages } from './__tests__/handle-messages';
import type { WebhookEvent } from '@line/bot-sdk';
import { createTestDb, seedEvent, type TestDb } from '../db/__tests__/test-db';
import { RegistrationService } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { GroupRepository } from '../db/repositories/group-repository';
import {
  createWebhookHandler,
  type GroupProfileClient,
  type GroupSummaryClient,
  type WebhookHandler,
} from './handler';

/**
 * D-018 觸及與擴散觀測：join/leave 接線、訊息路徑首見補登、群組名稱 best-effort，
 * 以及「觀測失敗絕不影響使用者可見行為」（G1）的回歸測試。
 */

function groupTextEvent(
  text: string,
  opts: { userId?: string; messageId?: string; groupId?: string } = {},
): WebhookEvent {
  return {
    type: 'message',
    message: { type: 'text', id: opts.messageId ?? 'mid-1', text },
    source: { type: 'group', groupId: opts.groupId ?? 'G-1', userId: opts.userId ?? 'U-x' },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
}

/** join/leave 事件；source 可為 group（正常）或 user/room（G7 應被忽略）。 */
function lifecycleEvent(
  type: 'join' | 'leave',
  source: Record<string, string> = { type: 'group', groupId: 'G-1' },
): WebhookEvent {
  return { type, source, replyToken: 'rt' } as unknown as WebhookEvent;
}

function profileReturning(name: string): GroupProfileClient {
  return { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: name }) };
}

/** 名稱查詢 spy：可設定回傳值，或傳入 Error 讓它拋錯。 */
function summaryClient(name: string | Error): GroupSummaryClient {
  return {
    getGroupSummary:
      name instanceof Error
        ? vi.fn().mockRejectedValue(name)
        : vi.fn().mockResolvedValue({ groupName: name }),
  };
}

function makeHandler(
  t: TestDb,
  opts: { groups?: GroupRepository; groupSummary?: GroupSummaryClient } = {},
): WebhookHandler {
  return createWebhookHandler({
    messageEventMap: t.messageEventMap, // D-025 §4.1：quote 查表來源（必填）
    events: t.events, // D-026 §5.2：dispatch 消歧義的候選集合來源
    groups: opts.groups ?? t.groups,
    groupSummary: opts.groupSummary,
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
      superAdminUserIds: [],
    }),
    users: t.users,
    conversations: t.conversations,
    profile: profileReturning('報名者'),
    logError: () => {},
  });
}

/**
 * noUncheckedIndexedAccess 下取第 i 列：不存在就當場失敗。
 * 刻意不用 `?.`／`!`——前者讓「兩邊都 undefined」的假通過溜過去，後者等於關掉檢查。
 */
function nthRow<T>(rows: readonly T[], i: number): T {
  const r = rows[i];
  if (r === undefined) throw new Error(`預期存在第 ${i} 列，實際只有 ${rows.length} 列`);
  return r;
}

describe('D-018 觸及與擴散觀測', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-018 AC-1] join 事件建立 groups 列且完全不回覆', async () => {
    const handler = makeHandler(t);
    const msgs = await handleMessages(handler, lifecycleEvent('join'));

    expect(msgs).toEqual([]); // G2：join 不回覆。

    const row = await t.groups.get('G-1');
    expect(row).toBeDefined();
    expect(row?.discovered_via).toBe('join');
    expect(row?.left_at).toBeNull();
  });

  it('[D-018 AC-2] leave 寫入 left_at；重複 leave 不覆蓋首次離開時間', async () => {
    const handler = makeHandler(t);
    await handleMessages(handler, lifecycleEvent('join'));

    const leaveMsgs = await handleMessages(handler, lifecycleEvent('leave'));
    expect(leaveMsgs).toEqual([]); // G2：leave 亦不回覆。
    const first = (await t.groups.get('G-1'))?.left_at;
    expect(first).not.toBeNull();

    // LINE 可能重送 leave；首次離開時間是指標依據，不得被覆蓋。
    await handleMessages(handler, lifecycleEvent('leave'));
    expect((await t.groups.get('G-1'))?.left_at).toBe(first);
  });

  it('[D-018 AC-3] 被移出後再度加入：left_at 清回 null，joined_at 維持首次值', async () => {
    const handler = makeHandler(t);
    await handleMessages(handler, lifecycleEvent('join'));
    const firstJoinedAt = (await t.groups.get('G-1'))?.joined_at;
    await handleMessages(handler, lifecycleEvent('leave'));

    await handleMessages(handler, lifecycleEvent('join'));
    const row = await t.groups.get('G-1');
    expect(row?.left_at).toBeNull();
    // 指標問的是「這個群何時開始接觸產品」，不是最近一次加入。
    expect(row?.joined_at).toBe(firstJoinedAt);
  });

  it('[D-018 AC-4] 未見過的群組發訊息即補登；同群第二則不重複建列、不重複打名稱 API', async () => {
    const summary = summaryClient('週三球敘');
    const handler = makeHandler(t, { groupSummary: summary });

    // 刻意用「雜訊」訊息：加了機器人卻從不開團的群，只會產生這種訊息。
    await handleMessages(handler, groupTextEvent('今天天氣真好', { messageId: 'm-1' }));
    const row = await t.groups.get('G-1');
    expect(row?.discovered_via).toBe('message');
    expect(row?.group_name).toBe('週三球敘');
    expect(summary.getGroupSummary).toHaveBeenCalledTimes(1);

    await handleMessages(handler, groupTextEvent('那再約', { messageId: 'm-2' }));
    // G4：每群一生最多一次名稱查詢，不得落在每則訊息的熱路徑上。
    expect(summary.getGroupSummary).toHaveBeenCalledTimes(1);

    const all = await t.pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM groups');
    expect(nthRow(all.rows, 0).n).toBe(1);
  });

  it('[D-018 AC-5] 名稱查詢拋錯：group_name 留白，且原有回覆逐字不受影響', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G-1' });

    // 基準：未接名稱查詢時的回覆。
    const baseline = await handleMessages(
      makeHandler(t),
      groupTextEvent('名單', { messageId: 'm-base' }),
    );
    await t.pool.query('DELETE FROM groups');

    const handler = makeHandler(t, { groupSummary: summaryClient(new Error('LINE 500')) });
    const msgs = await handleMessages(handler, groupTextEvent('名單', { messageId: 'm-1' }));

    expect(msgs).toEqual(baseline); // G1：使用者看到的東西完全一樣。
    const row = await t.groups.get('G-1');
    expect(row).toBeDefined();
    expect(row?.group_name).toBeNull();
  });

  it('[D-018 AC-6] groups 寫入拋錯時，使用者仍收到原本的回覆', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G-1' });
    const baseline = await handleMessages(
      makeHandler(t),
      groupTextEvent('名單', { messageId: 'm-base' }),
    );

    // 注入一個寫入必定失敗的 repository：模擬 Neon 連不上的當下。
    const broken = new GroupRepository(t.pool);
    vi.spyOn(broken, 'recordSeen').mockRejectedValue(new Error('DB down'));
    const handler = makeHandler(t, { groups: broken });

    const msgs = await handleMessages(handler, groupTextEvent('名單', { messageId: 'm-1' }));
    // G1：統計壞掉不得讓報名一起壞掉。
    expect(msgs).toEqual(baseline);
  });

  it('[D-018 AC-8] 非群組來源（1:1／room）的 join 與訊息一律不寫入 groups', async () => {
    const handler = makeHandler(t);

    await handleMessages(handler, lifecycleEvent('join', { type: 'user', userId: 'U-solo' }));
    await handleMessages(handler, lifecycleEvent('join', { type: 'room', roomId: 'R-1' }));
    await handleMessages(handler, {
      type: 'message',
      message: { type: 'text', id: 'm-1', text: '名單' },
      source: { type: 'user', userId: 'U-solo' },
      replyToken: 'rt',
    } as unknown as WebhookEvent);

    const res = await t.pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM groups');
    expect(nthRow(res.rows, 0).n).toBe(0);
  });
});
