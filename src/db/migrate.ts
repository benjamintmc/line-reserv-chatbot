import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, type PoolClient } from './index';
import { nowIso } from './time';
import type { SchemaMigrationRow } from './schema';

/** migration SQL 檔所在目錄（以本檔位置解析：tsx 為 src/db/migrations；build 後由 postbuild 複製到 dist/db/migrations）。 */
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export interface MigrationResult {
  /** 本次實際套用的 version 清單（依序）。 */
  applied: string[];
  /** 先前已套用而略過的 version 清單。 */
  skipped: string[];
}

/**
 * migration runner（async pg）：讀 migrations/*.sql 依檔名序號排序，比對 schema_migrations，
 * 逐檔在**單一交易**內套用尚未套用者，並以應用層 UTC ISO-8601 記錄 applied_at（G11、D-001 §8）。
 * 冪等：重複執行只會略過已套用檔（G7）。
 *
 * 執行時機（G7 / OP-6）：為**部署步驟一次性執行**（對 Neon 直連跑 `npm run db:migrate`），
 * **不在每實例服務啟動路徑上跑**（多實例並行 migrate 有競態、拖慢 cold start）。故本 runner 不含
 * startup 用的 advisory lock——服務啟動只建 Pool、不 migrate（見 server.ts）。
 *
 * 接單一 checked-out `PoolClient`（呼叫端負責 connect/release），確保「DDL + 追蹤紀錄」同進退於同連線。
 */
export async function runMigrations(client: PoolClient): Promise<MigrationResult> {
  // bootstrapping：確保追蹤表存在（0001_init.sql 亦有 IF NOT EXISTS，兩者皆冪等）。
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT NOT NULL PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 檔名零填充序號 → 字典序即套用順序。

  const appliedRes = await client.query<Pick<SchemaMigrationRow, 'version'>>(
    'SELECT version FROM schema_migrations',
  );
  const appliedSet = new Set(appliedRes.rows.map((r) => r.version));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedSet.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // 單檔單交易：DDL 與追蹤紀錄同進退（失敗整檔 ROLLBACK）。
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [version, nowIso()],
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        void rollbackErr;
      }
      throw err;
    }
    applied.push(version);
  }

  return { applied, skipped };
}

/**
 * CLI 入口：`npm run db:migrate`。對 config.databaseUrl（部署時設為 Neon **直連**字串，非 -pooler）
 * 套用未套用的 migration。app runtime 才用 pooled（-pooler）字串。
 */
if (require.main === module) {
  void (async (): Promise<void> => {
    const pool = createPool();
    const client = await pool.connect();
    try {
      const result = await runMigrations(client);
      const appliedMsg = result.applied.length > 0 ? result.applied.join(', ') : '(無)';
      const skippedMsg = result.skipped.length > 0 ? result.skipped.join(', ') : '(無)';
      console.log(`[migrate] 本次套用：${appliedMsg}`);
      console.log(`[migrate] 已套用略過：${skippedMsg}`);
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((err) => {
    console.error('[migrate] 失敗：', err);
    process.exit(1);
  });
}
