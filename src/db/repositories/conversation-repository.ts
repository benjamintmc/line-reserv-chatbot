import type { Queryable } from '../index';
import { nowIso } from '../time';
import { GROUPING_STATE, type ConversationStateRow } from '../schema';

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
  /**
   * D-030 §2：以 **`(group_id, eventId)`** 撈該群進行中的分組 session（`下一輪` 的 quote 路徑）。
   * `eventId` 取自 payload 的 `GroupingState.eventId`（D-029 §5.5）。查無 → `undefined`。
   */
  getGroupingByEvent(
    groupId: string,
    eventId: number,
  ): Promise<ConversationStateRow | undefined>;
}

/**
 * 取 `conversation_states.payload` 內的 `eventId`；**非 JSON／無該欄位／非數字一律 `undefined`**。
 *
 * G4（D-030）：T-033b 之前建立的 grouping session，payload 沒有 `eventId`；更早的列甚至可能
 * 不是合法 JSON。Postgres 的 `::jsonb` cast 碰到非 JSON 文字會丟 22P02，而 WHERE 子句的
 * 求值順序**不保證**——前置 `payload LIKE '{%'` 之類的守衛可能被 planner 排在 cast 之後，
 * 整個查詢仍會炸。故本查詢的 SQL **完全不碰 payload 內容**（只篩 `(group_id, state)`，每群
 * 至多數列），比對改在此處以 try/catch 完成：結構上不可能讓查詢報錯。
 *
 * 此處的 catch **不是吞例外**：「payload 不是合法 JSON」是本函式要回答的問題之一
 * （歷史資料的已知形狀），不是非預期錯誤。
 */
function payloadEventId(payload: string | null): number | undefined {
  if (payload === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value: unknown = (parsed as Record<string, unknown>).eventId;
  return typeof value === 'number' ? value : undefined;
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

  /**
   * D-030 §2：該群「綁定某一場活動」的分組 session（見 {@link ConversationReader}）。
   *
   * G4：SQL 只篩 `(group_id, state)` 並取回整列，`eventId` 的比對交給 {@link payloadEventId}
   * ——理由見該函式註解（`::jsonb` cast 會被歷史非 JSON 列炸掉，且 WHERE 求值順序不可倚賴）。
   * 多列相符時取最近更新者（`ORDER BY updated_at DESC`；實務上同一場至多一列）。
   */
  async getGroupingByEvent(
    groupId: string,
    eventId: number,
  ): Promise<ConversationStateRow | undefined> {
    const res = await this.q.query<ConversationStateRow>(
      `SELECT * FROM conversation_states
       WHERE group_id = $1 AND state = $2 AND payload IS NOT NULL
       ORDER BY updated_at DESC, line_user_id`,
      [groupId, GROUPING_STATE],
    );
    return res.rows.find((row) => payloadEventId(row.payload) === eventId);
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
