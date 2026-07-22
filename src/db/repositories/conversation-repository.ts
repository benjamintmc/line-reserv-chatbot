import type { Db } from '../index';
import { nowIso } from '../time';
import type { ConversationStateRow } from '../schema';

export interface UpsertConversationInput {
  lineUserId: string;
  groupId: string | null;
  state: string;
  /** 已收集的部分 event 欄位（JSON 字串）。 */
  payload: string | null;
}

/**
 * conversation_states 資料存取（逐步開團問答暫存）。
 * 一位使用者同時最多一段進行中對話，故以 line_user_id 為主鍵。
 */
export class ConversationRepository {
  constructor(private readonly db: Db) {}

  upsert(input: UpsertConversationInput): ConversationStateRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_states (line_user_id, group_id, state, payload, updated_at)
         VALUES (@lineUserId, @groupId, @state, @payload, @now)
         ON CONFLICT (line_user_id) DO UPDATE SET
           group_id   = excluded.group_id,
           state      = excluded.state,
           payload    = excluded.payload,
           updated_at = excluded.updated_at`,
      )
      .run({
        lineUserId: input.lineUserId,
        groupId: input.groupId,
        state: input.state,
        payload: input.payload,
        now,
      });
    const row = this.get(input.lineUserId);
    if (row === undefined) {
      throw new Error(`upsert conversation 後查無 line_user_id=${input.lineUserId}`);
    }
    return row;
  }

  get(lineUserId: string): ConversationStateRow | undefined {
    return this.db
      .prepare('SELECT * FROM conversation_states WHERE line_user_id = ?')
      .get(lineUserId) as ConversationStateRow | undefined;
  }

  /** 刪除對話狀態（完成/放棄/TTL 逾時清理）。回傳是否刪到列。 */
  delete(lineUserId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM conversation_states WHERE line_user_id = ?')
        .run(lineUserId).changes > 0
    );
  }
}
