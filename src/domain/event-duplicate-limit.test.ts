import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { EventRepository } from '../db/repositories/event-repository';
import { EventService, MAX_OPEN_EVENTS_PER_GROUP } from './event-service';
import { formatAlreadyActiveEntry, formatGroupCapacityReached } from './event-formatter';
import type { EventRow } from '../db/schema';

// D-027 開團查重（場地+時間）＋ D-028 同群 open 上限 3 場（T-033c，兩份同批落地）。
// 對真 PG（PG-only）。**未過期**情境一律用遠未來（2999），避免相位干擾查重/上限的判定本身
// ——AC 原文舉例寫 2026-08-15，該日期在本測試撰寫時已過去，改用遠未來不減斷言力。
// **過期相位另有獨立四條**（見檔末 `[D-028 AC-27]` 過期段）：上限與查重的計數集合是「**未過期**
// 的 active」，過期候選不計入、且於 `確認` 交易第一步被 flip 為 done（使用者裁決 2026-09-02）。
// 這四條同時是「3 場過期 open 使群組永久鎖死」的回歸鎖。

const G = 'G-1';
const HOST = 'U-host';

function makeSvc(t: TestDb): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds: [HOST], // 供 AC-27 的 `關閉報名`／`取消活動` 走授權
    logError: () => {},
  });
}

let mid = 0;
const nextMid = (): string => `dl-${(mid += 1)}`;

/** 直接建立一場 open 活動（繞過開團流程，供構造前置候選集合）。 */
async function seedOpen(t: TestDb, location: string, eventDatetime: string): Promise<EventRow> {
  const host = await t.users.upsert(HOST, '主辦人');
  return t.events.create({
    groupId: G,
    hostUserId: host.id,
    eventDatetime,
    location,
    capacity: 16,
    pricePerPerson: 2200,
    priceMode: 'per_person',
    status: 'open',
  });
}

/** 布置一則 awaiting_confirm 對話（供 confirm 直接觸發查重/上限的交易內權威判定）。 */
async function seedConfirmable(
  t: TestDb,
  userId: string,
  draft: { date: string; time: string; location: string },
): Promise<void> {
  await t.conversations.upsert({
    lineUserId: userId,
    groupId: G,
    state: 'awaiting_confirm',
    payload: JSON.stringify({ ...draft, capacity: 16, price: 2200, priceMode: 'per_person' }),
  });
}

/** 逐步問答走到 awaiting_confirm（不含 `確認`）。 */
async function walkToConfirm(
  svc: EventService,
  fields: [string, string, string],
  userId = HOST,
): Promise<void> {
  const [date, time, location] = fields;
  for (const text of [date, time, location, '16', '2200']) {
    await svc.continueFlow({
      groupId: G,
      executorLineUserId: userId,
      messageId: nextMid(),
      text,
      hostDisplayName: '主辦人',
    });
  }
}

describe('D-027 開團查重 / D-028 同群 open 上限', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  // ── D-027 查重 ──────────────────────────────────────────────────────

  it('[D-027 AC-3] 開團查重：一行式入口快速失敗（回衝突活動、不寫 conversation_states、無 DB 副作用）', async () => {
    const svc = makeSvc(t);
    const existing = await seedOpen(t, '東方球場', '2999-08-14T23:30:00Z'); // 台灣 2999-08-15 07:30
    const m = nextMid();
    const r = await svc.handleOneline({
      groupId: G, executorLineUserId: 'U-second', messageId: m,
      date: '2999-08-15', time: '07:30', location: '東方球場',
      capacity: 8, price: 100, priceMode: 'per_person',
    });
    expect(r.kind).toBe('duplicate_event');
    if (r.kind !== 'duplicate_event') return;
    expect(r.event.id).toBe(existing.id); // 帶既存衝突活動（handler 據此附 relatedEventId）
    // 無 DB 副作用：不寫 conversation_states、未新增 event、未 mark（入口純判斷的快速失敗）。
    expect(await t.conversations.get(G, 'U-second')).toBeUndefined();
    expect((await t.events.listActiveByGroup(G)).length).toBe(1);
    expect(await t.processed.has(m)).toBe(false);

    // 場地相同但時間不同、時間相同但場地不同 → **不**視為重複（證明判別鍵是場地+時間的合取）。
    const otherTime = await svc.handleOneline({
      groupId: G, executorLineUserId: 'U-second', messageId: nextMid(),
      date: '2999-08-15', time: '09:30', location: '東方球場',
      capacity: 8, price: 100, priceMode: 'per_person',
    });
    expect(otherTime.kind).toBe('awaiting_confirm');
    const otherVenue = await svc.handleOneline({
      groupId: G, executorLineUserId: 'U-second', messageId: nextMid(),
      date: '2999-08-15', time: '07:30', location: '林口高球場',
      capacity: 8, price: 100, priceMode: 'per_person',
    });
    expect(otherVenue.kind).toBe('awaiting_confirm');
  });

  it('[D-027 AC-4] 開團查重：逐步問答於 `確認` 時失敗（清該列 conversation_states、不 INSERT）', async () => {
    const svc = makeSvc(t);
    const existing = await seedOpen(t, '東方球場', '2999-08-14T23:30:00Z');

    // D-027 §3：`開團` 入口不再查重 → 問答正常開始並走完（欄位齊備才可能比對場地+時間）。
    const start = await svc.startCreation({ groupId: G, executorLineUserId: 'U-second', messageId: nextMid() });
    expect(start.kind).toBe('flow_started');
    await walkToConfirm(svc, ['2999/08/15', '07:30', '東方球場'], 'U-second');
    expect((await t.conversations.get(G, 'U-second'))?.state).toBe('awaiting_confirm');

    const r = await svc.continueFlow({
      groupId: G, executorLineUserId: 'U-second', messageId: nextMid(),
      text: '確認', hostDisplayName: '別人',
    });
    expect(r.kind).toBe('duplicate_event');
    // 該列 conversation_states 被清（nit-2 落敗者清理）、不 INSERT 新 event。
    expect(await t.conversations.get(G, 'U-second')).toBeUndefined();
    const actives = await t.events.listActiveByGroup(G);
    expect(actives.length).toBe(1);
    expect(actives[0]!.id).toBe(existing.id);
  });

  it('[D-027 AC-5] 查重 DB 安全網：並發同場地+時間 `確認` → 僅一人成功，另一人窄捕捉違反回 duplicate_event', async () => {
    const svc = makeSvc(t);
    const draft = { date: '2999-08-15', time: '07:30', location: '東方球場' };
    await seedConfirmable(t, 'U-1', draft);
    await seedConfirmable(t, 'U-2', draft);

    // 兩交易各自於 DEFERRED 快照內 pre-check（互看不到對方未 COMMIT 的列）→ 落敗者於 INSERT 撞
    // ux_events_active_group_venue_time（23505）→ 窄捕捉（**非未捕捉例外**：本 Promise.all 若逸出
    // 例外會直接 reject 使測試失敗）。
    const [r1, r2] = await Promise.all([
      svc.confirm({ groupId: G, executorLineUserId: 'U-1', messageId: nextMid(), hostDisplayName: 'U1' }),
      svc.confirm({ groupId: G, executorLineUserId: 'U-2', messageId: nextMid(), hostDisplayName: 'U2' }),
    ]);
    expect([r1.kind, r2.kind].sort()).toEqual(['created', 'duplicate_event']);
    expect((await t.events.listActiveByGroup(G)).length).toBe(1); // 僅一場成立

    // 應用層查重**不得**取代 DB 安全網（G7 下半／G8）：停用應用層 pre-check（spy 回空候選集合）
    // 後，重複仍必須被 DB 唯一索引擋下並窄捕捉為 duplicate_event。
    await seedConfirmable(t, 'U-3', draft);
    const spy = vi.spyOn(EventRepository.prototype, 'listActiveByGroup').mockResolvedValue([]);
    const r3 = await svc.confirm({ groupId: G, executorLineUserId: 'U-3', messageId: nextMid(), hostDisplayName: 'U3' });
    spy.mockRestore();
    expect(r3.kind).toBe('duplicate_event');
    expect((await t.events.listActiveByGroup(G)).length).toBe(1);
    expect(await t.conversations.get(G, 'U-3')).toBeUndefined(); // 落敗者流程被清
  });

  // ── D-028 上限 ──────────────────────────────────────────────────────

  it('[D-028 AC-25] 上限：剛好 3 場時第 4 場被拒（(a) 一行式、(b) 逐步問答）', async () => {
    const svc = makeSvc(t);
    await seedOpen(t, '東方球場', '2999-08-14T23:30:00Z');
    await seedOpen(t, '林口高球場', '2999-08-15T23:30:00Z');
    await seedOpen(t, '大屯高球場', '2999-08-16T23:30:00Z');
    expect((await t.events.listActiveByGroup(G)).length).toBe(MAX_OPEN_EVENTS_PER_GROUP);

    // (a) 一行式：**刻意用與既有第一場完全相同的場地+時間**——若上限判斷沒有先於查重（G13），
    // 這裡會回 duplicate_event。回 group_open_limit 即證明「先上限、後查重」的固定順序。
    const ma = nextMid();
    const a = await svc.handleOneline({
      groupId: G, executorLineUserId: 'U-second', messageId: ma,
      date: '2999-08-15', time: '07:30', location: '東方球場',
      capacity: 10, price: 100, priceMode: 'per_person',
    });
    expect(a.kind).toBe('group_open_limit');
    expect(await t.conversations.get(G, 'U-second')).toBeUndefined(); // 不寫 conversation_states
    expect(await t.processed.has(ma)).toBe(false);

    // (b) 逐步問答：不進入 awaiting_date、不寫 conversation_states。
    const mb = nextMid();
    const b = await svc.startCreation({ groupId: G, executorLineUserId: 'U-second', messageId: mb });
    expect(b.kind).toBe('group_open_limit');
    expect(await t.conversations.get(G, 'U-second')).toBeUndefined();
    expect(await t.processed.has(mb)).toBe(false);

    // 三場皆未被動到（拒絕路徑零寫入）。
    expect((await t.events.listActiveByGroup(G)).length).toBe(MAX_OPEN_EVENTS_PER_GROUP);
  });

  it('[D-028 AC-26] 上限文案逐字比對，且與查重文案不混用', async () => {
    const limitText = formatGroupCapacityReached().text;
    expect(limitText).toBe('此群組已有 3 場進行中的球敘，請等其中一場結束後再開新團');
    // 不帶任何活動明細（日期／場地／時間皆不出現）。
    for (const detail of ['2999', '08-15', '08/15', '07:30', '東方球場', '元', '人']) {
      expect(limitText).not.toContain(detail);
    }
    // 與查重文案為兩則**不同**訊息，不得互相替代。
    const event: EventRow = {
      id: 1, group_id: G, host_user_id: 1, event_datetime: '2999-08-14T23:30:00Z',
      location: '東方球場', capacity: 16, price_per_person: 2200, price_mode: 'per_person',
      venue_fee: null, settled_per_person: null, status: 'open',
      created_at: '2999-01-01T00:00:00Z', updated_at: '2999-01-01T00:00:00Z',
    } as EventRow;
    const dupText = formatAlreadyActiveEntry(event).text;
    expect(dupText).not.toBe(limitText);
    expect(dupText).toContain('東方球場'); // 查重訊息帶衝突活動明細
    expect(limitText).not.toContain('無法再開新團'); // 兩句用語不重疊，肉眼可辨
  });

  it('[D-028 AC-27] 上限為動態計算：關閉一場後候選降為 2 → 一行式與逐步問答皆能再開', async () => {
    const svc = makeSvc(t);
    const first = await seedOpen(t, '東方球場', '2999-08-14T23:30:00Z');
    const second = await seedOpen(t, '林口高球場', '2999-08-15T23:30:00Z');
    await seedOpen(t, '大屯高球場', '2999-08-16T23:30:00Z');
    expect((await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() })).kind)
      .toBe('group_open_limit');

    // (1) `關閉報名` 釋出一席（候選 3 → 2）→ 一行式開團成功建立。
    const closed = await svc.closeEvent({ groupId: G, eventId: first.id, executorLineUserId: HOST, messageId: nextMid() });
    expect(closed.kind).toBe('ok');
    expect((await t.events.listActiveByGroup(G)).length).toBe(2);

    const oneline = await svc.handleOneline({
      groupId: G, executorLineUserId: HOST, messageId: nextMid(),
      date: '2999-09-01', time: '08:00', location: '大溪高球場',
      capacity: 10, price: 100, priceMode: 'per_person',
    });
    expect(oneline.kind).toBe('awaiting_confirm');
    const createdA = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: nextMid(), hostDisplayName: '主辦人' });
    expect(createdA.kind).toBe('created');
    expect((await t.events.listActiveByGroup(G)).length).toBe(3);

    // (2) 再以 `取消活動` 釋出一席（候選 3 → 2）→ 逐步問答開團成功建立。
    const cancelled = await svc.cancelEvent({ groupId: G, eventId: second.id, executorLineUserId: HOST, messageId: nextMid() });
    expect(cancelled.kind).toBe('ok');
    expect((await t.events.listActiveByGroup(G)).length).toBe(2);

    const start = await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(start.kind).toBe('flow_started');
    if (start.kind === 'flow_started') expect(start.state).toBe('awaiting_date');
    await walkToConfirm(svc, ['2999/09/02', '08:00', '幸福高球場']);
    const createdB = await svc.continueFlow({
      groupId: G, executorLineUserId: HOST, messageId: nextMid(),
      text: '確認', hostDisplayName: '主辦人',
    });
    expect(createdB.kind).toBe('created');
    expect((await t.events.listActiveByGroup(G)).length).toBe(3);

    // 上限並未「記住這是第幾場」：回到 3 場後再開仍被擋。
    expect((await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() })).kind)
      .toBe('group_open_limit');
  });
  // ── D-028 AC-27（過期相位）：上限只數未過期候選 + `確認` 交易內 flip 全部過期候選 ──────
  //
  // 使用者裁決（2026-09-02）：①過期活動不計入上限；②flip 全部過期候選（非只最新一場）。
  // 若把過期候選計入上限，3 場過期 open 會讓兩個入口都在 `確認` 之前擋下 ⇒ 唯一的 flip 點
  // （`confirm` 交易內）永不可達＝**該群組再也開不了團**。以下四條即該死鎖的回歸鎖。
  const PAST_A = '2000-01-01T00:00:00Z';
  const PAST_B = '2000-02-01T00:00:00Z';
  const PAST_C = '2000-03-01T00:00:00Z';

  it('[D-028 AC-27] 過期不計入上限：3 場全過期 open → 一行式與逐步問答兩個入口皆放行（死鎖回歸鎖）', async () => {
    const svc = makeSvc(t);
    await seedOpen(t, '東方球場', PAST_A);
    await seedOpen(t, '林口高球場', PAST_B);
    await seedOpen(t, '大屯高球場', PAST_C);
    expect((await t.events.listActiveByGroup(G)).length).toBe(3); // 三場仍是 open（入口不 flip）

    // (a) 逐步問答入口：不得回 group_open_limit。
    const start = await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(start.kind).toBe('flow_started');
    await svc.abort({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });

    // (b) 一行式入口：同樣放行；且入口**不 flip**（三場仍為 open，D-008 §1b）。
    const oneline = await svc.handleOneline({
      groupId: G, executorLineUserId: HOST, messageId: nextMid(),
      date: '2999-09-01', time: '08:00', location: '大溪高球場',
      capacity: 10, price: 100, priceMode: 'per_person',
    });
    expect(oneline.kind).toBe('awaiting_confirm');
    expect((await t.events.listActiveByGroup(G)).length).toBe(3);
  });

  it('[D-028 AC-27] 過期候選於 `確認` 交易內**全部** flip 為 done，新活動建立成功', async () => {
    const svc = makeSvc(t);
    const a = await seedOpen(t, '東方球場', PAST_A);
    const b = await seedOpen(t, '林口高球場', PAST_B);
    const c = await seedOpen(t, '大屯高球場', PAST_C);

    await seedConfirmable(t, HOST, { date: '2999-09-01', time: '08:00', location: '大溪高球場' });
    const r = await svc.confirm({ groupId: G, executorLineUserId: HOST, messageId: nextMid(), hostDisplayName: '主辦人' });
    expect(r.kind).toBe('created');

    // **三場**過期候選皆 flip（不是只有最新一場）；候選集合只剩新建的那場。
    for (const old of [a, b, c]) expect((await t.events.getById(old.id))?.status).toBe('done');
    const actives = await t.events.listActiveByGroup(G);
    expect(actives.length).toBe(1);
    if (r.kind === 'created') expect(actives[0]!.id).toBe(r.event.id);
  });

  it('[D-028 AC-27] 混合相位：2 場未過期 + 1 場已過期 → 上限只數 2，開團放行', async () => {
    const svc = makeSvc(t);
    await seedOpen(t, '東方球場', '2999-08-14T23:30:00Z');
    await seedOpen(t, '林口高球場', '2999-08-15T23:30:00Z');
    const expired = await seedOpen(t, '大屯高球場', PAST_A);
    expect((await t.events.listActiveByGroup(G)).length).toBe(3); // 原始候選 3 場

    const start = await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() });
    expect(start.kind).toBe('flow_started');
    await walkToConfirm(svc, ['2999/09/02', '08:00', '幸福高球場']);
    const created = await svc.continueFlow({
      groupId: G, executorLineUserId: HOST, messageId: nextMid(),
      text: '確認', hostDisplayName: '主辦人',
    });
    expect(created.kind).toBe('created');
    expect((await t.events.getById(expired.id))?.status).toBe('done'); // 過期那場已 flip
    expect((await t.events.listActiveByGroup(G)).length).toBe(3); // 2 場未過期 + 1 場新建
  });

  it('[D-028 AC-27] 上限未被改鬆：3 場**未過期** open 仍回 group_open_limit（兩入口）', async () => {
    const svc = makeSvc(t);
    await seedOpen(t, '東方球場', '2999-08-14T23:30:00Z');
    await seedOpen(t, '林口高球場', '2999-08-15T23:30:00Z');
    await seedOpen(t, '大屯高球場', '2999-08-16T23:30:00Z');

    expect((await svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: nextMid() })).kind)
      .toBe('group_open_limit');
    const oneline = await svc.handleOneline({
      groupId: G, executorLineUserId: HOST, messageId: nextMid(),
      date: '2999-09-01', time: '08:00', location: '大溪高球場',
      capacity: 10, price: 100, priceMode: 'per_person',
    });
    expect(oneline.kind).toBe('group_open_limit');
    expect(await t.conversations.get(G, HOST)).toBeUndefined();
  });
});
