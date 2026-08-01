import type { Queryable } from '../index';
import { nowIso } from '../time';

/**
 * processed_events 資料存取（webhook 冪等去重，NFR-2 / G6）。
 * 以持久化表達成去重，不得僅靠應用層記憶體狀態（G6）。
 *
 * N-new-2 例外（不做讀寫分離）：`markProcessed` 雖為寫入，但 D-003 §5「名單」唯讀去重於**交易外**
 * 呼叫（無資料副作用），故 ProcessedEventRepository 維持 pool-bound 可呼叫。交易內去重（首步）
 * 則經 client-bound `TxRepos.processed`（同一連線，G1）。
 */
export class ProcessedEventRepository {
  constructor(private readonly q: Queryable) {}

  /**
   * 標記事件已處理：`INSERT … ON CONFLICT (message_id) DO NOTHING`（等義 SQLite INSERT OR IGNORE）。
   * @returns 新事件（首次寫入，rowCount=1）回傳 true；重複事件（衝突、rowCount=0）回傳 false → 呼叫端應略過副作用。
   */
  async markProcessed(messageId: string): Promise<boolean> {
    const now = nowIso();
    const res = await this.q.query(
      `INSERT INTO processed_events (message_id, created_at) VALUES ($1, $2)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, now],
    );
    return res.rowCount === 1;
  }

  async has(messageId: string): Promise<boolean> {
    const res = await this.q.query('SELECT 1 AS x FROM processed_events WHERE message_id = $1', [
      messageId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }
}
