import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './test-db';

/**
 * D-013 AC-3b（0004 的 NULL 清理）。
 *
 * `runMigrations` 無「套用至指定版本」能力，且 0004 後 group_id 為 NOT NULL 無法再造 NULL 列
 * ⇒ 不可用一般測試流程驗。故採 D-013 所載作法 **(i)**：於**獨立 schema** 以 `readFileSync`
 * 手動依序套 0001–0003 → 插一列 NULL + 一列正常 → 套 0004 → 斷言只有 NULL 列被刪（G8）。
 *
 * **套 0004 時務必自行 BEGIN/COMMIT**（architect nit）：`SET LOCAL` 在交易外只發 WARNING 而無效，
 * 與 runner（單檔單交易）的實際行為不一致。
 */
const SCHEMA = 'd013_ac3b';
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const NOW = '2026-08-19T00:00:00Z';

function sqlOf(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

describe('D-013 0004 NULL 清理（獨立 schema 重放 0001→0004）', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-013 AC-3b] 0004 只刪 group_id IS NULL 的列，正常列保留，且套用後 PK 為複合鍵', async () => {
    const client = await t.pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`SET search_path TO ${SCHEMA}`); // 本 session 專屬，不影響其他連線

      // 依序套 0001–0003（各自單檔單交易，等同 runner 行為）。
      for (const f of ['0001_init.sql', '0002_billing_modes.sql', '0003_merge_event_datetime.sql']) {
        await client.query('BEGIN');
        await client.query(sqlOf(f));
        await client.query('COMMIT');
      }

      // 0004 前 group_id 仍 nullable → 造出一列 NULL（實務應為 0 列）＋一列正常。
      await client.query(
        `INSERT INTO conversation_states (line_user_id, group_id, state, payload, updated_at)
         VALUES ('U-null', NULL, 'awaiting_date', NULL, $1),
                ('U-ok', 'G-1', 'awaiting_time', NULL, $1)`,
        [NOW],
      );
      expect(
        Number(
          (await client.query<{ n: string }>('SELECT COUNT(*) AS n FROM conversation_states')).rows[0]!.n,
        ),
      ).toBe(2);

      // 套 0004（自行 BEGIN/COMMIT，使 SET LOCAL lock_timeout 真正生效）。
      await client.query('BEGIN');
      await client.query(sqlOf('0004_conversation_scope_pk.sql'));
      await client.query('COMMIT');

      // 只有 NULL 列被刪（G8：DELETE 僅帶 WHERE group_id IS NULL）。
      const rows = await client.query<{ line_user_id: string }>(
        'SELECT line_user_id FROM conversation_states ORDER BY line_user_id',
      );
      expect(rows.rows.map((r) => r.line_user_id)).toEqual(['U-ok']);

      // 該 schema 內 PK 已為複合鍵、group_id NOT NULL。
      const pk = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = '${SCHEMA}.conversation_states'::regclass AND contype = 'p'`,
      );
      expect(pk.rows[0]!.def).toBe('PRIMARY KEY (group_id, line_user_id)');
      await expect(
        client.query(
          `INSERT INTO conversation_states (line_user_id, group_id, state, payload, updated_at)
           VALUES ('U-null2', NULL, 'awaiting_date', NULL, $1)`,
          [NOW],
        ),
      ).rejects.toThrow(/null value|not-null/i);
    } finally {
      // 若 try 內於交易中途拋錯，連線會停在 aborted-tx 狀態 → 後續 query 一律再拋，
      // 導致 RESET/release 不執行而洩漏連線並遮蔽原始錯誤（architect nit-2）。
      // 故先無條件 ROLLBACK，再以個別 catch 包住清理，確保 release 必定執行。
      await client.query('ROLLBACK').catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await client.query('RESET search_path').catch(() => {}); // 還原後才可歸還連線池
      client.release();
    }
  });
});
