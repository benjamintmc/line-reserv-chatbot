import type { Db } from '../index';
import { nowIso } from '../time';
import type { RegistrationKind, RegistrationRow, RegistrationStatus } from '../schema';

export interface InsertSlotInput {
  eventId: number;
  ownerUserId: number;
  /** 報名當下快照；proxy 時為輸入名字。 */
  displayName: string;
  kind: RegistrationKind;
  /** 佇列位置；整批 confirmed/waitlist 的決策屬 D-002，本層依呼叫端指定寫入。 */
  status: RegistrationStatus;
}

/**
 * registrations 資料存取（per-slot，ADR-001）。
 *
 * 併發與冪等（ADR-002 / G2）：所有 registrations 寫入（插入/取消/遞補）必須在
 * IMMEDIATE 交易內執行——以 {@link RegistrationRepository.runImmediate} 包裹。
 * 寫入原語會以 {@link RegistrationRepository.assertInTransaction} 守門，未在交易內即拋例外。
 *
 * 有效性（G10）：所有「有效名額」查詢一律帶 `cancelled_at IS NULL`。
 * 取消一律 soft-delete（G9）：標記 `cancelled_at`/`cancelled_by_user_id`，
 * **本層不提供、也不得對 registrations 下任何 `DELETE`**。
 *
 * 本層僅提供資料操作原語（計數、插入 slot、標記取消、選候補、遞補）；
 * 「+N 額滿判斷 / 整批轉候補 / 遞補」的商業決策屬 D-002，於同一 runImmediate 交易內組合這些原語。
 */
export class RegistrationRepository {
  constructor(private readonly db: Db) {}

  /** 以 BEGIN IMMEDIATE 序列化執行報名/取消/遞補寫入（ADR-002 / G2）。 */
  runImmediate<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  private assertInTransaction(): void {
    if (!this.db.inTransaction) {
      throw new Error(
        'registrations 寫入必須在 IMMEDIATE 交易內執行（ADR-002 / G2）；請以 runImmediate() 包裹。',
      );
    }
  }

  // ── 查詢原語（有效性一律帶 cancelled_at IS NULL；G10） ─────────────────

  /** 有效正取數（不另存 count；G1）。 */
  countConfirmed(eventId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM registrations
         WHERE event_id = ? AND status = 'confirmed' AND cancelled_at IS NULL`,
      )
      .get(eventId) as { n: number };
    return row.n;
  }

  /** 有效正取名單，依 seq（到場順序）。 */
  listConfirmed(eventId: number): RegistrationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM registrations
         WHERE event_id = ? AND status = 'confirmed' AND cancelled_at IS NULL
         ORDER BY seq`,
      )
      .all(eventId) as RegistrationRow[];
  }

  /** 有效候補佇列（FIFO），依 seq。 */
  listWaitlist(eventId: number): RegistrationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM registrations
         WHERE event_id = ? AND status = 'waitlist' AND cancelled_at IS NULL
         ORDER BY seq`,
      )
      .all(eventId) as RegistrationRow[];
  }

  /** 定位某 owner 未取消名額（-N 用），依 seq。 */
  findActiveByOwner(eventId: number, ownerUserId: number): RegistrationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM registrations
         WHERE event_id = ? AND owner_user_id = ? AND cancelled_at IS NULL
         ORDER BY seq`,
      )
      .all(eventId, ownerUserId) as RegistrationRow[];
  }

  /** 定位某 owner 的代報名未取消名額（-N 名字 用），依 seq（AC-5）。 */
  findActiveProxy(
    eventId: number,
    ownerUserId: number,
    displayName: string,
  ): RegistrationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM registrations
         WHERE event_id = ? AND owner_user_id = ? AND kind = 'proxy'
           AND display_name = ? AND cancelled_at IS NULL
         ORDER BY seq`,
      )
      .all(eventId, ownerUserId, displayName) as RegistrationRow[];
  }

  /** FIFO 選取可遞補的有效候補列（僅 cancelled_at IS NULL；G10、AC-4）。 */
  pickWaitlistForPromotion(eventId: number, limit: number): RegistrationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM registrations
         WHERE event_id = ? AND status = 'waitlist' AND cancelled_at IS NULL
         ORDER BY seq LIMIT ?`,
      )
      .all(eventId, limit) as RegistrationRow[];
  }

  getById(id: number): RegistrationRow | undefined {
    return this.db
      .prepare('SELECT * FROM registrations WHERE id = ?')
      .get(id) as RegistrationRow | undefined;
  }

  // ── 寫入原語（須在 IMMEDIATE 交易內；G2） ──────────────────────────────

  /** event 內下一個 seq：`COALESCE(MAX(seq),0)+1`，含已取消列（只增不減；G7）。 */
  private nextSeq(eventId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM registrations WHERE event_id = ?')
      .get(eventId) as { next: number };
    return row.next;
  }

  /** 插入單一名額列，seq 於交易內指派。 */
  insertSlot(input: InsertSlotInput): RegistrationRow {
    this.assertInTransaction();
    const now = nowIso();
    const seq = this.nextSeq(input.eventId);
    const info = this.db
      .prepare(
        `INSERT INTO registrations
           (event_id, owner_user_id, display_name, kind, status, seq,
            cancelled_at, cancelled_by_user_id, created_at)
         VALUES (@eventId, @ownerUserId, @displayName, @kind, @status, @seq,
            NULL, NULL, @now)`,
      )
      .run({
        eventId: input.eventId,
        ownerUserId: input.ownerUserId,
        displayName: input.displayName,
        kind: input.kind,
        status: input.status,
        seq,
        now,
      });
    const row = this.getById(Number(info.lastInsertRowid));
    if (row === undefined) {
      throw new Error('insertSlot 後查無新列');
    }
    return row;
  }

  /**
   * 插入同批 count 個名額列，seq 依序遞增（同批同狀態）。
   * 整批 confirmed/waitlist 的決策由呼叫端（D-002）於同一交易內先計數後指定 status。
   */
  insertSlots(input: InsertSlotInput, count: number): RegistrationRow[] {
    this.assertInTransaction();
    const rows: RegistrationRow[] = [];
    for (let i = 0; i < count; i += 1) {
      rows.push(this.insertSlot(input));
    }
    return rows;
  }

  /**
   * soft-delete 標記取消（G9，禁止 DELETE）：設 cancelled_at 與 cancelled_by_user_id。
   * 僅影響尚未取消（cancelled_at IS NULL）的列；回傳實際取消列數。
   */
  cancelByIds(ids: number[], cancelledByUserId: number): number {
    this.assertInTransaction();
    if (ids.length === 0) return 0;
    const now = nowIso();
    const stmt = this.db.prepare(
      `UPDATE registrations
       SET cancelled_at = ?, cancelled_by_user_id = ?
       WHERE id = ? AND cancelled_at IS NULL`,
    );
    let affected = 0;
    for (const id of ids) {
      affected += stmt.run(now, cancelledByUserId, id).changes;
    }
    return affected;
  }

  /**
   * 遞補：waitlist → confirmed，`seq` 保持不變（G7）。
   * 僅影響有效（cancelled_at IS NULL）且仍為 waitlist 的列；回傳實際遞補列數。
   */
  promoteByIds(ids: number[]): number {
    this.assertInTransaction();
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE registrations SET status = 'confirmed'
       WHERE id = ? AND status = 'waitlist' AND cancelled_at IS NULL`,
    );
    let affected = 0;
    for (const id of ids) {
      affected += stmt.run(id).changes;
    }
    return affected;
  }
}
