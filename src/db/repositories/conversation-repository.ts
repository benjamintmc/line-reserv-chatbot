import type { Queryable } from '../index';
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
 * conversation_states 唯讀介面（N-new-2）：pool-bound 依賴只曝讀方法，
 * 寫入（upsert/delete）僅存在於 client-bound `TxRepos.conversations`（交易內）。
 */
export interface ConversationReader {
  get(lineUserId: string): Promise<ConversationStateRow | undefined>;
}

/**
 * conversation_states 資料存取（逐步開團問答暫存）。
 * 一位使用者同時最多一段進行中對話，故以 line_user_id 為主鍵。
 *
 * N-new-2 硬化：開團流程的 conversation 寫入（upsert/delete）皆於 `runInTransaction` 交易內發生
 * （startCreation/handleOneline/continueFlow/confirm/abort），故寫方法只在完整類別（client-bound）曝露；
 * domain 建構時綁 pool 的依賴型別為 {@link ConversationReader}，編譯器擋掉交易外誤寫。
 */
export class ConversationRepository implements ConversationReader {
  constructor(private readonly q: Queryable) {}

  async upsert(input: UpsertConversationInput): Promise<ConversationStateRow> {
    const now = nowIso();
    const res = await this.q.query<ConversationStateRow>(
      `INSERT INTO conversation_states (line_user_id, group_id, state, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (line_user_id) DO UPDATE SET
         group_id   = excluded.group_id,
         state      = excluded.state,
         payload    = excluded.payload,
         updated_at = excluded.updated_at
       RETURNING *`,
      [input.lineUserId, input.groupId, input.state, input.payload, now],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new Error(`upsert conversation 後查無 line_user_id=${input.lineUserId}`);
    }
    return row;
  }

  async get(lineUserId: string): Promise<ConversationStateRow | undefined> {
    const res = await this.q.query<ConversationStateRow>(
      'SELECT * FROM conversation_states WHERE line_user_id = $1',
      [lineUserId],
    );
    return res.rows[0];
  }

  /** 刪除對話狀態（完成/放棄/TTL 逾時清理）。回傳是否刪到列。 */
  async delete(lineUserId: string): Promise<boolean> {
    const res = await this.q.query(
      'DELETE FROM conversation_states WHERE line_user_id = $1',
      [lineUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
