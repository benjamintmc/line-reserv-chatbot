import type { Queryable } from '../index';
import { nowIso } from '../time';
import type { ConversationStateRow } from '../schema';

export interface UpsertConversationInput {
  lineUserId: string;
  /** D-013 G6：不得再允許 null——複合 PK 後 NULL group_id 於型別層即排除。 */
  groupId: string;
  state: string;
  /** 已收集的部分 event 欄位（JSON 字串）。 */
  payload: string | null;
}

/**
 * conversation_states 唯讀介面（N-new-2）：pool-bound 依賴只曝讀方法，
 * 寫入（upsert/delete）僅存在於 client-bound `TxRepos.conversations`（交易內）。
 *
 * D-013：查詢鍵為 `(groupId, lineUserId)`——跨群不可讀由**結構**保證。
 */
export interface ConversationReader {
  get(groupId: string, lineUserId: string): Promise<ConversationStateRow | undefined>;
}

/**
 * conversation_states 資料存取（逐步開團問答／分組 session 暫存）。
 *
 * D-013（migration 0004）：PK 由 `line_user_id` 改為 **`(group_id, line_user_id)`**——
 * 同一人在不同群可各有一段進行中流程（並行共存），同一 `(群, 人)` 則沿用覆寫語意。
 * G2：本表的讀／寫／刪 SQL **一律帶 `group_id`**，不得只以 `line_user_id` 為條件。
 *
 * N-new-2 硬化：開團流程的 conversation 寫入（upsert/delete）皆於 `runInTransaction` 交易內發生
 * （startCreation/handleOneline/continueFlow/confirm/abort），故寫方法只在完整類別（client-bound）曝露；
 * domain 建構時綁 pool 的依賴型別為 {@link ConversationReader}，編譯器擋掉交易外誤寫。
 */
export class ConversationRepository implements ConversationReader {
  constructor(private readonly q: Queryable) {}

  async upsert(input: UpsertConversationInput): Promise<ConversationStateRow> {
    const now = nowIso();
    // conflict target 即新複合 PK；group_id 為鍵的一部分，故不再列入 DO UPDATE SET。
    const res = await this.q.query<ConversationStateRow>(
      `INSERT INTO conversation_states (line_user_id, group_id, state, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, line_user_id) DO UPDATE SET
         state      = excluded.state,
         payload    = excluded.payload,
         updated_at = excluded.updated_at
       RETURNING *`,
      [input.lineUserId, input.groupId, input.state, input.payload, now],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new Error(
        `upsert conversation 後查無 group_id=${input.groupId} line_user_id=${input.lineUserId}`,
      );
    }
    return row;
  }

  async get(groupId: string, lineUserId: string): Promise<ConversationStateRow | undefined> {
    const res = await this.q.query<ConversationStateRow>(
      'SELECT * FROM conversation_states WHERE group_id = $1 AND line_user_id = $2',
      [groupId, lineUserId],
    );
    return res.rows[0];
  }

  /** 刪除該群該人的對話狀態（完成/放棄/TTL 逾時清理）。回傳是否刪到列。 */
  async delete(groupId: string, lineUserId: string): Promise<boolean> {
    const res = await this.q.query(
      'DELETE FROM conversation_states WHERE group_id = $1 AND line_user_id = $2',
      [groupId, lineUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
