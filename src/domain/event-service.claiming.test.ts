import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { createTransactionRunner } from '../db/tx';
import { EventService } from './event-service';

/**
 * D-006（授權簡化：開團人擁有 + super-admin 安全網）service-level Acceptance Checks。
 * 標記 [D-006 AC-n]。開團全開（G1）、close/cancel = canManageEvent（host_user_id ∪ super-admin，
 * 非授權零副作用、唯讀不 upsert，G2/G3）、取消不刪 registrations（G6）。
 */

const G = 'G-1';

function makeSvc(t: TestDb, superAdmins: string[] = []): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    conversations: t.conversations,
    processed: t.processed,
    runInTransaction: createTransactionRunner(t.db),
    superAdminUserIds: superAdmins,
    logError: () => {},
  });
}

let mid = 0;
function nextMid(): string {
  mid += 1;
  return `dm${mid}`;
}

/** 由 creator 一行式 → 確認 開一場 open 活動，回 event id（host 自動佔第 1 正取）。 */
function openEventBy(svc: EventService, creator: string, name = '建立者', groupId = G): number {
  svc.handleOneline({
    groupId,
    executorLineUserId: creator,
    messageId: nextMid(),
    date: '2026-08-15',
    time: '07:30',
    location: '東方球場',
    capacity: 16,
    price: 2200,
    priceMode: 'per_person',
  });
  const r = svc.confirm({
    groupId,
    executorLineUserId: creator,
    messageId: nextMid(),
    hostDisplayName: name,
  });
  if (r.kind !== 'created') throw new Error(`open failed: ${r.kind}`);
  return r.event.id;
}

describe('EventService 授權簡化（D-006）', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-006 AC-1] 任何人（非 super-admin）皆可開團；host_user_id = 建立者', () => {
    const svc = makeSvc(t, []); // 無 super-admin
    const X = 'U-x';
    const r1 = svc.handleOneline({
      groupId: G,
      executorLineUserId: X,
      messageId: nextMid(),
      date: '2026-08-15',
      time: '07:30',
      location: '東方球場',
      capacity: 16,
      price: 2200,
      priceMode: 'per_person',
    });
    expect(r1.kind).toBe('awaiting_confirm'); // 開團全開，非 not_authorized
    const c = svc.confirm({ groupId: G, executorLineUserId: X, messageId: nextMid(), hostDisplayName: 'X' });
    expect(c.kind).toBe('created');
    if (c.kind !== 'created') return;
    expect(c.event.status).toBe('open');
    expect(c.event.host_user_id).toBe(t.users.getByLineUserId(X)!.id);

    // 逐步開團亦全開（另一群另一位一般成員）。
    const s = svc.startCreation({ groupId: 'G-2', executorLineUserId: 'U-x2', messageId: nextMid() });
    expect(s.kind).toBe('flow_started');
  });

  it('[D-006 AC-2] 建立者（非 super-admin）可關閉報名', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    openEventBy(svc, X);
    const r = svc.closeEvent({ groupId: G, executorLineUserId: X, messageId: nextMid() });
    expect(r.kind).toBe('ok');
    expect(t.events.findActiveByGroup(G)?.status).toBe('closed');
  });

  it('[D-006 AC-3] 建立者（非 super-admin）可取消活動', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    openEventBy(svc, X);
    const r = svc.cancelEvent({ groupId: G, executorLineUserId: X, messageId: nextMid() });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.event.status).toBe('cancelled');
    expect(t.events.findActiveByGroup(G)).toBeUndefined();
  });

  it('[D-006 AC-4] 非建立者非 super-admin 關閉被拒，無 DB 變更（含 users 無新列）', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    const Y = 'U-y';
    openEventBy(svc, X);
    const r = svc.closeEvent({ groupId: G, executorLineUserId: Y, messageId: 'ry' });
    expect(r.kind).toBe('not_authorized');
    expect(t.events.findActiveByGroup(G)?.status).toBe('open'); // 狀態不變
    expect(t.users.getByLineUserId(Y)).toBeUndefined(); // 唯讀判定：未為 Y upsert 寫列
    expect(t.processed.has('ry')).toBe(false); // 未 mark
  });

  it('[D-006 AC-5] 非建立者非 super-admin 取消被拒，無任何 DB 寫入', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    const Y = 'U-y';
    openEventBy(svc, X);
    const r = svc.cancelEvent({ groupId: G, executorLineUserId: Y, messageId: 'ry2' });
    expect(r.kind).toBe('not_authorized');
    expect(t.events.findActiveByGroup(G)?.status).toBe('open');
    expect(t.users.getByLineUserId(Y)).toBeUndefined();
    expect(t.processed.has('ry2')).toBe(false);
  });

  it('[D-006 AC-6] super-admin 跨建立者取消（S 於 users 無列仍可，安全網）', () => {
    const S = 'U-super';
    const svc = makeSvc(t, [S]);
    const X = 'U-x';
    openEventBy(svc, X);
    expect(t.users.getByLineUserId(S)).toBeUndefined(); // S 開場前無 users 列
    const r = svc.cancelEvent({ groupId: G, executorLineUserId: S, messageId: nextMid() });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.event.status).toBe('cancelled');
    expect(t.events.findActiveByGroup(G)).toBeUndefined();
    expect(t.users.getByLineUserId(S)).toBeUndefined(); // super-admin 純 env 比對，仍無列
  });

  it('[D-006 AC-7] super-admin 亦可關閉他人 open 活動', () => {
    const S = 'U-super';
    const svc = makeSvc(t, [S]);
    const X = 'U-x';
    openEventBy(svc, X);
    const r = svc.closeEvent({ groupId: G, executorLineUserId: S, messageId: nextMid() });
    expect(r.kind).toBe('ok');
    expect(t.events.findActiveByGroup(G)?.status).toBe('closed');
  });

  it('[D-006 AC-8] 取消活動不刪 registrations（含 soft-delete 列）', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    const eventId = openEventBy(svc, X); // host 自動佔第 1 正取
    const member = t.users.upsert('U-m', '成員');
    let softDeletedId = 0;
    t.registrations.runImmediate(() => {
      const slots = t.registrations.insertSlots(
        { eventId, ownerUserId: member.id, displayName: '成員', kind: 'self', status: 'confirmed' },
        3,
      );
      softDeletedId = slots[0]!.id;
      t.registrations.cancelByIds([slots[0]!.id], member.id); // soft-delete 1 列
      return null;
    });
    const before = (t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId) as { n: number }).n;
    expect(before).toBe(4); // host 1 + 成員 3
    // 稽核欄現狀快照（cancelled_at / status），供取消後比對是否保留。
    const auditBefore = t.db
      .prepare('SELECT status, cancelled_at FROM registrations WHERE id = ?')
      .get(softDeletedId) as { status: string; cancelled_at: string | null };
    expect(auditBefore.cancelled_at).not.toBeNull(); // soft-delete 稽核欄已寫

    const r = svc.cancelEvent({ groupId: G, executorLineUserId: X, messageId: nextMid() });
    expect(r.kind).toBe('ok');
    const after = (t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId) as { n: number }).n;
    expect(after).toBe(4); // 列數不變（無 DELETE，G6）
    // G6：稽核欄一併保留（soft-delete 列的 status/cancelled_at 不因取消活動被抹除）。
    const auditAfter = t.db
      .prepare('SELECT status, cancelled_at FROM registrations WHERE id = ?')
      .get(softDeletedId) as { status: string; cancelled_at: string | null };
    expect(auditAfter.status).toBe(auditBefore.status);
    expect(auditAfter.cancelled_at).toBe(auditBefore.cancelled_at);
  });

  it('[D-006 AC-10] confirm/abort 不受授權影響：無流程 → noop、不 mark', () => {
    const svc = makeSvc(t, []);
    const c = svc.confirm({ groupId: G, executorLineUserId: 'U-any', messageId: 'n1', hostDisplayName: '' });
    const a = svc.abort({ executorLineUserId: 'U-any', messageId: 'n2' });
    expect(c.kind).toBe('noop');
    expect(a.kind).toBe('noop');
    expect(t.processed.has('n1')).toBe(false);
    expect(t.processed.has('n2')).toBe(false);
  });

  it('[D-006 AC-12] canManageEvent 三方判定（建立者/super-admin 授權、其他拒）+ executor 唯讀不 upsert', () => {
    const X = 'U-x';
    const S = 'U-super';
    const O = 'U-other';
    const svc = makeSvc(t, [S]);

    // 群 A：建立者 X 可關閉（授權）。
    openEventBy(svc, X, '建立者', 'G-a');
    expect(svc.closeEvent({ groupId: 'G-a', executorLineUserId: X, messageId: 'a1' }).kind).toBe('ok');

    // 群 B：其他成員 O 被拒（唯讀不寫列）、super-admin S 授權。
    openEventBy(svc, X, '建立者', 'G-b');
    expect(svc.closeEvent({ groupId: 'G-b', executorLineUserId: O, messageId: 'b1' }).kind).toBe('not_authorized');
    expect(t.users.getByLineUserId(O)).toBeUndefined(); // 唯讀解析，未 upsert O
    expect(svc.closeEvent({ groupId: 'G-b', executorLineUserId: S, messageId: 'b2' }).kind).toBe('ok');
  });

  // ── 補強（unit-tester）：canManageEvent false 分支 (b) executor 存在但 id≠host ──
  // 既有 AC-4/5/12 皆用「無 users 列」的執行者（getByLineUserId → undefined）。
  // 下列覆蓋最常見實戰情境——已 +1 報名（故已有 users 列）的一般成員嘗試 close/cancel，
  // 走 `executor !== undefined && executor.id !== host_user_id` 的拒絕分支。

  it('[D-006 AC-4] 已有 users 列的非建立者非 super-admin（已報名成員）關閉被拒，無 DB 變更', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    const eventId = openEventBy(svc, X);
    const member = t.users.upsert('U-m', '已報名成員'); // 成員已有 users 列（模擬報名建列）
    t.registrations.runImmediate(() => {
      t.registrations.insertSlot({ eventId, ownerUserId: member.id, displayName: '已報名成員', kind: 'self', status: 'confirmed' });
      return null;
    });
    expect(member.id).not.toBe(t.users.getByLineUserId(X)!.id); // 確非 host

    const r = svc.closeEvent({ groupId: G, executorLineUserId: 'U-m', messageId: 'mclose' });
    expect(r.kind).toBe('not_authorized'); // id mismatch 分支 → 拒
    expect(t.events.findActiveByGroup(G)?.status).toBe('open'); // 狀態不變
    expect(t.processed.has('mclose')).toBe(false); // 未 mark
    // 既有 users 列數不因授權判定改變（唯讀 getByLineUserId、不 upsert）。
    const userCount = (t.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    expect(userCount).toBe(2); // 僅 host X + member U-m
  });

  it('[D-006 AC-5] 已有 users 列的非建立者非 super-admin（已報名成員）取消被拒，registrations 未動', () => {
    const svc = makeSvc(t, []);
    const X = 'U-x';
    const eventId = openEventBy(svc, X);
    const member = t.users.upsert('U-m', '已報名成員');
    t.registrations.runImmediate(() => {
      t.registrations.insertSlot({ eventId, ownerUserId: member.id, displayName: '已報名成員', kind: 'self', status: 'confirmed' });
      return null;
    });
    const regsBefore = (t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId) as { n: number }).n;

    const r = svc.cancelEvent({ groupId: G, executorLineUserId: 'U-m', messageId: 'mcancel' });
    expect(r.kind).toBe('not_authorized');
    expect(t.events.findActiveByGroup(G)?.status).toBe('open');
    expect(t.processed.has('mcancel')).toBe(false);
    const regsAfter = (t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(eventId) as { n: number }).n;
    expect(regsAfter).toBe(regsBefore); // 拒絕於進交易前，registrations 未動
  });
});
