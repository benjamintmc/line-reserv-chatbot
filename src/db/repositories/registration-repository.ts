import type { Queryable } from '../index';
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
 * registrations 唯讀介面（N-new-2 硬化，G1 核心）：pool-bound 依賴只曝**讀**方法，
 * **寫**方法（insertSlot/insertSlots/cancelByIds/promoteByIds）只存在於 client-bound
 * `TxRepos.registrations`（交易內、同一 checked-out client）。
 *
 * 藉此讓「名額讀改寫必在 FOR UPDATE 交易內」由**編譯器**強制：domain 建構時綁 pool 的
 * `this.registrations` 型別為 {@link RegistrationReader}，取不到寫方法 → 交易外誤寫直接編不過；
 * 取代 SQLite 版的 runtime `assertInTransaction`（PG pool 無 `db.inTransaction` 可守門）。
 */
export interface RegistrationReader {
  countConfirmed(eventId: number): Promise<number>;
  listConfirmed(eventId: number): Promise<RegistrationRow[]>;
  listWaitlist(eventId: number): Promise<RegistrationRow[]>;
  findActiveByOwner(eventId: number, ownerUserId: number): Promise<RegistrationRow[]>;
  findActiveProxy(
    eventId: number,
    ownerUserId: number,
    displayName: string,
  ): Promise<RegistrationRow[]>;
  findActiveProxyByName(eventId: number, displayName: string): Promise<RegistrationRow[]>;
  pickWaitlistForPromotion(eventId: number, limit: number): Promise<RegistrationRow[]>;
  getById(id: number): Promise<RegistrationRow | undefined>;
}

/**
 * registrations 資料存取（per-slot，ADR-001）。
 *
 * 併發與冪等（ADR-002 / ADR-004 / G1）：所有 registrations 寫入（插入/取消/遞補）必須在交易內、
 * 先 `SELECT … FROM events WHERE id=$1 FOR UPDATE` 鎖住該 event 後執行——以 `src/db/tx.ts` 的
 * `runImmediate(eventId, work)` 包裹；work 只能經注入的 client-bound `TxRepos.registrations`
 * 呼叫寫方法（同一連線，鎖生效）。寫方法在型別上不對 pool-bound 依賴曝露（{@link RegistrationReader}）。
 *
 * 有效性（G10）：所有「有效名額」查詢一律帶 `cancelled_at IS NULL`。
 * 取消一律 soft-delete（G9）：標記 `cancelled_at`/`cancelled_by_user_id`，
 * **本層不提供、也不得對 registrations 下任何 `DELETE`**。
 *
 * 本層僅提供資料操作原語（計數、插入 slot、標記取消、選候補、遞補）；
 * 「+N 額滿判斷 / 整批轉候補 / 遞補」的商業決策屬 D-002，於同一交易內組合這些原語。
 */
export class RegistrationRepository implements RegistrationReader {
  constructor(private readonly q: Queryable) {}

  // ── 查詢原語（有效性一律帶 cancelled_at IS NULL；G10） ─────────────────

  /** 有效正取數（不另存 count；G1）。 */
  async countConfirmed(eventId: number): Promise<number> {
    const res = await this.q.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM registrations
       WHERE event_id = $1 AND status = 'confirmed' AND cancelled_at IS NULL`,
      [eventId],
    );
    // PG COUNT(*) 回 bigint → JS string；轉 number（值域內安全）。
    return Number(res.rows[0]?.n ?? 0);
  }

  /** 有效正取名單，依 seq（到場順序）。 */
  async listConfirmed(eventId: number): Promise<RegistrationRow[]> {
    const res = await this.q.query<RegistrationRow>(
      `SELECT * FROM registrations
       WHERE event_id = $1 AND status = 'confirmed' AND cancelled_at IS NULL
       ORDER BY seq`,
      [eventId],
    );
    return res.rows;
  }

  /** 有效候補佇列（FIFO），依 seq。 */
  async listWaitlist(eventId: number): Promise<RegistrationRow[]> {
    const res = await this.q.query<RegistrationRow>(
      `SELECT * FROM registrations
       WHERE event_id = $1 AND status = 'waitlist' AND cancelled_at IS NULL
       ORDER BY seq`,
      [eventId],
    );
    return res.rows;
  }

  /** 定位某 owner 未取消名額（-N 用），依 seq。 */
  async findActiveByOwner(eventId: number, ownerUserId: number): Promise<RegistrationRow[]> {
    const res = await this.q.query<RegistrationRow>(
      `SELECT * FROM registrations
       WHERE event_id = $1 AND owner_user_id = $2 AND cancelled_at IS NULL
       ORDER BY seq`,
      [eventId, ownerUserId],
    );
    return res.rows;
  }

  /** 定位某 owner 的代報名未取消名額（-N 名字 用），依 seq（AC-5）。 */
  async findActiveProxy(
    eventId: number,
    ownerUserId: number,
    displayName: string,
  ): Promise<RegistrationRow[]> {
    const res = await this.q.query<RegistrationRow>(
      `SELECT * FROM registrations
       WHERE event_id = $1 AND owner_user_id = $2 AND kind = 'proxy'
         AND display_name = $3 AND cancelled_at IS NULL
       ORDER BY seq`,
      [eventId, ownerUserId, displayName],
    );
    return res.rows;
  }

  /**
   * 跨 owner 定位某 event 下所有有效代報列（`kind='proxy'` 且 display_name 相符），依 seq 升冪。
   *
   * 用途（D-003 §3 / OP-2）：主辦人（`executor.id === event.host_user_id`）以 `-N 名字`
   * 代取消**任一 owner** 代報的該名字名額；取消順序由 domain 再排（先候補後正取、組內高 seq 先）。
   * 與 owner-scoped {@link findActiveProxy} 的差別＝**不限 owner**；純唯讀查詢原語（不涉寫入交易）。
   */
  async findActiveProxyByName(eventId: number, displayName: string): Promise<RegistrationRow[]> {
    const res = await this.q.query<RegistrationRow>(
      `SELECT * FROM registrations
       WHERE event_id = $1 AND kind = 'proxy'
         AND display_name = $2 AND cancelled_at IS NULL
       ORDER BY seq`,
      [eventId, displayName],
    );
    return res.rows;
  }

  /** FIFO 選取可遞補的有效候補列（僅 cancelled_at IS NULL；G10、AC-4）。 */
  async pickWaitlistForPromotion(eventId: number, limit: number): Promise<RegistrationRow[]> {
    const res = await this.q.query<RegistrationRow>(
      `SELECT * FROM registrations
       WHERE event_id = $1 AND status = 'waitlist' AND cancelled_at IS NULL
       ORDER BY seq LIMIT $2`,
      [eventId, limit],
    );
    return res.rows;
  }

  async getById(id: number): Promise<RegistrationRow | undefined> {
    const res = await this.q.query<RegistrationRow>(
      'SELECT * FROM registrations WHERE id = $1',
      [id],
    );
    return res.rows[0];
  }

  // ── 寫入原語（僅 client-bound TxRepos 曝露；須在 FOR UPDATE 交易內；G1/G2） ────

  /** event 內下一個 seq：`COALESCE(MAX(seq),0)+1`，含已取消列（只增不減；G7）。 */
  private async nextSeq(eventId: number): Promise<number> {
    const res = await this.q.query<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM registrations WHERE event_id = $1',
      [eventId],
    );
    // MAX(seq)/+1 為 int4 → number（seq 為 INTEGER，非 bigint）。
    return res.rows[0]?.next ?? 1;
  }

  /** 插入單一名額列，seq 於交易內指派。RETURNING 一趟取回整列（N3，省一次 RTT）。 */
  async insertSlot(input: InsertSlotInput): Promise<RegistrationRow> {
    const now = nowIso();
    const seq = await this.nextSeq(input.eventId);
    const res = await this.q.query<RegistrationRow>(
      `INSERT INTO registrations
         (event_id, owner_user_id, display_name, kind, status, seq,
          cancelled_at, cancelled_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7)
       RETURNING *`,
      [input.eventId, input.ownerUserId, input.displayName, input.kind, input.status, seq, now],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new Error('insertSlot 後查無新列');
    }
    return row;
  }

  /**
   * 插入同批 count 個名額列，seq 依序遞增（同批同狀態）。
   * 整批 confirmed/waitlist 的決策由呼叫端（D-002）於同一交易內先計數後指定 status。
   */
  async insertSlots(input: InsertSlotInput, count: number): Promise<RegistrationRow[]> {
    const rows: RegistrationRow[] = [];
    for (let i = 0; i < count; i += 1) {
      rows.push(await this.insertSlot(input));
    }
    return rows;
  }

  /**
   * soft-delete 標記取消（G9，禁止 DELETE）：設 cancelled_at 與 cancelled_by_user_id。
   * 僅影響尚未取消（cancelled_at IS NULL）的列；回傳實際取消列數。
   */
  async cancelByIds(ids: number[], cancelledByUserId: number): Promise<number> {
    if (ids.length === 0) return 0;
    const now = nowIso();
    const res = await this.q.query(
      `UPDATE registrations
       SET cancelled_at = $1, cancelled_by_user_id = $2
       WHERE id = ANY($3::int[]) AND cancelled_at IS NULL`,
      [now, cancelledByUserId, ids],
    );
    return res.rowCount ?? 0;
  }

  /**
   * 遞補：waitlist → confirmed，`seq` 保持不變（G7）。
   * 僅影響有效（cancelled_at IS NULL）且仍為 waitlist 的列；回傳實際遞補列數。
   */
  async promoteByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.q.query(
      `UPDATE registrations SET status = 'confirmed'
       WHERE id = ANY($1::int[]) AND status = 'waitlist' AND cancelled_at IS NULL`,
      [ids],
    );
    return res.rowCount ?? 0;
  }
}
