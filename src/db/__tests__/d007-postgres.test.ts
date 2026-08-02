import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedEvent, type TestDb } from './test-db';
import { nowIso } from '../time';
import { RegistrationService } from '../../domain/registration-service';
import { EventService } from '../../domain/event-service';
import { EventRepository } from '../repositories/event-repository';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ROOT = join(__dirname, '..', '..', '..');

function makeReg(t: TestDb): RegistrationService {
  return new RegistrationService({
    events: t.events,
    users: t.users,
    registrations: t.registrations,
    processed: t.processed,
    runImmediate: t.runImmediate,
    logError: () => {},
  });
}

function makeEvt(t: TestDb, superAdmins: string[] = []): EventService {
  return new EventService({
    events: t.events,
    users: t.users,
    conversations: t.conversations,
    runInTransaction: t.runInTransaction,
    superAdminUserIds: superAdmins,
    logError: () => {},
  });
}

describe('D-007 Postgres 移植 Acceptance Checks', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-007 AC-1] 既有 domain AC 於 PG 全綠（代表性覆核：signup outcome 不變）', async () => {
    // 完整 D-001/D-003/D-004/D-005/D-006 AC 由各自 *.test.ts 於 PG 執行（全綠）；此為代表性覆核。
    const { event } = await seedEvent(t, { capacity: 1, groupId: 'G1' });
    const svc = makeReg(t);
    const a = await svc.signup({ groupId: 'G1', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'a1', count: 1 });
    const b = await svc.signup({ groupId: 'G1', executorLineUserId: 'U-b', executorDisplayName: 'B', messageId: 'b1', count: 1 });
    expect(a.kind === 'ok' && a.outcome).toBe('confirmed');
    expect(b.kind === 'ok' && b.outcome).toBe('waitlisted');
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
  });

  it('[D-007 AC-2] 兩並行 PoolClient FOR UPDATE 序列化 → 不超賣（真並行）', async () => {
    const { event } = await seedEvent(t, { capacity: 1, groupId: 'G2' });
    const a = await t.users.upsert('U-a', 'A');
    const b = await t.users.upsert('U-b', 'B');
    // 兩筆並行報名各自 checkout 一個 PoolClient（pool max=2），各自 BEGIN;FOR UPDATE;count;insert;COMMIT。
    const doSignup = (owner: number, name: string): Promise<string> =>
      t.runImmediate(event.id, async (repos) => {
        const c = await repos.registrations.countConfirmed(event.id);
        const status = event.capacity - c >= 1 ? 'confirmed' : 'waitlist';
        await repos.registrations.insertSlots(
          { eventId: event.id, ownerUserId: owner, displayName: name, kind: 'self', status },
          1,
        );
        return status;
      });
    const results = (await Promise.all([doSignup(a.id, 'A'), doSignup(b.id, 'B')])).sort();
    // 第二者的 FOR UPDATE 阻塞至第一者 COMMIT → 一 confirmed 一 waitlist，無超賣。
    expect(results).toEqual(['confirmed', 'waitlist']);
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
    expect(await t.registrations.countConfirmed(event.id)).toBeLessThanOrEqual(event.capacity);
  });

  it('[D-007 AC-3] 交易 work 內 repos 綁同一 client：未提交 insert 於同交易 count 立即可見（同連線探針）', async () => {
    const { event } = await seedEvent(t, { capacity: 5, groupId: 'G3' });
    const host = await t.users.upsert('U-h', 'H');
    const seen = await t.runImmediate(event.id, async (repos) => {
      const before = await repos.registrations.countConfirmed(event.id);
      await repos.registrations.insertSlot({ eventId: event.id, ownerUserId: host.id, displayName: 'H', kind: 'self', status: 'confirmed' });
      // 若 count 落在不同 pooled 連線，未提交的 insert 不可見 → after 會是 0。
      const after = await repos.registrations.countConfirmed(event.id);
      return { before, after };
    });
    expect(seen.before).toBe(0);
    expect(seen.after).toBe(1);
  });

  it('[D-007 AC-3] 反例：無 FOR UPDATE 的 count-then-insert 交錯 → 超賣（證明 G1／路線 A 之必要）', async () => {
    const { event } = await seedEvent(t, { capacity: 1, groupId: 'Gx3' });
    const a = await t.users.upsert('U-a', 'A');
    const b = await t.users.upsert('U-b', 'B');
    const countConfirmed = async (): Promise<number> => {
      const r = await t.pool.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM registrations WHERE event_id = $1 AND status = 'confirmed' AND cancelled_at IS NULL",
        [event.id],
      );
      return Number(r.rows[0]!.n);
    };
    // 錯法（本機綠 prod 紅）：不鎖 event、決策前兩者都讀到 0 → 都寫入 → 超賣。
    const c1 = await countConfirmed();
    const c2 = await countConfirmed();
    expect(c1).toBe(0);
    expect(c2).toBe(0);
    const now = nowIso();
    if (event.capacity - c1 >= 1) {
      await t.pool.query(
        "INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at) VALUES ($1,$2,'A','self','confirmed',1,$3)",
        [event.id, a.id, now],
      );
    }
    if (event.capacity - c2 >= 1) {
      await t.pool.query(
        "INSERT INTO registrations (event_id, owner_user_id, display_name, kind, status, seq, created_at) VALUES ($1,$2,'B','self','confirmed',2,$3)",
        [event.id, b.id, now],
      );
    }
    expect(await countConfirmed()).toBe(2); // 超賣！capacity=1 卻 2 正取。
    expect(await countConfirmed()).toBeGreaterThan(event.capacity); // 證明 FOR UPDATE 之必要。
  });

  it('[D-007 AC-6] PG 新寫入時間欄符合 ^…Z$（TEXT ISO 不退化，等義 D-001 AC-13）', async () => {
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G6' });
    expect(event.created_at).toMatch(ISO_RE);
    expect(event.updated_at).toMatch(ISO_RE);
    const host = await t.users.upsert('U-h', 'H');
    expect(host.created_at).toMatch(ISO_RE);
    const [reg] = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots({ eventId: event.id, ownerUserId: host.id, displayName: 'H', kind: 'self', status: 'confirmed' }, 1),
    );
    expect(reg!.created_at).toMatch(ISO_RE);
    await t.runImmediate(event.id, (repos) => repos.registrations.cancelByIds([reg!.id], host.id));
    expect((await t.registrations.getById(reg!.id))!.cancelled_at).toMatch(ISO_RE);
  });

  it('[D-007 AC-7] pool max ≤ 2 且單例可重用；連續查詢成功（重連容錯基礎）', async () => {
    expect(t.pool.options.max).toBeLessThanOrEqual(2);
    expect(t.pool.options.max).toBe(2);
    for (let i = 0; i < 5; i += 1) {
      const r = await t.pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(r.rows[0]!.ok).toBe(1);
    }
  });

  it('[D-007 AC-8] ON CONFLICT (message_id) DO NOTHING：同 id 第二次 rowCount=0 略過，無重複有效 registrations', async () => {
    const { event } = await seedEvent(t, { capacity: 4, groupId: 'G8' });
    const svc = makeReg(t);
    const r1 = await svc.signup({ groupId: 'G8', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'dup8', count: 1 });
    const r2 = await svc.signup({ groupId: 'G8', executorLineUserId: 'U-a', executorDisplayName: 'A', messageId: 'dup8', count: 1 });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('duplicate');
    expect(await t.registrations.countConfirmed(event.id)).toBe(1);
    // markProcessed 語意：首次 true、重複 false。
    expect(await t.processed.markProcessed('x8')).toBe(true);
    expect(await t.processed.markProcessed('x8')).toBe(false);
  });

  it('[D-007 AC-9] 窄捕捉 23505 + constraint===ux_events_active_group → already_active；其他錯誤 re-throw', async () => {
    const { host } = await seedEvent(t, { capacity: 4, groupId: 'G9' });
    // (a) 真實重複 active group → pg 錯誤帶 code 23505 + constraint（窄捕捉的判別鍵）。
    let caught: unknown;
    try {
      await t.events.create({ groupId: 'G9', hostUserId: host.id, eventDatetime: '2026-09-01T00:00:00Z', location: 'Y', capacity: 4, status: 'draft' });
    } catch (e) {
      caught = e;
    }
    const err = caught as { code?: string; constraint?: string };
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('ux_events_active_group');

    // (b) confirm 交易內 INSERT 撞約束（pre-check 以 prototype spy 失效模擬 race）→ 窄捕捉 already_active。
    const evt = makeEvt(t);
    await t.conversations.upsert({ lineUserId: 'U-h2', groupId: 'G9', state: 'awaiting_confirm', payload: JSON.stringify({ date: '2026-09-02', time: '08:00', location: 'Z', capacity: 4, price: 0, priceMode: 'per_person' }) });
    const spy = vi.spyOn(EventRepository.prototype, 'findActiveByGroup').mockResolvedValue(undefined);
    const r = await evt.confirm({ groupId: 'G9', executorLineUserId: 'U-h2', messageId: 'm9', hostDisplayName: 'H2' });
    spy.mockRestore();
    expect(r.kind).toBe('already_active');

    // (c) 非 23505 錯誤 → 一律 re-throw（不吞成 already_active）。
    await t.conversations.upsert({ lineUserId: 'U-h3', groupId: 'G-other', state: 'awaiting_confirm', payload: JSON.stringify({ date: '2026-09-03', time: '08:00', location: 'Q', capacity: 4, price: 0, priceMode: 'per_person' }) });
    const boom = Object.assign(new Error('connection exception'), { code: '08006' });
    const spy2 = vi.spyOn(EventRepository.prototype, 'create').mockRejectedValue(boom);
    await expect(evt.confirm({ groupId: 'G-other', executorLineUserId: 'U-h3', messageId: 'm9b', hostDisplayName: 'H3' })).rejects.toThrow('connection exception');
    spy2.mockRestore();
  });

  it('[D-007 AC-12] int4 IDENTITY/FK 回傳為 number；反例 bigint 回 string（證明 int4 選擇之必要）', async () => {
    const { event, host } = await seedEvent(t, { capacity: 4, groupId: 'G12' });
    expect(typeof event.id).toBe('number');
    expect(typeof host.id).toBe('number');
    const [reg] = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots({ eventId: event.id, ownerUserId: host.id, displayName: 'H', kind: 'self', status: 'confirmed' }, 1),
    );
    expect(typeof reg!.id).toBe('number');
    expect(typeof reg!.event_id).toBe('number');
    expect(typeof reg!.owner_user_id).toBe('number');
    const u = await t.users.getById(host.id);
    expect(typeof u!.id).toBe('number');
    expect(typeof u!.is_host).toBe('number');
    // 反例：int8(bigint) 經 pg 預設回 string → 若主鍵/FK 用 bigint，宣告為 number 的 Row 欄位執行期實為 string（型別謊言）。
    const big = await t.pool.query<{ big: string }>('SELECT (9007199254740993)::bigint AS big');
    expect(typeof big.rows[0]!.big).toBe('string');
  });

  it('[D-007 AC-13] 同秒多筆報名以 seq 穩定排序（非 created_at 秒級精度）', async () => {
    const { event } = await seedEvent(t, { capacity: 10, groupId: 'G13' });
    const h = await t.users.upsert('U-h', 'H');
    const rows = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots({ eventId: event.id, ownerUserId: h.id, displayName: 'H', kind: 'self', status: 'confirmed' }, 5),
    );
    // 同一交易/同秒插入：created_at 可能全相同（秒精度），但 seq 單調遞增。
    expect(rows.every((r) => ISO_RE.test(r.created_at))).toBe(true);
    const listed = await t.registrations.listConfirmed(event.id); // ORDER BY seq
    for (let i = 1; i < listed.length; i += 1) {
      expect(listed[i]!.seq).toBeGreaterThan(listed[i - 1]!.seq);
    }
    // 名單順序 == 插入順序（seq 決定，non-flaky，即便同秒）。
    expect(listed.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('[D-007 AC-11] Dockerfile/依賴：pg-only（無 better-sqlite3 native）、postbuild 複製 .sql', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies['better-sqlite3']).toBeUndefined();
    expect(pkg.devDependencies['@types/better-sqlite3']).toBeUndefined();
    expect(pkg.dependencies.pg).toBeDefined();
    expect(pkg.scripts.postbuild).toContain('copy-migrations');
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('node:22-slim');
    expect(dockerfile).toContain('npm run build');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
    // .sql 存在於 src（postbuild copy-migrations.mjs 會複製到 dist/db/migrations）。
    expect(existsSync(join(ROOT, 'src', 'db', 'migrations', '0001_init.sql'))).toBe(true);
    expect(existsSync(join(ROOT, 'scripts', 'copy-migrations.mjs'))).toBe(true);
  });

  it('[D-003 AC-20] cancel 遞補路徑：freedConfirmed 取鎖內實際取消數 → 並發同列 cancel 不超賣（回歸 B1）', async () => {
    // 回歸 architect-reviewer R2 blocker B1（T-012 sync→async 激活的 cancel 遞補超賣競態）。
    // 場景：capacity=2、confirmed=[r1,r2]（同 owner A 自報）、waitlist=[w1,w2]。
    // 兩則不同 messageId 的 -1（如同人雙擊）於交易外皆定位到同一高 seq 正取列 r2（toCancel 快照皆 [r2]）；
    // 兩交易各自 runImmediate（真兩 PoolClient、Promise.all），FOR UPDATE 序列化。
    const { event } = await seedEvent(t, { capacity: 2, groupId: 'Gb1' });
    const a = await t.users.upsert('U-a', 'A');
    const confirmed = await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: a.id, displayName: 'A', kind: 'self', status: 'confirmed' },
        2,
      ),
    );
    const w1 = await t.users.upsert('U-w1', 'W1');
    await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: w1.id, displayName: 'W1', kind: 'self', status: 'waitlist' },
        1,
      ),
    );
    const w2 = await t.users.upsert('U-w2', 'W2');
    await t.runImmediate(event.id, (repos) =>
      repos.registrations.insertSlots(
        { eventId: event.id, ownerUserId: w2.id, displayName: 'W2', kind: 'self', status: 'waitlist' },
        1,
      ),
    );
    expect(await t.registrations.countConfirmed(event.id)).toBe(2);
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(2);

    // 交易外定位（模擬 service）：兩並行 cancel 於交易前皆讀到 r2 為有效正取 → 共享同一「取消前快照」。
    const r2 = confirmed[1]!; // 高 seq 正取列（-N 先退高 seq）
    const toCancel = [r2];
    // 反例錨點：修前以交易外快照計 freedConfirmed，兩者皆得 1（r2 快照 status='confirmed'）→ 多遞補致 confirmed=3 超賣。
    expect(toCancel.filter((r) => r.status === 'confirmed').length).toBe(1);

    // 兩並行 cancel 交易對同一列 r2 各自 cancelByIds + 依「鎖內實際釋出正取數」遞補（B1 修法）。
    const doCancel = (): Promise<number> =>
      t.runImmediate(event.id, async (repos) => {
        const { freedConfirmed } = await repos.registrations.cancelByIds(
          toCancel.map((r) => r.id),
          a.id,
        );
        if (freedConfirmed > 0) {
          const picks = await repos.registrations.pickWaitlistForPromotion(event.id, freedConfirmed);
          await repos.registrations.promoteByIds(picks.map((r) => r.id));
        }
        return freedConfirmed;
      });
    const freed = (await Promise.all([doCancel(), doCancel()])).sort((x, y) => x - y);

    // 第二者 FOR UPDATE 阻塞至第一者 COMMIT → r2 已取消 → cancelByIds 實取 0 → freedConfirmed=0 → 不遞補。
    expect(freed).toEqual([0, 1]); // 只一者實釋 1 個正取（非兩者皆 1）
    const finalConfirmed = await t.registrations.countConfirmed(event.id);
    expect(finalConfirmed).toBeLessThanOrEqual(event.capacity); // 不超賣（修前為 3 > 2）
    expect(finalConfirmed).toBe(2); // r1 保留 + 遞補 1 筆候補
    expect(await t.registrations.listWaitlist(event.id)).toHaveLength(1); // 只遞補 1 筆，另一候補仍在候補
  });

});
