import type { Queryable } from '../index';
import { nowIso } from '../time';
import type { UserRow } from '../schema';

/**
 * users 資料存取。`display_name` 為最近互動快照，隨 upsert 更新；
 * 歷史名單快照存於 registrations，不受此更新影響（NFR-4、G5）。
 *
 * N-new-2 例外（讀寫方法分離的 carve-out）：`upsert` 雖為寫入，但屬**冪等**且與名額容量無關
 * （signup 的 owner、cancel 的 executor 於交易外登記；N-new-1）。PG 下自成一連線 auto-commit，
 * 正確性無虞，故 UserRepository **不**做讀寫方法型別切分（維持 pool-bound 可呼叫 upsert）。
 */
export class UserRepository {
  constructor(private readonly q: Queryable) {}

  /**
   * upsert user：以 line_user_id 為衝突鍵。新列寫入 created_at/updated_at；
   * 既有列僅更新 display_name 與 updated_at（created_at 不變）。RETURNING 一趟取回（N3）。
   */
  async upsert(lineUserId: string, displayName: string): Promise<UserRow> {
    const now = nowIso();
    const res = await this.q.query<UserRow>(
      `INSERT INTO users (line_user_id, display_name, is_host, created_at, updated_at)
       VALUES ($1, $2, 0, $3, $3)
       ON CONFLICT (line_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at   = excluded.updated_at
       RETURNING *`,
      [lineUserId, displayName, now],
    );
    const row = res.rows[0];
    if (row === undefined) {
      throw new Error(`upsert user 後查無 line_user_id=${lineUserId}`);
    }
    return row;
  }

  async getByLineUserId(lineUserId: string): Promise<UserRow | undefined> {
    const res = await this.q.query<UserRow>('SELECT * FROM users WHERE line_user_id = $1', [
      lineUserId,
    ]);
    return res.rows[0];
  }

  async getById(id: number): Promise<UserRow | undefined> {
    const res = await this.q.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0];
  }
}
