import type { Db } from '../index';
import { nowIso } from '../time';
import {
  ACTIVE_EVENT_STATUSES,
  type EventRow,
  type EventStatus,
  type PriceMode,
} from '../schema';

export interface CreateEventInput {
  groupId: string;
  hostUserId: number;
  eventDate: string;
  eventTime: string;
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
 * events 資料存取。同 group 至多一場 active 由 DB partial unique index
 * `ux_events_active_group` 強制（G3）；重複建立 active 會拋唯一約束錯誤。
 *
 * 註：狀態轉移合法性（D-001 §7 狀態機）為 domain 層（D-002/D-003）決策，
 * 本層 `updateStatus` 僅提供原子寫入原語，不校驗轉移合法性。
 */
export class EventRepository {
  constructor(private readonly db: Db) {}

  create(input: CreateEventInput): EventRow {
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

    const info = this.db
      .prepare(
        `INSERT INTO events
           (group_id, host_user_id, event_date, event_time, location,
            capacity, price_per_person, price_mode, venue_fee, status, created_at, updated_at)
         VALUES (@groupId, @hostUserId, @eventDate, @eventTime, @location,
            @capacity, @pricePerPerson, @priceMode, @venueFee, @status, @now, @now)`,
      )
      .run({
        groupId: input.groupId,
        hostUserId: input.hostUserId,
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        location: input.location,
        capacity: input.capacity,
        pricePerPerson,
        priceMode,
        venueFee,
        status: input.status ?? 'draft',
        now,
      });
    const row = this.getById(Number(info.lastInsertRowid));
    if (row === undefined) {
      throw new Error('create event 後查無新列');
    }
    return row;
  }

  getById(id: number): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  }

  /** 查某 group 目前唯一的 active 活動（status ∈ {draft,open,closed}）。 */
  findActiveByGroup(groupId: string): EventRow | undefined {
    const placeholders = ACTIVE_EVENT_STATUSES.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM events
         WHERE group_id = ? AND status IN (${placeholders})
         ORDER BY id DESC LIMIT 1`,
      )
      .get(groupId, ...ACTIVE_EVENT_STATUSES) as EventRow | undefined;
  }

  /** 狀態轉移（原子寫入原語；合法性校驗屬 domain）。回傳受影響列數。 */
  updateStatus(id: number, status: EventStatus): number {
    const now = nowIso();
    return this.db
      .prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id).changes;
  }

  /**
   * 寫入 split_venue 關閉報名時的最終每人攤額（D-005 §4 / OP-3；architect N2 專屬原語）。
   * 與 updateStatus 分離：狀態轉移與結算金額為兩種關注點，不耦合。回傳受影響列數。
   */
  updateSettledPerPerson(id: number, amount: number): number {
    const now = nowIso();
    return this.db
      .prepare('UPDATE events SET settled_per_person = ?, updated_at = ? WHERE id = ?')
      .run(amount, now, id).changes;
  }
}
