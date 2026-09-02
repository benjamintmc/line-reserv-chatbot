import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import type { EventRow } from '../db/schema';
import { RegistrationService, type RegistrationView } from '../domain/registration-service';
import { EventService } from '../domain/event-service';
import { GroupingService } from '../domain/grouping-service';
import { recordReplyMapping } from '../server';
import { createWebhookHandler, type WebhookHandler } from './handler';

/**
 * T-033b／D-029 §5.3：`relatedEventId` 送出點枚舉（G4）+ §5.5 `GroupingState.eventId`
 * + D-025 AC-16（`server.ts` 以 `sentMessages[].id` 寫入映射，G3）。
 *
 * 枚舉測試刻意**以 spy 直接餵 service 結果**：目的是逐一走過 §5.3 表的每一列（其中數列在真實
 * 資料下難以或無法到達，例如 `renderConfirm/created`——有流程時會被 conversation 攔截走
 * `continueFlow`），用真實資料構造會讓「表列完整性」這件事測不完全。
 * 端到端的錨點正確性另由 AC-22（分組 session）與 AC-16（開團公告）以真實路徑覆蓋。
 */

const G = 'G-emit';
const HOST = 'U-host';
const T_0815_0730 = '2999-08-14T23:30:00Z'; // 2999-08-15 07:30
const T_0920_0730 = '2999-09-19T23:30:00Z'; // 2999-09-20 07:30

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

/** LINE `replyMessage` 的最小合法回應（映射寫入的唯一來源，G3）。 */
function replyResponse(...ids: string[]): messagingApi.ReplyMessageResponse {
  return { sentMessages: ids.map((id) => ({ id, quoteToken: `q-${id}` })) };
}

interface Bundle {
  handler: WebhookHandler;
  service: RegistrationService;
  eventService: EventService;
  grouping: GroupingService;
}

function makeBundle(t: TestDb, superAdmins: string[] = []): Bundle {
  const service = new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    superAdminUserIds: superAdmins,
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
  const handler = createWebhookHandler({
    messageEventMap: t.messageEventMap,
    events: t.events,
    groups: t.groups,
    grouping,
    service,
    eventService,
    users: t.users,
    conversations: t.conversations,
    profile: { getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: '主辦人' }) },
  });
  return { handler, service, eventService, grouping };
}

async function mkEvent(
  t: TestDb,
  opts: { location: string; at: string; groupId?: string },
): Promise<EventRow> {
  const host = await t.users.upsert(HOST, '主辦人');
  return t.events.create({
    groupId: opts.groupId ?? G,
    hostUserId: host.id,
    eventDatetime: opts.at,
    location: opts.location,
    capacity: 16,
    status: 'open',
  });
}

function viewOf(event: EventRow): RegistrationView {
  return { event, confirmed: [], waitlist: [], confirmedCount: 0, available: event.capacity };
}

describe('D-029 §5.3 送出點枚舉 + §5.5 GroupingState.eventId', () => {
  let t: TestDb;
  let ev: EventRow;

  beforeEach(async () => {
    t = await createTestDb();
    ev = await mkEvent(t, { location: '旭陽球場', at: T_0815_0730 });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  /**
   * 跑一次 handler，再照 `server.ts` 的路徑把結果餵給 `recordReplyMapping`，
   * 回傳「實際登記進 `message_event_map` 的 (messageId, eventId)」。
   */
  async function emit(
    handler: WebhookHandler,
    event: WebhookEvent,
  ): Promise<{ relatedEventId: number | undefined; recorded: [string, number][] }> {
    const result = await handler.handleEvent(event);
    const recorded: [string, number][] = [];
    const spyMap = {
      record: async (messageId: string, eventId: number): Promise<void> => {
        recorded.push([messageId, eventId]);
      },
    };
    if (result.messages.length > 0) {
      await recordReplyMapping(replyResponse('s1'), result.relatedEventId, spyMap);
    }
    return { relatedEventId: result.relatedEventId, recorded };
  }

  // ── §5.3 表列分支：各構造一次觸發，斷言以正確 eventId 登記一次 ────────────
  it('[D-029 AC-17] 表列分支逐一觸發 → record 各以正確 eventId 呼叫一次', async () => {
    const b = makeBundle(t);
    const view = viewOf(ev);

    const cases: { label: string; stub: () => void; text: string }[] = [
      {
        label: 'renderSignup/ok',
        stub: () =>
          void vi.spyOn(b.service, 'signup').mockResolvedValue({
            kind: 'ok',
            outcome: 'confirmed',
            requested: 1,
            subjectDisplayName: '主辦人',
            newSlots: [],
            view,
          }),
        text: '+1',
      },
      {
        label: 'renderCancel/ok',
        stub: () =>
          void vi.spyOn(b.service, 'cancel').mockResolvedValue({
            kind: 'ok',
            cancelled: 1,
            requested: 1,
            subjectDisplayName: '主辦人',
            promoted: [],
            view,
          }),
        text: '-1',
      },
      {
        label: 'renderList/ok',
        stub: () =>
          void vi
            .spyOn(b.service, 'getListView')
            .mockResolvedValue({ kind: 'ok', view, phase: 'live' }),
        text: '名單',
      },
      {
        label: 'renderAddCapacity/ok',
        stub: () =>
          void vi.spyOn(b.service, 'addCapacity').mockResolvedValue({
            kind: 'ok',
            added: 2,
            newCapacity: 18,
            promoted: [],
            view,
          }),
        text: '加開 2',
      },
      {
        label: 'renderBalanced/balanced',
        stub: () =>
          void vi.spyOn(b.grouping, 'groupBalanced').mockResolvedValue({
            kind: 'balanced',
            result: { kind: 'groups', groups: [['甲', '乙', '丙']] },
          }),
        text: '分組',
      },
      {
        label: 'renderStartRounds/round',
        stub: () =>
          void vi.spyOn(b.grouping, 'startRounds').mockResolvedValue({
            kind: 'round',
            round: { round: 1, courts: [{ teamA: ['甲', '乙'], teamB: ['丙', '丁'] }], sitOut: [] },
            mode: 'doubles',
          }),
        text: '分組 1場',
      },
      {
        label: 'renderNextRound/round',
        stub: () =>
          void vi.spyOn(b.grouping, 'nextRound').mockResolvedValue({
            kind: 'round',
            round: { round: 2, courts: [{ teamA: ['甲', '乙'], teamB: ['丙', '丁'] }], sitOut: [] },
            mode: 'doubles',
            eventId: ev.id,
          }),
        text: '下一輪',
      },
      {
        label: 'renderConfirm/created',
        stub: () =>
          void vi
            .spyOn(b.eventService, 'confirm')
            .mockResolvedValue({ kind: 'created', event: ev }),
        text: '確認',
      },
      {
        label: 'renderClose/ok',
        stub: () =>
          void vi.spyOn(b.eventService, 'closeEvent').mockResolvedValue({
            kind: 'ok',
            event: ev,
            confirmedCount: 0,
            settledPerPerson: null,
          }),
        text: '關閉報名',
      },
      {
        label: 'renderCancelEvent/ok',
        stub: () =>
          void vi
            .spyOn(b.eventService, 'cancelEvent')
            .mockResolvedValue({ kind: 'ok', event: ev }),
        text: '取消活動',
      },
      {
        label: 'renderEdit/ok',
        stub: () =>
          void vi.spyOn(b.eventService, 'editEvent').mockResolvedValue({
            kind: 'ok',
            eventId: ev.id,
            field: 'location',
            before: '舊場地',
            after: '新場地',
            confirmedCount: 0,
            tagOwnerIds: [],
            overflow: false,
          }),
        text: '編輯 場地 新場地',
      },
      {
        label: 'handleBatch 成功路徑',
        stub: () =>
          void vi.spyOn(b.service, 'signup').mockResolvedValue({
            kind: 'ok',
            outcome: 'confirmed',
            requested: 1,
            subjectDisplayName: '主辦人',
            newSlots: [],
            view,
          }),
        text: '+1\n+1',
      },
    ];

    let i = 0;
    for (const c of cases) {
      vi.restoreAllMocks();
      c.stub();
      const out = await emit(b.handler, groupTextEvent(c.text, { messageId: `emit-${i++}` }));
      expect(out.recorded, c.label).toEqual([['s1', ev.id]]);
    }

    // `renderContinue/created`（開團公告，最重要的錨點）：需先有進行中流程才會被攔截。
    vi.restoreAllMocks();
    vi.spyOn(b.eventService, 'continueFlow').mockResolvedValue({ kind: 'created', event: ev });
    await t.conversations.upsert({
      lineUserId: HOST,
      groupId: G,
      state: 'awaiting_confirm',
      payload: null,
    });
    const created = await emit(b.handler, groupTextEvent('確認', { messageId: 'emit-continue' }));
    expect(created.recorded, 'renderContinue/created').toEqual([['s1', ev.id]]);
  });

  it('[D-029 AC-17]「明確不附」清單的分支：完全不呼叫 record', async () => {
    const b = makeBundle(t);
    // 第二場 open → 讓消歧義的四種拒絕與 ambiguous 可達。
    await mkEvent(t, { location: '東方球場', at: T_0920_0730 });

    const cases: { label: string; text: string; userId?: string }[] = [
      { label: 'ambiguous（多場、無 selector）', text: '+1' },
      { label: 'not_found（selector 命中 0 場）', text: '@不存在的球場 +1' },
      { label: 'too_many（selector 命中 >1 場）', text: '@球場 +1' },
      { label: 'not_authorized（非主辦 關閉報名）', text: '@旭陽 關閉報名', userId: 'U-other' },
      { label: 'my_id', text: '我的ID' },
      { label: 'flow_started（開團逐步）', text: '開團' },
      { label: 'invalid(create_event) → 格式提示', text: '開團 只有一個參數' },
      { label: 'invalid(group) → 分組格式提示', text: '分組 abc' },
    ];

    let i = 0;
    for (const c of cases) {
      const opts: { messageId: string; userId?: string } = { messageId: `noattach-${i++}` };
      if (c.userId !== undefined) opts.userId = c.userId;
      const out = await emit(b.handler, groupTextEvent(c.text, opts));
      expect(out.relatedEventId, c.label).toBeUndefined();
      expect(out.recorded, c.label).toEqual([]);
    }

    // `unknown`（雜訊）：本就不回覆 ⇒ 沒有 sentMessages 可登記。
    const noise = await emit(b.handler, groupTextEvent('今天天氣真好', { messageId: 'noise' }));
    expect(noise.recorded).toEqual([]);
  });

  it('[D-029 AC-22] `分組`／`下一輪` 的訊息映射到 session 綁定的那場，非其他候選', async () => {
    const other = await mkEvent(t, { location: '東方球場', at: T_0920_0730 });
    const host = await t.users.upsert(HOST, '主辦人');
    // 只在「東方球場」那場放 4 名正取（雙打 1 場的下限）。
    for (const name of ['甲', '乙', '丙', '丁']) {
      await t.registrations.insertSlot({
        eventId: other.id,
        ownerUserId: host.id,
        displayName: name,
        kind: 'proxy',
        status: 'confirmed',
      });
    }
    const b = makeBundle(t);

    const start = await emit(
      b.handler,
      groupTextEvent('@東方 分組 1場', { messageId: 'g-start' }),
    );
    expect(start.recorded).toEqual([['s1', other.id]]);
    expect(start.relatedEventId).not.toBe(ev.id);

    // `下一輪` 不帶 selector、不重跑消歧義（G11）——錨點仍是 session 綁定的那場。
    const next = await emit(b.handler, groupTextEvent('下一輪', { messageId: 'g-next' }));
    expect(next.recorded).toEqual([['s1', other.id]]);
  });
});

describe('D-025 AC-16 / G3：開團公告的 sentMessages id 寫入 message_event_map', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-025 AC-16] `確認` 建立新活動後，reply 的 sentMessages[0].id 對映到新活動 id', async () => {
    const b = makeBundle(t);
    await b.handler.handleEvent(
      groupTextEvent('開團 2999/08/15 07:30 旭陽球場 16人 2200元', { messageId: 'o1' }),
    );
    const result = await b.handler.handleEvent(groupTextEvent('確認', { messageId: 'o2' }));

    const created = (await t.events.listActiveByGroup(G))[0];
    expect(created).toBeDefined();
    expect(result.relatedEventId).toBe(created?.id);

    // server.ts 的寫入路徑（真實 repository）。
    await recordReplyMapping(replyResponse('sent-1'), result.relatedEventId, t.messageEventMap);
    expect(await t.messageEventMap.getEventId('sent-1')).toBe(created?.id);
  });

  it('[D-025 G3] reply 未成功（無 sentMessages）→ 一列都不寫；relatedEventId 為 undefined 亦然', async () => {
    const recorded: [string, number][] = [];
    const spyMap = {
      record: async (messageId: string, eventId: number): Promise<void> => {
        recorded.push([messageId, eventId]);
      },
    };
    await recordReplyMapping(replyResponse(), 1, spyMap); // 空 sentMessages
    await recordReplyMapping(replyResponse('s1'), undefined, spyMap); // 不附錨點
    expect(recorded).toEqual([]);
  });
});
