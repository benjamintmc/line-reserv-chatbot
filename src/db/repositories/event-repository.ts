import type { Queryable } from '../index';
import { nowIso } from '../time';
import {
  ACTIVE_EVENT_STATUSES,
  DISPLAYABLE_EVENT_STATUSES,
  type EventRow,
  type EventStatus,
  type PriceMode,
} from '../schema';

export interface CreateEventInput {
  groupId: string;
  hostUserId: number;
  /** 活動開始時刻，UTC ISO-8601（`YYYY-MM-DDTHH:MM:SSZ`）；由 domain 以 taipeiToUtcIso 合併轉存（D-008 §3）。 */
  eventDatetime: string;
  location: string;
  capacity: number;
  pricePerPerson?: number;
  /** 計費模式（D-005 §1）；預設 'per_person'（回歸）。 */
  priceMode?: PriceMode;
  /** 場地費總額（split_venue 必填且 >0）；per_person 不得帶（G4）。 */
  venueFee?: number;
  status?: EventStatus;
}

/**
 * events 唯讀介面（N-new-2）：pool-bound 依賴只曝讀方法（getById/findActiveByGroup/findLatestDisplayable），
 * 寫入（create/updateStatus/updateSettledPerPerson）僅存在於 client-bound `TxRepos.events`（交易內）。
 */
export interface EventReader {
  getById(id: number): Promise<EventRow | undefined>;
  /** 擋團/生命週期：回 status ∈ {draft,open} 的最新一場（D-008：不回 closed）。 */
  findActiveByGroup(groupId: string): Promise<EventRow | undefined>;
  /** 顯示用：回 status ∈ {draft,open,closed} 的最新一場（latest by id），供 `名單`（D-008 §2/OP-4）。 */
  findLatestDisplayable(groupId: string): Promise<EventRow | undefined>;
}

/**
 * events 資料存取。同 group 至多一場 active 由 DB partial unique index
 * `ux_events_active_group` 強制（G3）；重複建立 active 會拋唯一約束錯誤（PG `23505`）。
 *
 * 註：狀態轉移合法性（D-001 §7 狀態機）為 domain 層（D-002/D-003）決策，
 * 本層 `updateStatus` 僅提供原子寫入原語，不校驗轉移合法性。
 *
 * N-new-2 硬化：event 的寫入皆於 `runInTransaction` 交易內發生（confirm/close/cancel），
 * 故寫方法只在完整類別（client-bound）曝露；domain pool-bound 依賴型別為 {@link EventReader}。
 */
export class EventRepository implements EventReader {
  constructor(private readonly q: Queryable) {}

  async create(input: CreateEventInput): Promise<EventRow> {
    const now = nowIso();
    // D-005 §1.3 / G4：邊界層強制 price_mode 與 venue_fee/price_per_person 一致性。
    // split_venue → venue_fee 為整數且 >0、price_per_person=0；
    // per_person → venue_fee 必為 NULL（帶入 venueFee 視為不一致組合，拒絕）。
    const priceMode: PriceMode = input.priceMode ?? 'per_person';
    let venueFee: number | null;
    let pricePerPerson: number;
    if (priceMode === 'split_venue') {
      const fee = input.venueFee;
      if (fee === undefined || !Number.isInteger(fee) || fee <= 0) {
        throw new Error('split_venue 需要正整數 venue_fee（G4 一致性）');
      }
      venueFee = fee;
      pricePerPerson = 0; // split 模式 price_per_person 恆為 0（欄位 NOT NULL 不可 NULL）
    } else {
      if (input.venueFee !== undefined) {
        throw new Error('per_person 不得帶 venue_fee（G4 一致性）');
      }
      venueFee = null; // per_person 模式 venue_fee 恆為 NULL
      pricePerPerson = input.pricePerPerson ?? 0;
    }

    const res = await this.q.query<EventRow>(
      `INSERT INTO events
         (group_id, host_user_id, event_datetime, location,
          capacity, price_per_person, price_mode, venue_fee, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        input.groupId,
        input.hostUserId,
        input.eventDatetime,
        input.location,
        input.capacity,
        pricePerPerson,
        priceMode,
        venueFee,
        input.status ?? 'draft',
        now,
      ],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new Error('create event 後查無新列');
    }
    return row;
  }

  async getById(id: number): Promise<EventRow | undefined> {
    const res = await this.q.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
    return res.rows[0];
  }

  /** 查某 group 目前唯一的 active 活動（status ∈ {draft,open}；D-008：不含 closed）。 */
  async findActiveByGroup(groupId: string): Promise<EventRow | undefined> {
    const res = await this.q.query<EventRow>(
      `SELECT * FROM events
       WHERE group_id = $1 AND status = ANY($2)
       ORDER BY id DESC LIMIT 1`,
      [groupId, [...ACTIVE_EVENT_STATUSES]],
    );
    return res.rows[0];
  }

  /**
   * 顯示用唯讀原語（D-008 §2/§5）：回 status ∈ {draft,open,closed} 的最新一場（latest by id）。
   * 供 `名單`——closed 與新 open 可並存時取較新者；僅 closed 時取到 closed（標「報名已截止」）。
   * done/cancelled 不納入（done 必被更新 open 取代、cancelled 為終態）。由既有 ix_events_group_status 支撐。
   */
  async findLatestDisplayable(groupId: string): Promise<EventRow | undefined> {
    const res = await this.q.query<EventRow>(
      `SELECT * FROM events
       WHERE group_id = $1 AND status = ANY($2)
       ORDER BY id DESC LIMIT 1`,
      [groupId, [...DISPLAYABLE_EVENT_STATUSES]],
    );
    return res.rows[0];
  }

  /** 狀態轉移（原子寫入原語；合法性校驗屬 domain）。回傳受影響列數。 */
  async updateStatus(id: number, status: EventStatus): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET status = $1, updated_at = $2 WHERE id = $3',
      [status, now, id],
    );
    return res.rowCount ?? 0;
  }

  /**
   * 寫入 split_venue 關閉報名時的最終每人攤額（D-005 §4 / OP-3；architect N2 專屬原語）。
   * 與 updateStatus 分離：狀態轉移與結算金額為兩種關注點，不耦合。回傳受影響列數。
   */
  async updateSettledPerPerson(id: number, amount: number): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET settled_per_person = $1, updated_at = $2 WHERE id = $3',
      [amount, now, id],
    );
    return res.rowCount ?? 0;
  }

  // ── D-015 編輯活動資訊：四個單欄寫入原語（§2） ────────────────────────
  //
  // 一律 `UPDATE events SET <單欄>, updated_at WHERE id`：一次呼叫只動一欄，
  // 使「單次編輯只能 UPDATE 一個欄位」（G2 可寫欄位封閉集）由原語形狀保證，
  // 呼叫端無從一次寫兩欄。皆屬 client-bound `TxRepos.events` 寫方法，
  // 必於 `runImmediate`（FOR UPDATE）交易內呼叫（G1）。回傳受影響列數。

  /** 改活動開始時刻（UTC ISO-8601；由 domain 以 taipeiToUtcIso 合併台灣本地日期＋時間後傳入）。 */
  async updateEventDatetime(id: number, eventDatetime: string): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET event_datetime = $1, updated_at = $2 WHERE id = $3',
      [eventDatetime, now, id],
    );
    return res.rowCount ?? 0;
  }

  /** 改場地名稱（長度上限由 commands 邊界層把關，本層不截斷）。 */
  async updateLocation(id: number, location: string): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET location = $1, updated_at = $2 WHERE id = $3',
      [location, now, id],
    );
    return res.rowCount ?? 0;
  }

  /** 改每人固定費用（per_person 模式；不動 price_mode，計費方式不可切換，G2）。 */
  async updatePricePerPerson(id: number, pricePerPerson: number): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET price_per_person = $1, updated_at = $2 WHERE id = $3',
      [pricePerPerson, now, id],
    );
    return res.rowCount ?? 0;
  }

  /** 改場地費總額（split_venue 模式；不動 price_mode／settled_per_person，G2）。 */
  async updateVenueFee(id: number, venueFee: number): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET venue_fee = $1, updated_at = $2 WHERE id = $3',
      [venueFee, now, id],
    );
    return res.rowCount ?? 0;
  }

  /**
   * D-010 §一.4：加開名額原子寫入原語（只加不減語意由 domain 保證，本層僅寫入）。
   * 與 updateStatus 分離（capacity 與狀態轉移為兩種關注點）。回傳受影響列數。
   * 屬 client-bound `TxRepos.events` 寫方法；必於 `runImmediate`（FOR UPDATE）交易內呼叫（G2）。
   */
  async updateCapacity(id: number, capacity: number): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET capacity = $1, updated_at = $2 WHERE id = $3',
      [capacity, now, id],
    );
    return res.rowCount ?? 0;
  }
}
