import type { Db } from '../index';
import { nowIso } from '../time';
import { ACTIVE_EVENT_STATUSES, type EventRow, type EventStatus } from '../schema';

export interface CreateEventInput {
  groupId: string;
  hostUserId: number;
  eventDate: string;
  eventTime: string;
  location: string;
  capacity: number;
  pricePerPerson?: number;
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
    const info = this.db
      .prepare(
        `INSERT INTO events
           (group_id, host_user_id, event_date, event_time, location,
            capacity, price_per_person, status, created_at, updated_at)
         VALUES (@groupId, @hostUserId, @eventDate, @eventTime, @location,
            @capacity, @pricePerPerson, @status, @now, @now)`,
      )
      .run({
        groupId: input.groupId,
        hostUserId: input.hostUserId,
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        location: input.location,
        capacity: input.capacity,
        pricePerPerson: input.pricePerPerson ?? 0,
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
}
