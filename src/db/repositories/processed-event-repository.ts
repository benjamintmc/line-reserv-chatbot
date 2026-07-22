import type { Db } from '../index';
import { nowIso } from '../time';

/**
 * processed_events 資料存取（webhook 冪等去重，NFR-2 / G6）。
 * 以持久化表達成去重，不得僅靠應用層記憶體狀態（G6）。
 */
export class ProcessedEventRepository {
  constructor(private readonly db: Db) {}

  /**
   * 標記事件已處理：`INSERT OR IGNORE`。
   * @returns 新事件（首次寫入）回傳 true；重複事件（影響 0 列）回傳 false → 呼叫端應略過副作用。
   */
  markProcessed(messageId: string): boolean {
    const now = nowIso();
    const info = this.db
      .prepare('INSERT OR IGNORE INTO processed_events (message_id, created_at) VALUES (?, ?)')
      .run(messageId, now);
    return info.changes === 1;
  }

  has(messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM processed_events WHERE message_id = ?')
      .get(messageId);
    return row !== undefined;
  }
}
