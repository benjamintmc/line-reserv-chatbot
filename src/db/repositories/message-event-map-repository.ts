import type { Queryable } from '../index';
import { nowIso } from '../time';

/**
 * `message_event_map` 資料存取（D-025 機制 A：bot 訊息 → 活動）。
 *
 * 表由 0006（D-021 §1）建立，**刻意不存 `group_id`**：跨群校驗改在讀取時以 `events.getById`
 * 比對（G14，唯一防線在 dispatch 層的 `resolveQuotedEventInGroup`）。因此本層只是純粹的
 * key-value 存取，**不得**在此新增任何「順便過濾群組」的方法——那會製造第二條語意分歧的防線。
 *
 * 讀寫分離（比照 `EventReader`／`EventRepository`）：
 * - {@link MessageEventMapWriter} 只給 `server.ts` 的回覆後寫入路徑（G3）。
 * - {@link MessageEventMapReader} 只給 webhook handler 的 quote 解析路徑。
 */
export interface MessageEventMapWriter {
  /**
   * 登記「這則 bot 訊息屬於哪一場活動」。
   *
   * 以 `ON CONFLICT (message_id) DO NOTHING` 冪等：LINE message id 全域唯一，同一 id 重複寫入
   * 只可能是重試，先到者為準。
   */
  record(messageId: string, eventId: number): Promise<void>;
}

export interface MessageEventMapReader {
  /** 查該則訊息對應的活動 id；查無 → `undefined`（等同「使用者沒有引言」）。 */
  getEventId(messageId: string): Promise<number | undefined>;
}

export class MessageEventMapRepository implements MessageEventMapWriter, MessageEventMapReader {
  constructor(private readonly q: Queryable) {}

  async record(messageId: string, eventId: number): Promise<void> {
    await this.q.query(
      `INSERT INTO message_event_map (message_id, event_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, eventId, nowIso()],
    );
  }

  async getEventId(messageId: string): Promise<number | undefined> {
    const res = await this.q.query<{ event_id: number }>(
      'SELECT event_id FROM message_event_map WHERE message_id = $1',
      [messageId],
    );
    return res.rows[0]?.event_id;
  }
}
