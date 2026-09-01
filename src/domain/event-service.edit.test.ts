import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { taipeiToUtcIso } from '../db/time';
import type { EventRow, PriceMode } from '../db/schema';
import { UserRepository } from '../db/repositories/user-repository';
import { EventRepository } from '../db/repositories/event-repository';
import { EventService, type EditEventRequest, type EditEventResult } from './event-service';
import { RegistrationService } from './registration-service';

// D-015 編輯活動資訊：domain 層驗收（PG 真交易 + FOR UPDATE）。
//
// 時鐘：本專案 domain 以 nowIso() 取時（D-015 §2「service 取一次」），故需要「固定 now」的
// 案例（AC-2/AC-3）以 vi.useFakeTimers({ toFake: ['Date'] }) 凍結——**只假造 Date**，
// 不動 setTimeout/setInterval，避免 pg 連線池的計時器被凍住而卡死。
// 時間欄皆為 TEXT（migration 0001），pg 不會反序列化為 Date，故凍結 Date 對 DB 無副作用。

const HOST = 'U-host';
const ADMIN = 'U-admin';
const OUTSIDER = 'U-outsider';

function makeService(t: TestDb, adminIds: string[] = []): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    runImmediate: t.runImmediate,
    superAdminUserIds: adminIds,
    logError: () => {},
  });
}

function makeRegService(t: TestDb): RegistrationService {
  return new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    superAdminUserIds: [],
    logError: () => {},
  });
}

let mid = 0;
function nextMid(): string {
  mid += 1;
  return `m${mid}`;
}

interface SeedOpts {
  groupId: string;
  /** 台灣本地日期 `YYYY-MM-DD`。 */
  date: string;
  /** 台灣本地時間 `HH:MM`。 */
  time: string;
  capacity?: number;
  location?: string;
  priceMode?: PriceMode;
  price?: number;
  venueFee?: number;
  status?: EventRow['status'];
}

async function seed(t: TestDb, o: SeedOpts): Promise<EventRow> {
  const host = await t.users.upsert(HOST, '主辦人');
  return t.events.create({
    groupId: o.groupId,
    hostUserId: host.id,
    eventDatetime: taipeiToUtcIso(o.date, o.time),
    location: o.location ?? '東方場地',
    capacity: o.capacity ?? 16,
    priceMode: o.priceMode ?? 'per_person',
    ...(o.priceMode === 'split_venue'
      ? { venueFee: o.venueFee ?? 3000 }
      : { pricePerPerson: o.price ?? 2000 }),
    status: o.status ?? 'open',
  });
}

function edit(
  svc: EventService,
  groupId: string,
  request: EditEventRequest,
  opts: { executor?: string; messageId?: string } = {},
): Promise<EditEventResult> {
  return svc.editEvent({
    groupId,
    executorLineUserId: opts.executor ?? HOST,
    messageId: opts.messageId ?? nextMid(),
    request,
  });
}

const setField = (field: 'date' | 'time' | 'location' | 'fee', value: string): EditEventRequest => ({
  kind: 'set',
  field,
  value,
});

/** 整列 before/after diff：回傳有差異的欄位名（G2 逐欄斷言用）。 */
function changedColumns(before: EventRow, after: EventRow): string[] {
  return (Object.keys(before) as (keyof EventRow)[])
    .filter((k) => before[k] !== after[k])
    .map((k) => String(k));
}

/**
 * G2 斷言：除 `target` 與 `updated_at` 外逐欄相等，且 `target` 必須改變。
 * `updated_at` 為秒精度，同秒內更新可能不變 → 只允許出現、不強制出現。
 */
function expectOnlyChanged(before: EventRow, after: EventRow, target: keyof EventRow): void {
  const changed = changedColumns(before, after);
  expect(changed).toContain(String(target));
  expect(changed.filter((c) => c !== String(target) && c !== 'updated_at')).toEqual([]);
}

function freezeAt(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

describe('EventService.editEvent（D-015）', () => {
  let t: TestDb;
  beforeEach(async () => {
    mid = 0;
    t = await createTestDb();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await t.cleanup();
  });

  // ── AC-1 併發 ────────────────────────────────────────────────────
  it('[D-015 AC-1] `編輯 日期` 與 `編輯 時間` 真並行 → 序列化後兩者**同時**生效（不互相覆蓋）', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30' });
    const svc = makeService(t);

    const [r1, r2] = await Promise.all([
      edit(svc, 'G', setField('date', '2999-09-01'), { messageId: nextMid() }),
      edit(svc, 'G', setField('time', '06:00'), { messageId: nextMid() }),
    ]);
    expect([r1.kind, r2.kind]).toEqual(['ok', 'ok']);

    // 若第二者用了交易外快照（而非鎖內 getById 重讀），必有一半被覆蓋回舊值。
    const after = await t.events.getById(ev.id);
    expect(after?.event_datetime).toBe(taipeiToUtcIso('2999-09-01', '06:00'));
  });

  // ── AC-2 read-modify-write + 逐欄斷言 ──────────────────────────────
  it('[D-015 AC-2] 改日期保留時間、再改時間保留日期；除 event_datetime/updated_at 外逐欄相等', async () => {
    freezeAt('2026-08-01T00:00:00Z'); // 台北 2026-08-01 08:00 → 2026-08-15 07:30 尚未過期
    const ev = await seed(t, { groupId: 'G', date: '2026-08-15', time: '07:30' });
    const svc = makeService(t);

    const r1 = await edit(svc, 'G', setField('date', '2026-09-01'));
    expect(r1.kind).toBe('ok');
    if (r1.kind === 'ok') {
      expect(r1.before).toBe('2026-08-15 07:30');
      expect(r1.after).toBe('2026-09-01 07:30');
    }
    const mid1 = await t.events.getById(ev.id);
    expect(mid1?.event_datetime).toBe(taipeiToUtcIso('2026-09-01', '07:30'));
    expectOnlyChanged(ev, mid1!, 'event_datetime');

    const r2 = await edit(svc, 'G', setField('time', '06:00'));
    expect(r2.kind).toBe('ok');
    if (r2.kind === 'ok') {
      expect(r2.before).toBe('2026-09-01 07:30');
      expect(r2.after).toBe('2026-09-01 06:00');
    }
    const fin = await t.events.getById(ev.id);
    expect(fin?.event_datetime).toBe(taipeiToUtcIso('2026-09-01', '06:00'));
    expectOnlyChanged(mid1!, fin!, 'event_datetime');
  });

  // ── AC-3 不得改到過去 ──────────────────────────────────────────────
  it('[D-015 AC-3] 注入固定 now：改到昨日／今日已過時刻 → past_datetime、event_datetime 不變', async () => {
    freezeAt('2026-08-15T00:00:00Z'); // 台北 2026-08-15 08:00
    const ev = await seed(t, { groupId: 'G', date: '2026-08-15', time: '20:00' }); // 今日稍晚，未過期
    const svc = makeService(t);

    // (a) 昨日
    const r1 = await edit(svc, 'G', setField('date', '2026-08-14'));
    expect(r1.kind).toBe('past_datetime');
    if (r1.kind === 'past_datetime') expect(r1.now).toBe('2026-08-15T00:00:00Z');
    expect((await t.events.getById(ev.id))?.event_datetime).toBe(ev.event_datetime);

    // (b) 今日已過時刻（現在台北 08:00，改成 07:00）
    const r2 = await edit(svc, 'G', setField('time', '07:00'));
    expect(r2.kind).toBe('past_datetime');
    expect((await t.events.getById(ev.id))?.event_datetime).toBe(ev.event_datetime);

    // (c) 邊界：恰等於 now（台北 08:00）亦視為過去（`newIso <= now`）。
    const r3 = await edit(svc, 'G', setField('time', '08:00'));
    expect(r3.kind).toBe('past_datetime');
    expect((await t.events.getById(ev.id))?.event_datetime).toBe(ev.event_datetime);

    // (d) 未來一分鐘 → 允許（證明不是把 time 編輯整條擋掉）。
    const r4 = await edit(svc, 'G', setField('time', '08:01'));
    expect(r4.kind).toBe('ok');
    expect((await t.events.getById(ev.id))?.event_datetime).toBe(
      taipeiToUtcIso('2026-08-15', '08:01'),
    );
  });

  // ── AC-4 授權 ─────────────────────────────────────────────────────
  it('[D-015 AC-4] 非 host 非 admin → not_authorized、events 無變動、users 無新列（僅 processed_events +1）', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30' });
    const svc = makeService(t, [ADMIN]);

    const usersBefore = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM users');
    const r = await edit(svc, 'G', setField('location', '新場地'), { executor: OUTSIDER });
    expect(r.kind).toBe('not_authorized');

    const after = await t.events.getById(ev.id);
    expect(changedColumns(ev, after!)).toEqual([]); // events 完全無變動
    const usersAfter = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM users');
    expect(usersAfter.rows[0]?.n).toBe(usersBefore.rows[0]?.n); // 非授權者不得 upsert users（G4）
    // 但仍消費 message.id（有回覆 ⇒ 去重，G5 明文例外）。
    const proc = await t.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM processed_events');
    expect(Number(proc.rows[0]?.n)).toBe(1);
  });

  it('[D-015 AC-4] host 與 super-admin 皆可成功', async () => {
    await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30' });
    const svc = makeService(t, [ADMIN]);
    expect((await edit(svc, 'G', setField('location', 'L1'), { executor: HOST })).kind).toBe('ok');
    expect((await edit(svc, 'G', setField('location', 'L2'), { executor: ADMIN })).kind).toBe('ok');
  });

  // ── AC-5 三種拒絕分流 ───────────────────────────────────────────────
  it('[D-015 AC-5] closed → closed_not_editable；過期 open → event_ended；無活動／cancelled → no_active；三者皆無 UPDATE', async () => {
    const svc = makeService(t);

    // (a) closed（已離開 active 集 → 走 (B) 路徑，以 findLatestDisplayable 判別）
    const closed = await seed(t, { groupId: 'Gc', date: '2999-01-01', time: '07:30', status: 'closed' });
    const rc = await edit(svc, 'Gc', setField('location', 'X'));
    expect(rc.kind).toBe('closed_not_editable');
    expect(changedColumns(closed, (await t.events.getById(closed.id))!)).toEqual([]);

    // (b) 過期 open
    const ended = await seed(t, { groupId: 'Ge', date: '2000-01-01', time: '07:30' });
    const re = await edit(svc, 'Ge', setField('location', 'X'));
    expect(re.kind).toBe('event_ended');
    expect(changedColumns(ended, (await t.events.getById(ended.id))!)).toEqual([]);

    // (c) cancelled（不在 active 也不在 displayable 集）
    const cancelled = await seed(t, { groupId: 'Gx', date: '2999-01-01', time: '07:30', status: 'cancelled' });
    const rx = await edit(svc, 'Gx', setField('location', 'X'));
    expect(rx.kind).toBe('no_active');
    expect(changedColumns(cancelled, (await t.events.getById(cancelled.id))!)).toEqual([]);

    // (d) 完全無活動
    expect((await edit(svc, 'G-none', setField('location', 'X'))).kind).toBe('no_active');
  });

  // ── AC-3（D-019 版）費用同模式只改金額，零回歸 ───────────────────────
  it('[D-019 AC-3] per_person：`2500` 與 `2500元` 皆成功；同模式不切換；逐欄斷言', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', price: 2000 });
    const svc = makeService(t);

    const r1 = await edit(svc, 'G', setField('fee', '2500'));
    expect(r1.kind).toBe('ok');
    if (r1.kind === 'ok') {
      expect(r1.before).toBe('2000');
      expect(r1.after).toBe('2500');
      expect(r1.perPerson).toBeUndefined(); // per_person 不帶攤額
      expect(r1.feeModeSwitched).toBe(false); // D-019 §一.3：恆賦值 switched；未切換即 false
    }
    const a1 = await t.events.getById(ev.id);
    expect(a1?.price_per_person).toBe(2500);
    expect(a1?.price_mode).toBe('per_person');
    expectOnlyChanged(ev, a1!, 'price_per_person');

    // `2500 元` 經 parser compact 為 `2500元`（F2）→ validatePrice 去尾綴後成立。
    const r2 = await edit(svc, 'G', setField('fee', '3000元'));
    expect(r2.kind).toBe('ok');
    const a2 = await t.events.getById(ev.id);
    expect(a2?.price_per_person).toBe(3000);
    expectOnlyChanged(a1!, a2!, 'price_per_person');
  });

  it('[D-019 AC-3] split：`場地費 4000`（含空格）同模式成功、攤額以**改後值**算、settled_per_person 仍 NULL', async () => {
    const ev = await seed(t, {
      groupId: 'G',
      date: '2999-08-15',
      time: '07:30',
      priceMode: 'split_venue',
      venueFee: 3000,
      capacity: 16,
    });
    const svc = makeService(t);
    const reg = makeRegService(t);
    // 撐 3 位有效正取（K=3）→ ceil(4000/3)=1334。
    await reg.signup({
      groupId: 'G',
      executorLineUserId: 'U-a',
      executorDisplayName: 'a',
      messageId: nextMid(),
      count: 3,
    });

    // parser 對 `編輯 費用 場地費 4000` 產出 compact 後的 `場地費4000`（F2）。
    const r = await edit(svc, 'G', setField('fee', '場地費4000'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.before).toBe('3000');
      expect(r.after).toBe('4000');
      expect(r.confirmedCount).toBe(3);
      expect(r.perPerson).toBe(Math.ceil(4000 / 3)); // 以改後 venue_fee 算，非 3000
      expect(r.feeModeSwitched).toBe(false); // 同上：同模式改金額 → false，非省略
    }
    const after = await t.events.getById(ev.id);
    expect(after?.venue_fee).toBe(4000);
    expect(after?.price_mode).toBe('split_venue');
    expect(after?.settled_per_person).toBeNull();
    expectOnlyChanged(ev, after!, 'venue_fee');
  });

  // ── AC-4（D-019 版）真 bad_fee：純格式不合法，兩模式皆同一文案／無 UPDATE ──────
  it('[D-019 AC-4] per_person 與 split 皆對 `abc` 回 bad_fee（純格式錯，與模式無關）；無 UPDATE', async () => {
    for (const priceMode of ['per_person', 'split_venue'] as const) {
      const ev = await seed(t, {
        groupId: `G-${priceMode}`,
        date: '2999-08-15',
        time: '07:30',
        priceMode,
        venueFee: 3000,
        price: 2000,
      });
      const svc = makeService(t);
      const r = await edit(svc, `G-${priceMode}`, setField('fee', 'abc'));
      expect(r.kind).toBe('bad_fee');
      expect(changedColumns(ev, (await t.events.getById(ev.id))!)).toEqual([]);
    }
  });

  it('[D-019 AC-4] split 收到非正整數（`場地費0`）→ bad_fee、無 UPDATE', async () => {
    const ev = await seed(t, {
      groupId: 'G',
      date: '2999-08-15',
      time: '07:30',
      priceMode: 'split_venue',
      venueFee: 3000,
    });
    const svc = makeService(t);
    const r = await edit(svc, 'G', setField('fee', '場地費0'));
    expect(r.kind).toBe('bad_fee');
    expect(changedColumns(ev, (await t.events.getById(ev.id))!)).toEqual([]);
  });

  // ── AC-7 人數導向 ───────────────────────────────────────────────────
  it('[D-015 AC-7] `編輯 人數 12` 與 `編輯 人數` → capacity 導向、capacity 不變、無 UPDATE、message.id 已消費', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', capacity: 16 });
    const svc = makeService(t);

    const m = nextMid();
    const r = await edit(svc, 'G', { kind: 'capacity' }, { messageId: m });
    expect(r.kind).toBe('capacity');
    const after = await t.events.getById(ev.id);
    expect(after?.capacity).toBe(16);
    expect(changedColumns(ev, after!)).toEqual([]); // 連 updated_at 都不該動（無 UPDATE）
    // 已消費 → 同 messageId 重送即 duplicate。
    expect((await edit(svc, 'G', { kind: 'capacity' }, { messageId: m })).kind).toBe('duplicate');
  });

  // ── AC-8 去重全分支 ─────────────────────────────────────────────────
  it('[D-015 AC-8] G5 列舉之每一分支：同 messageId 送第二次 → 一律 duplicate、無二次寫入', async () => {
    const svc = makeService(t, [ADMIN]);

    // 每列一個獨立 group，避免互相干擾。
    const cases: { name: string; groupId: string; request: EditEventRequest; executor?: string; expect: EditEventResult['kind'] }[] = [];

    await seed(t, { groupId: 'G-ok', date: '2999-08-15', time: '07:30' });
    cases.push({ name: 'ok', groupId: 'G-ok', request: setField('location', '新場地'), expect: 'ok' });

    await seed(t, { groupId: 'G-help', date: '2999-08-15', time: '07:30' });
    cases.push({ name: 'help', groupId: 'G-help', request: { kind: 'help' }, expect: 'help' });

    await seed(t, { groupId: 'G-cap', date: '2999-08-15', time: '07:30' });
    cases.push({ name: 'capacity', groupId: 'G-cap', request: { kind: 'capacity' }, expect: 'capacity' });

    await seed(t, { groupId: 'G-auth', date: '2999-08-15', time: '07:30' });
    cases.push({
      name: 'not_authorized',
      groupId: 'G-auth',
      request: setField('location', 'X'),
      executor: OUTSIDER,
      expect: 'not_authorized',
    });

    cases.push({ name: 'no_active', groupId: 'G-none', request: setField('location', 'X'), expect: 'no_active' });

    await seed(t, { groupId: 'G-closed', date: '2999-01-01', time: '07:30', status: 'closed' });
    cases.push({
      name: 'closed_not_editable',
      groupId: 'G-closed',
      request: setField('location', 'X'),
      expect: 'closed_not_editable',
    });

    await seed(t, { groupId: 'G-ended', date: '2000-01-01', time: '07:30' });
    cases.push({ name: 'event_ended', groupId: 'G-ended', request: setField('location', 'X'), expect: 'event_ended' });

    await seed(t, { groupId: 'G-past', date: '2999-08-15', time: '07:30' });
    cases.push({ name: 'past_datetime', groupId: 'G-past', request: setField('date', '2000-01-01'), expect: 'past_datetime' });

    await seed(t, { groupId: 'G-fee', date: '2999-08-15', time: '07:30', price: 2000 });
    cases.push({ name: 'bad_fee', groupId: 'G-fee', request: setField('fee', 'abc'), expect: 'bad_fee' });

    // format_error 兩條經 handler 新分支的路徑（invalid(edit_event)）。
    await seed(t, { groupId: 'G-fmt', date: '2999-08-15', time: '07:30' });
    cases.push({
      name: 'format_error(date)',
      groupId: 'G-fmt',
      request: { kind: 'format_error', field: 'date' },
      expect: 'format_error',
    });
    await seed(t, { groupId: 'G-loc', date: '2999-08-15', time: '07:30' });
    cases.push({
      name: 'format_error(location/bad_location)',
      groupId: 'G-loc',
      request: { kind: 'format_error', field: 'location', detail: { len: 41 } },
      expect: 'format_error',
    });

    for (const c of cases) {
      const m = `dedup-${c.name}`;
      const first = await edit(svc, c.groupId, c.request, { executor: c.executor, messageId: m });
      expect(first.kind, `${c.name} 第一次`).toBe(c.expect);
      const snapshot = await t.events.findLatestDisplayable(c.groupId);
      const second = await edit(svc, c.groupId, c.request, { executor: c.executor, messageId: m });
      expect(second.kind, `${c.name} 第二次`).toBe('duplicate');
      const after = await t.events.findLatestDisplayable(c.groupId);
      if (snapshot !== undefined && after !== undefined) {
        expect(changedColumns(snapshot, after), `${c.name} 無二次寫入`).toEqual([]);
      }
    }
  });

  // ── AC-11 場地 40 字上限 ────────────────────────────────────────────
  it('[D-015 AC-11] 場地 40 字成功且逐欄斷言；bad_location 由邊界層攔下，location 不變', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30' });
    const svc = makeService(t);

    const len40 = 'ㄅ'.repeat(40);
    const r = await edit(svc, 'G', setField('location', len40));
    expect(r.kind).toBe('ok');
    const after = await t.events.getById(ev.id);
    expect(after?.location).toBe(len40);
    expectOnlyChanged(ev, after!, 'location');

    // 41 字在 parser 即成為 invalid(bad_location) → handler 轉 format_error（見 parse/handler 測試）；
    // domain 收到 format_error 一律不 UPDATE、不截斷。
    const r2 = await edit(svc, 'G', { kind: 'format_error', field: 'location', detail: { len: 41 } });
    expect(r2.kind).toBe('format_error');
    if (r2.kind === 'format_error') expect(r2.detail).toEqual({ len: 41 });
    const after2 = await t.events.getById(ev.id);
    expect(after2?.location).toBe(len40); // 不截斷、不改寫
    expect(changedColumns(after!, after2!)).toEqual([]);
  });

  // ── AC-12 mention 對象（domain 部分：去重與只取 confirmed） ───────────
  it('[D-015 AC-12] tagOwnerIds 只含 confirmed 且依 owner 去重（代報列歸代報者本人）', async () => {
    await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', capacity: 3 });
    const svc = makeService(t);
    const reg = makeRegService(t);

    // A：兩列自報名（+2）→ 去重後只算一個 owner。
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-A', executorDisplayName: 'A', messageId: nextMid(), count: 2 });
    // B：代報一位「陳大哥」→ owner 是 B（代報者本人），不得 tag 被代報者。
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-B', executorDisplayName: 'B', messageId: nextMid(), count: 1, proxyName: '陳大哥' });
    // C/D：候補（capacity=3 已滿）→ 不得入 tag。
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-C', executorDisplayName: 'C', messageId: nextMid(), count: 1 });
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-D', executorDisplayName: 'D', messageId: nextMid(), count: 1 });

    const r = await edit(svc, 'G', setField('location', '新場地'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    const a = await t.users.getByLineUserId('U-A');
    const b = await t.users.getByLineUserId('U-B');
    const c = await t.users.getByLineUserId('U-C');
    const d = await t.users.getByLineUserId('U-D');
    expect(r.tagOwnerIds).toEqual([a!.id, b!.id]); // 恰 2 個不重複 owner、依 seq 首見序
    expect(r.tagOwnerIds).not.toContain(c!.id);
    expect(r.tagOwnerIds).not.toContain(d!.id);
    expect(r.confirmedCount).toBe(3); // K 為正取**列數**（A 兩列 + B 一列），與去重後 owner 數不同
    expect(r.overflow).toBe(false);
  });

  // ── AC-14 不延長鎖期 ────────────────────────────────────────────────
  it('[D-015 AC-14] 成功路徑：鎖內 users 查詢 ≤ 1（僅授權解析），逐人解析不在交易內', async () => {
    await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', capacity: 10 });
    const svc = makeService(t);
    const reg = makeRegService(t);
    for (const n of ['a', 'b', 'c', 'd']) {
      await reg.signup({ groupId: 'G', executorLineUserId: `U-${n}`, executorDisplayName: n, messageId: nextMid(), count: 1 });
    }

    // editEvent 全程只有「鎖內」會碰 users（service 自身在交易外不查 users），
    // 故此處的總呼叫數即鎖內呼叫數。
    const byLineId = vi.spyOn(UserRepository.prototype, 'getByLineUserId');
    const byId = vi.spyOn(UserRepository.prototype, 'getById');

    const r = await edit(svc, 'G', setField('location', '新場地'), { executor: HOST });
    expect(r.kind).toBe('ok');
    // seed() 直接建列（非走 `確認` 流程）故主辦未自動報名 → 4 位正取 owner。
    if (r.kind === 'ok') expect(r.tagOwnerIds.length).toBe(4);

    expect(byLineId).toHaveBeenCalledTimes(1); // canManageEvent 唯一那次
    expect(byId).toHaveBeenCalledTimes(0); // 逐人解析（N+1）不得發生在 service/鎖內
  });

  it('[D-015 AC-14] super-admin 執行：鎖內 users 查詢為 0（命中集合即放行，不查 DB）', async () => {
    await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30' });
    const svc = makeService(t, [ADMIN]);
    const byLineId = vi.spyOn(UserRepository.prototype, 'getByLineUserId');
    const r = await edit(svc, 'G', setField('location', 'L'), { executor: ADMIN });
    expect(r.kind).toBe('ok');
    expect(byLineId).toHaveBeenCalledTimes(0);
  });

  // ── G2 封閉集：`編輯` 不得動 capacity / price_mode / status / settled_per_person ──
  it('[D-015 AC-2] 任一欄編輯皆不得改到 capacity／price_mode／status／settled_per_person／group_id／host_user_id', async () => {
    const ev = await seed(t, {
      groupId: 'G',
      date: '2999-08-15',
      time: '07:30',
      priceMode: 'split_venue',
      venueFee: 3000,
    });
    const svc = makeService(t);
    for (const req of [
      setField('date', '2999-10-01'),
      setField('time', '09:00'),
      setField('location', '別的場地'),
      setField('fee', '場地費5000'),
    ]) {
      expect((await edit(svc, 'G', req)).kind).toBe('ok');
    }
    const after = await t.events.getById(ev.id);
    expect(after?.capacity).toBe(ev.capacity);
    expect(after?.price_mode).toBe(ev.price_mode);
    expect(after?.status).toBe(ev.status);
    expect(after?.settled_per_person).toBeNull();
    expect(after?.group_id).toBe(ev.group_id);
    expect(after?.host_user_id).toBe(ev.host_user_id);
    expect(after?.price_per_person).toBe(ev.price_per_person); // split 模式恆為 0，不因改場地費而動
  });
});

// ── D-019：`編輯 費用` 支援切換計費模式（per_person ↔ split_venue） ──────────────
describe('EventService.editEvent（D-019 費用切換計費模式）', () => {
  let t: TestDb;
  beforeEach(async () => {
    mid = 0;
    t = await createTestDb();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await t.cleanup();
  });

  // ── AC-1：per_person → split_venue 切換成功 ─────────────────────────
  it('[D-019 AC-1] per_person→split_venue：三欄同動、回覆帶標籤全稱＋攤額子句', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', capacity: 16, price: 2200 });
    const svc = makeService(t);
    const reg = makeRegService(t);
    // 撐 4 位正取（K=4，含主辦自動報名不算——seed 直接建列非走確認流程，故僅這 4 位）。
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'a', messageId: nextMid(), count: 4 });

    const r = await edit(svc, 'G', setField('fee', '場地費4000'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.feeModeSwitched).toBe(true);
      expect(r.before).toBe('每人費用 2200 元');
      expect(r.after).toBe('場地費 4000 元');
      expect(r.confirmedCount).toBe(4);
      expect(r.perPerson).toBe(Math.ceil(4000 / 4));
    }
    const after = await t.events.getById(ev.id);
    expect(after?.price_mode).toBe('split_venue');
    expect(after?.price_per_person).toBe(0);
    expect(after?.venue_fee).toBe(4000);
    // 整列 diff：除三欄與 updated_at 外逐欄相等。
    const changed = changedColumns(ev, after!).filter((c) => c !== 'updated_at').sort();
    expect(changed).toEqual(['price_mode', 'price_per_person', 'venue_fee']);
  });

  // ── AC-2：split_venue → per_person 切換成功 ─────────────────────────
  it('[D-019 AC-2] split_venue→per_person：三欄同動、回覆不附攤額子句', async () => {
    const ev = await seed(t, {
      groupId: 'G',
      date: '2999-08-15',
      time: '07:30',
      priceMode: 'split_venue',
      venueFee: 3000,
    });
    const svc = makeService(t);

    const r = await edit(svc, 'G', setField('fee', '2500'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.feeModeSwitched).toBe(true);
      expect(r.before).toBe('場地費 3000 元');
      expect(r.after).toBe('每人費用 2500 元');
      expect(r.perPerson).toBeUndefined();
    }
    const after = await t.events.getById(ev.id);
    expect(after?.price_mode).toBe('per_person');
    expect(after?.price_per_person).toBe(2500);
    expect(after?.venue_fee).toBeNull();
    const changed = changedColumns(ev, after!).filter((c) => c !== 'updated_at').sort();
    expect(changed).toEqual(['price_mode', 'price_per_person', 'venue_fee']);
  });

  // ── AC-5：mention 行為不變 ───────────────────────────────────────────
  it('[D-019 AC-5] 切換模式成功後 tagOwnerIds／overflow 規則同 D-015 AC-12（去重、只含 confirmed）', async () => {
    await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', capacity: 5, price: 2000 });
    const svc = makeService(t);
    const reg = makeRegService(t);
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-A', executorDisplayName: 'A', messageId: nextMid(), count: 2 });
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-B', executorDisplayName: 'B', messageId: nextMid(), count: 1, proxyName: '陳大哥' });

    const r = await edit(svc, 'G', setField('fee', '場地費4000'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const a = await t.users.getByLineUserId('U-A');
    const b = await t.users.getByLineUserId('U-B');
    expect(r.tagOwnerIds).toEqual([a!.id, b!.id]); // 依 owner 去重、代報列歸代報者本人
    expect(r.overflow).toBe(false);
  });

  // ── AC-6：其餘欄位／併發不受影響 ────────────────────────────────────
  it('[D-019 AC-6] 切換模式不動 capacity／status／settled_per_person／event_datetime／location／host_user_id／group_id；registrations 不變', async () => {
    const ev = await seed(t, {
      groupId: 'G',
      date: '2999-08-15',
      time: '07:30',
      priceMode: 'split_venue',
      venueFee: 3000,
      capacity: 10,
    });
    const svc = makeService(t);
    const reg = makeRegService(t);
    await reg.signup({ groupId: 'G', executorLineUserId: 'U-a', executorDisplayName: 'a', messageId: nextMid(), count: 2 });
    const regsBefore = await t.pool.query<{ id: number; event_id: number; owner_user_id: number; status: string }>(
      'SELECT id, event_id, owner_user_id, status FROM registrations ORDER BY id',
    );

    const r = await edit(svc, 'G', setField('fee', '2500'));
    expect(r.kind).toBe('ok');

    const after = await t.events.getById(ev.id);
    expect(after?.capacity).toBe(ev.capacity);
    expect(after?.status).toBe(ev.status);
    expect(after?.settled_per_person).toBeNull();
    expect(after?.event_datetime).toBe(ev.event_datetime);
    expect(after?.location).toBe(ev.location);
    expect(after?.host_user_id).toBe(ev.host_user_id);
    expect(after?.group_id).toBe(ev.group_id);

    const regsAfter = await t.pool.query<{ id: number; event_id: number; owner_user_id: number; status: string }>(
      'SELECT id, event_id, owner_user_id, status FROM registrations ORDER BY id',
    );
    expect(regsAfter.rows).toEqual(regsBefore.rows);
  });

  it('[D-019 AC-6] 兩則並行編輯（一則切模式、一則改日期）序列化後皆生效、互不覆蓋', async () => {
    const ev = await seed(t, { groupId: 'G', date: '2999-08-15', time: '07:30', price: 2200 });
    const svc = makeService(t);

    const [r1, r2] = await Promise.all([
      edit(svc, 'G', setField('fee', '場地費4000'), { messageId: nextMid() }),
      edit(svc, 'G', setField('date', '2999-09-01'), { messageId: nextMid() }),
    ]);
    expect([r1.kind, r2.kind]).toEqual(['ok', 'ok']);

    const after = await t.events.getById(ev.id);
    expect(after?.price_mode).toBe('split_venue');
    expect(after?.venue_fee).toBe(4000);
    expect(after?.price_per_person).toBe(0);
    expect(after?.event_datetime).toBe(taipeiToUtcIso('2999-09-01', '07:30'));
  });

  // ── AC-7：G2 原子寫入名實相符（spy 呼叫次數） ───────────────────────
  it('[D-019 AC-7] `編輯 費用`（含切換與不切換）恰呼叫 updateBilling 一次', async () => {
    await seed(t, { groupId: 'G-switch', date: '2999-08-15', time: '07:30', price: 2200 });
    await seed(t, { groupId: 'G-same', date: '2999-08-15', time: '07:30', price: 2200 });
    const svc = makeService(t);
    const spy = vi.spyOn(EventRepository.prototype, 'updateBilling');

    const r1 = await edit(svc, 'G-switch', setField('fee', '場地費4000'));
    expect(r1.kind).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);

    const r2 = await edit(svc, 'G-same', setField('fee', '3000'));
    expect(r2.kind).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(2); // 累計：同模式改價同樣走 updateBilling，不另開分支
  });
});
