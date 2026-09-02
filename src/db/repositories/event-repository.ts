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
 * events 唯讀介面（N-new-2）：pool-bound 依賴只曝讀方法（getById/listActiveByGroup/findLatestDisplayable），
 * 寫入（create/updateStatus/updateSettledPerPerson）僅存在於 client-bound `TxRepos.events`（交易內）。
 *
 * **D-021 G1（無單值介面殘留）**：不得保留 `findActiveByGroup` 或任何「回傳單一活動」當作預設
 * 路徑的方法——「回傳單一列」的介面形狀本身就是「同群只有一場」假設的化身，留著（即使只是
 * wrapper／deprecated 別名）就會被日後新代碼誤用而悄悄退回單場語意。
 */
export interface EventReader {
  getById(id: number): Promise<EventRow | undefined>;
  /**
   * 取代 `findActiveByGroup`（D-021 §2）：回該群 status ∈ {draft,open} 的**全部**列，依 id **升冪**。
   * 呼叫端一律「listActiveByGroup → 消歧義解出 eventId → getById(eventId) 權威重讀」。
   */
  listActiveByGroup(groupId: string): Promise<EventRow[]>;
  /** 顯示用：回 status ∈ {draft,open,closed} 的最新一場（latest by id），供 `名單`（D-008 §2/OP-4）。 */
  findLatestDisplayable(groupId: string): Promise<EventRow | undefined>;
}

/**
 * events 資料存取。**同群多場 active 已於 0006（D-021 §1）解鎖**——舊 `ux_events_active_group`
 * 已 DROP，改由 `ux_events_active_group_venue_time`（同群 active 內場地+時間不得重複）把關；
 * 撞該索引一樣拋唯一約束錯誤（PG `23505`，constraint 為**新**索引名，D-021 G8）。
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

  /**
   * 查某 group 目前**全部** active 活動（status ∈ {draft,open}；D-008：不含 closed），依 id 升冪。
   *
   * **`ORDER BY id ASC` 為 D-021 §2 釘死值，不得改為 `DESC`**：D-021 §1 過渡條文的開團側三處
   * 以 `actives.at(-1)`（＝最新一場）取代舊 `findActiveByGroup` 的 `ORDER BY id DESC LIMIT 1`，
   * 升冪是該取用的唯一正確性依據；改成降冪會讓它靜默取到最舊一場（`[D-021 AC-2]` 為保護網）。
   */
  async listActiveByGroup(groupId: string): Promise<EventRow[]> {
    const res = await this.q.query<EventRow>(
      `SELECT * FROM events
       WHERE group_id = $1 AND status = ANY($2)
       ORDER BY id ASC`,
      [groupId, [...ACTIVE_EVENT_STATUSES]],
    );
    return res.rows;
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

  // ── D-015 編輯活動資訊：單欄寫入原語（§2） ──────────────────────────────
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

  /**
   * D-019 §一.4：`編輯 費用` 三欄原子寫入（G2）——`price_mode`／`price_per_person`／`venue_fee`
   * 於**單一** UPDATE 內同時定值，取代原兩個單欄原語 `updatePricePerPerson`/`updateVenueFee`
   * （D-019 已確認除 fee 路徑外無其他呼叫點，予以移除）。不論是否切換模式皆走此原語：
   * 同模式改價＝三欄中兩欄值不變、一欄變，仍是同一 UPDATE，呼叫端不必分支。
   * 維持 D-005 §1.3 不變式由呼叫端（`event-service.ts` case 'fee'）保證：
   * split → `price_per_person=0`∧`venue_fee>0`；per_person → `venue_fee=NULL`。
   */
  async updateBilling(
    id: number,
    billing: { priceMode: PriceMode; pricePerPerson: number; venueFee: number | null },
  ): Promise<number> {
    const now = nowIso();
    const res = await this.q.query(
      'UPDATE events SET price_mode = $1, price_per_person = $2, venue_fee = $3, updated_at = $4 WHERE id = $5',
      [billing.priceMode, billing.pricePerPerson, billing.venueFee, now, id],
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
