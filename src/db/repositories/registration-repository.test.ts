import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedEvent, type TestDb } from '../__tests__/test-db';
import type { RegistrationKind, RegistrationRow, RegistrationStatus } from '../schema';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * 模擬 D-002 的「+N 整批進場」決策：同一 IMMEDIATE 交易內先計數有效正取、
 * 依可用名額決定整批 confirmed 或整批 waitlist（定案 #1），再插入 N 列。
 * 本層僅提供原語（countConfirmed / insertSlots），此決策組合屬 D-002；
 * 於測試內組合以驗證原語可支撐該流程。
 */
function registerBatch(
  t: TestDb,
  eventId: number,
  capacity: number,
  ownerUserId: number,
  displayName: string,
  kind: RegistrationKind,
  count: number,
): { status: RegistrationStatus; rows: RegistrationRow[] } {
  return t.registrations.runImmediate(() => {
    const confirmed = t.registrations.countConfirmed(eventId);
    const status: RegistrationStatus = capacity - confirmed >= count ? 'confirmed' : 'waitlist';
    const rows = t.registrations.insertSlots(
      { eventId, ownerUserId, displayName, kind, status },
      count,
    );
    return { status, rows };
  });
}

describe('RegistrationRepository', () => {
  let t: TestDb;
  beforeEach(() => {
    t = createTestDb();
  });
  afterEach(() => {
    t.cleanup();
  });

  it('[D-001 AC-1] 容量充足時 +3 產生 3 列 confirmed，seq 嚴格遞增、快照正確', () => {
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-ac1' });
    const member = t.users.upsert('U-a', '阿明');
    const { status, rows } = registerBatch(t, event.id, 4, member.id, '阿明', 'self', 3);

    expect(status).toBe('confirmed');
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe('confirmed');
      expect(r.cancelled_at).toBeNull();
      expect(r.kind).toBe('self');
      expect(r.display_name).toBe('阿明');
      expect(r.created_at).toMatch(ISO_RE);
    }
    const seqs = rows.map((r) => r.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    // per-slot：DB 內確實 3 列且皆屬本 event。
    const persisted = t.registrations.listConfirmed(event.id);
    expect(persisted).toHaveLength(3);
    expect(t.registrations.countConfirmed(event.id)).toBe(3);
  });

  it('[D-001 AC-2] 容量剩 1，兩筆 +1 序列化後無超賣（一 confirmed、一整批 waitlist）', () => {
    const { event } = seedEvent(t, { capacity: 1, groupId: 'G-ac2' });
    const a = t.users.upsert('U-a', 'A');
    const b = t.users.upsert('U-b', 'B');

    const first = registerBatch(t, event.id, 1, a.id, 'A', 'self', 1);
    const second = registerBatch(t, event.id, 1, b.id, 'B', 'self', 1);

    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('waitlist');
    // 無超賣：有效 confirmed 不超過 capacity（outcome-based，最終列狀態為準）。
    expect(t.registrations.countConfirmed(event.id)).toBe(1);
    expect(t.registrations.countConfirmed(event.id)).toBeLessThanOrEqual(event.capacity);
    expect(t.registrations.listWaitlist(event.id)).toHaveLength(1);
  });

  it('[D-001 AC-2] 容量剩 1，第二筆 +2 整批候補不部分接受（無超賣）', () => {
    // 補強：驗證「整批 N 進場」規則——available=1 但 +2 → 整批 waitlist，而非塞 1 列超賣。
    const { event } = seedEvent(t, { capacity: 1, groupId: 'G-ac2b' });
    const a = t.users.upsert('U-a2', 'A');
    const b = t.users.upsert('U-b2', 'B');

    registerBatch(t, event.id, 1, a.id, 'A', 'self', 1); // 填滿
    const batch = registerBatch(t, event.id, 1, b.id, 'B', 'self', 2);

    expect(batch.status).toBe('waitlist');
    expect(t.registrations.countConfirmed(event.id)).toBe(1); // 未超賣
    expect(t.registrations.listWaitlist(event.id)).toHaveLength(2); // 整批 2 列進候補
  });

  it('[D-001 AC-3] soft-delete 後列仍在、計數減、名單不顯示、seq 保留', () => {
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-ac3' });
    const member = t.users.upsert('U-a', '阿明');
    const { rows } = registerBatch(t, event.id, 4, member.id, '阿明', 'self', 2);
    const ids = rows.map((r) => r.id);
    const seqsBefore = rows.map((r) => r.seq);

    const cancelled = t.registrations.runImmediate(() =>
      t.registrations.cancelByIds(ids, member.id),
    );
    expect(cancelled).toBe(2);

    // 列仍存在且標記取消。
    for (let i = 0; i < ids.length; i += 1) {
      const row = t.registrations.getById(ids[i]!)!;
      expect(row.cancelled_at).not.toBeNull();
      expect(row.cancelled_at).toMatch(ISO_RE);
      expect(row.cancelled_by_user_id).toBe(member.id);
      expect(row.seq).toBe(seqsBefore[i]); // seq 保留不變
    }
    expect(t.registrations.countConfirmed(event.id)).toBe(0);
    expect(t.registrations.listConfirmed(event.id)).toHaveLength(0);
    expect(t.registrations.findActiveByOwner(event.id, member.id)).toHaveLength(0);
  });

  it('[D-001 AC-3] 部分取消：只取消指定列，其餘有效列不受影響', () => {
    // 補強：cancelByIds 只影響傳入 id，不誤傷同 owner 其他名額。
    const { event } = seedEvent(t, { capacity: 5, groupId: 'G-ac3b' });
    const member = t.users.upsert('U-p', '阿明');
    const { rows } = registerBatch(t, event.id, 5, member.id, '阿明', 'self', 3);

    const cancelled = t.registrations.runImmediate(() =>
      t.registrations.cancelByIds([rows[0]!.id], member.id),
    );
    expect(cancelled).toBe(1);
    expect(t.registrations.getById(rows[0]!.id)!.cancelled_at).not.toBeNull();
    expect(t.registrations.getById(rows[1]!.id)!.cancelled_at).toBeNull();
    expect(t.registrations.getById(rows[2]!.id)!.cancelled_at).toBeNull();
    expect(t.registrations.countConfirmed(event.id)).toBe(2);
  });

  it('[D-001 AC-3] 重複取消同一列（已取消）不再改動、回傳 0', () => {
    // 補強：soft-delete 冪等，第二次取消影響 0 列、cancelled_at 不被覆寫。
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-ac3c' });
    const member = t.users.upsert('U-q', '阿明');
    const host = t.users.upsert('U-qh', '主辦');
    const { rows } = registerBatch(t, event.id, 4, member.id, '阿明', 'self', 1);

    t.registrations.runImmediate(() => t.registrations.cancelByIds([rows[0]!.id], member.id));
    const firstCancelledAt = t.registrations.getById(rows[0]!.id)!.cancelled_at;

    const second = t.registrations.runImmediate(() =>
      t.registrations.cancelByIds([rows[0]!.id], host.id),
    );
    expect(second).toBe(0); // 已取消，不再影響
    const row = t.registrations.getById(rows[0]!.id)!;
    expect(row.cancelled_at).toBe(firstCancelledAt); // 未被覆寫
    expect(row.cancelled_by_user_id).toBe(member.id); // 執行者不被覆寫
  });

  it('[D-001 AC-4] 釋出名額後最小 seq 的有效候補被遞補；已取消候補不被遞補', () => {
    const { event } = seedEvent(t, { capacity: 2, groupId: 'G-ac4' });
    const a = t.users.upsert('U-a', 'A');
    const b = t.users.upsert('U-b', 'B');
    const c = t.users.upsert('U-c', 'C');
    const d = t.users.upsert('U-d', 'D');

    const confirmedA = registerBatch(t, event.id, 2, a.id, 'A', 'self', 1);
    registerBatch(t, event.id, 2, b.id, 'B', 'self', 1); // 填滿
    const waitC = registerBatch(t, event.id, 2, c.id, 'C', 'self', 1); // waitlist seq 3
    const waitD = registerBatch(t, event.id, 2, d.id, 'D', 'self', 1); // waitlist seq 4
    expect(waitC.status).toBe('waitlist');
    expect(waitD.status).toBe('waitlist');

    // 取消候補 C（較小 seq），釋出一個正取名額並遞補 → 應選 D（現存最小有效候補 seq）。
    const promoted = t.registrations.runImmediate(() => {
      t.registrations.cancelByIds([waitC.rows[0]!.id], c.id); // C 候補取消
      t.registrations.cancelByIds([confirmedA.rows[0]!.id], a.id); // A 正取取消 → 釋出 1
      const pick = t.registrations.pickWaitlistForPromotion(event.id, 1);
      t.registrations.promoteByIds(pick.map((r) => r.id));
      return pick;
    });

    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).toBe(waitD.rows[0]!.id); // 已取消的 C 未被選
    const promotedRow = t.registrations.getById(waitD.rows[0]!.id)!;
    expect(promotedRow.status).toBe('confirmed');
    expect(promotedRow.seq).toBe(waitD.rows[0]!.seq); // 遞補 seq 不變
    expect(t.registrations.countConfirmed(event.id)).toBe(2); // B + D
    // 已取消的 C 仍為 waitlist status 但已被 cancelled_at 排除，不計有效候補。
    expect(t.registrations.listWaitlist(event.id)).toHaveLength(0);
  });

  it('[D-001 AC-4] FIFO 嚴格性：多候補依 seq 由小到大遞補', () => {
    // 補強：釋出 2 個名額時，選中的是最小的 2 個有效候補 seq，順序正確。
    const { event } = seedEvent(t, { capacity: 2, groupId: 'G-ac4b' });
    const a = t.users.upsert('U-fa', 'A');
    const b = t.users.upsert('U-fb', 'B');
    const w1 = t.users.upsert('U-fw1', 'W1');
    const w2 = t.users.upsert('U-fw2', 'W2');
    const w3 = t.users.upsert('U-fw3', 'W3');

    const ca = registerBatch(t, event.id, 2, a.id, 'A', 'self', 1);
    const cb = registerBatch(t, event.id, 2, b.id, 'B', 'self', 1); // 滿
    const rw1 = registerBatch(t, event.id, 2, w1.id, 'W1', 'self', 1); // seq 3
    const rw2 = registerBatch(t, event.id, 2, w2.id, 'W2', 'self', 1); // seq 4
    const rw3 = registerBatch(t, event.id, 2, w3.id, 'W3', 'self', 1); // seq 5

    const picked = t.registrations.runImmediate(() => {
      t.registrations.cancelByIds([ca.rows[0]!.id, cb.rows[0]!.id], a.id); // 釋出 2
      const pick = t.registrations.pickWaitlistForPromotion(event.id, 2);
      t.registrations.promoteByIds(pick.map((r) => r.id));
      return pick;
    });

    expect(picked.map((r) => r.id)).toEqual([rw1.rows[0]!.id, rw2.rows[0]!.id]); // 最小兩個 seq
    expect(picked[0]!.seq).toBeLessThan(picked[1]!.seq);
    expect(t.registrations.getById(rw3.rows[0]!.id)!.status).toBe('waitlist'); // 最大 seq 仍候補
    expect(t.registrations.countConfirmed(event.id)).toBe(2);
  });

  it('[D-001 AC-5] 代報名產生 proxy 列，並以 (owner,kind,display_name) 定位取消', () => {
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-ac5' });
    const messenger = t.users.upsert('U-msg', '傳訊人');
    const { rows } = registerBatch(t, event.id, 4, messenger.id, '陳大哥', 'proxy', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('proxy');
    expect(rows[0]!.display_name).toBe('陳大哥');
    expect(rows[0]!.owner_user_id).toBe(messenger.id);
    expect(rows[0]!.cancelled_at).toBeNull();

    const located = t.registrations.findActiveProxy(event.id, messenger.id, '陳大哥');
    expect(located).toHaveLength(1);
    t.registrations.runImmediate(() =>
      t.registrations.cancelByIds([located[0]!.id], messenger.id),
    );
    expect(t.registrations.findActiveProxy(event.id, messenger.id, '陳大哥')).toHaveLength(0);
    expect(t.registrations.getById(located[0]!.id)!.cancelled_at).toMatch(ISO_RE);
  });

  it('[D-001 AC-5] 代報名定位不誤傷他人：名字/owner/kind 皆須相符', () => {
    // 補強：`-1 名字` 定位錯人不應誤刪他人名額。
    const { event } = seedEvent(t, { capacity: 10, groupId: 'G-ac5b' });
    const msgA = t.users.upsert('U-mA', '傳訊甲');
    const msgB = t.users.upsert('U-mB', '傳訊乙');

    // 甲代報「陳大哥」與「林小姐」；乙也代報同名「陳大哥」；甲另有一筆本人報名 display_name 恰為「陳大哥」。
    const aChen = registerBatch(t, event.id, 10, msgA.id, '陳大哥', 'proxy', 1);
    const aLin = registerBatch(t, event.id, 10, msgA.id, '林小姐', 'proxy', 1);
    const bChen = registerBatch(t, event.id, 10, msgB.id, '陳大哥', 'proxy', 1);
    const aSelfChen = registerBatch(t, event.id, 10, msgA.id, '陳大哥', 'self', 1);

    // 甲取消「陳大哥」：只該定位到甲的 proxy 陳大哥，不含乙的、也不含甲的 self 同名列。
    const located = t.registrations.findActiveProxy(event.id, msgA.id, '陳大哥');
    expect(located).toHaveLength(1);
    expect(located[0]!.id).toBe(aChen.rows[0]!.id);

    t.registrations.runImmediate(() => t.registrations.cancelByIds([located[0]!.id], msgA.id));

    // 誤傷檢查：其他三列仍有效。
    expect(t.registrations.getById(aLin.rows[0]!.id)!.cancelled_at).toBeNull();
    expect(t.registrations.getById(bChen.rows[0]!.id)!.cancelled_at).toBeNull();
    expect(t.registrations.getById(aSelfChen.rows[0]!.id)!.cancelled_at).toBeNull();
    // 乙查自己的「陳大哥」仍在。
    expect(t.registrations.findActiveProxy(event.id, msgB.id, '陳大哥')).toHaveLength(1);
  });

  it('[D-001 AC-12] 取消稽核記錄執行者（owner 自取 vs host 代取），且稽核欄可讀回', () => {
    const { event, host } = seedEvent(t, { capacity: 4, groupId: 'G-ac12' });
    const owner = t.users.upsert('U-own', '報名者');
    const self = registerBatch(t, event.id, 4, owner.id, '報名者', 'self', 1);
    const byHost = registerBatch(t, event.id, 4, owner.id, '報名者', 'self', 1);

    // owner 自行取消。
    t.registrations.runImmediate(() => t.registrations.cancelByIds([self.rows[0]!.id], owner.id));
    // host 代為取消他人名額。
    t.registrations.runImmediate(() => t.registrations.cancelByIds([byHost.rows[0]!.id], host.id));

    const r1 = t.registrations.getById(self.rows[0]!.id)!;
    const r2 = t.registrations.getById(byHost.rows[0]!.id)!;
    expect(r1.cancelled_by_user_id).toBe(owner.id);
    expect(r2.cancelled_by_user_id).toBe(host.id);
    expect(r1.cancelled_at).toMatch(ISO_RE);
    // 稽核軌跡完整：原 owner/display_name/kind/seq 可讀回。
    expect(r2.owner_user_id).toBe(owner.id);
    expect(r2.display_name).toBe('報名者');
    expect(r2.kind).toBe('self');
    expect(r2.seq).toBeGreaterThan(0);
  });

  it('[D-001 AC-1] 邊界：insertSlots count=0 不新增列、計數不變', () => {
    // 補強：+0 邊界，不應寫入任何列。
    const { event } = seedEvent(t, { capacity: 4, groupId: 'G-zero' });
    const member = t.users.upsert('U-z', '阿明');
    const before = t.registrations.countConfirmed(event.id);
    const rows = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: member.id, displayName: '阿明', kind: 'self', status: 'confirmed' },
        0,
      ),
    );
    expect(rows).toHaveLength(0);
    expect(t.registrations.countConfirmed(event.id)).toBe(before);
    expect(t.registrations.listConfirmed(event.id)).toHaveLength(0);
  });

  it('[D-001 AC-1] 邊界：大批量 N=50 seq 連續遞增且計數正確', () => {
    // 補強：超大 N，驗證 seq 連續、per-slot 列數與計數一致。
    const N = 50;
    const { event } = seedEvent(t, { capacity: 100, groupId: 'G-bigN' });
    const member = t.users.upsert('U-big', '團體');
    const rows = t.registrations.runImmediate(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: member.id, displayName: '團體', kind: 'self', status: 'confirmed' },
        N,
      ),
    );
    expect(rows).toHaveLength(N);
    const seqs = rows.map((r) => r.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1); // 同批連續
    }
    expect(t.registrations.countConfirmed(event.id)).toBe(N);
    expect(new Set(seqs).size).toBe(N); // 無重複 seq
  });

  it('G2：未在 IMMEDIATE 交易內寫入 registrations 應拋例外', () => {
    const { event, host } = seedEvent(t, { capacity: 4, groupId: 'G-g2' });
    expect(() =>
      t.registrations.insertSlot({
        eventId: event.id,
        ownerUserId: host.id,
        displayName: 'X',
        kind: 'self',
        status: 'confirmed',
      }),
    ).toThrow(/IMMEDIATE/);
    expect(() => t.registrations.cancelByIds([1], host.id)).toThrow(/IMMEDIATE/);
    expect(() => t.registrations.promoteByIds([1])).toThrow(/IMMEDIATE/);
    expect(() =>
      t.registrations.insertSlots(
        { eventId: event.id, ownerUserId: host.id, displayName: 'X', kind: 'self', status: 'confirmed' },
        2,
      ),
    ).toThrow(/IMMEDIATE/);
  });

  it('G9：repository 原始碼中不得有任何針對 registrations 的 DELETE 敘述', () => {
    // 守門：取消一律 soft-delete；唯一實體刪除來自 events 的 ON DELETE CASCADE。
    const src = readFileSync(join(__dirname, 'registration-repository.ts'), 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM\s+registrations/i);
  });
});
