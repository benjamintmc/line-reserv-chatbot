import type { Db } from '../index';
import { nowIso } from '../time';
import type { UserRow } from '../schema';

/**
 * users 資料存取。`display_name` 為最近互動快照，隨 upsert 更新；
 * 歷史名單快照存於 registrations，不受此更新影響（NFR-4、G5）。
 */
export class UserRepository {
  constructor(private readonly db: Db) {}

  /**
   * upsert user：以 line_user_id 為衝突鍵。新列寫入 created_at/updated_at；
   * 既有列僅更新 display_name 與 updated_at（created_at 不變）。
   */
  upsert(lineUserId: string, displayName: string): UserRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO users (line_user_id, display_name, is_host, created_at, updated_at)
         VALUES (@lineUserId, @displayName, 0, @now, @now)
         ON CONFLICT (line_user_id) DO UPDATE SET
           display_name = excluded.display_name,
           updated_at   = excluded.updated_at`,
      )
      .run({ lineUserId, displayName, now });
    const row = this.getByLineUserId(lineUserId);
    if (row === undefined) {
      throw new Error(`upsert user 後查無 line_user_id=${lineUserId}`);
    }
    return row;
  }

  getByLineUserId(lineUserId: string): UserRow | undefined {
    return this.db
      .prepare('SELECT * FROM users WHERE line_user_id = ?')
      .get(lineUserId) as UserRow | undefined;
  }

  getById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
}
