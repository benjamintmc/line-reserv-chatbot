import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from './index';
import { nowIso } from './time';
import type { SchemaMigrationRow } from './schema';

/** migration SQL 檔所在目錄（以本檔位置解析，tsx 執行時為 src/db/migrations）。 */
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export interface MigrationResult {
  /** 本次實際套用的 version 清單（依序）。 */
  applied: string[];
  /** 先前已套用而略過的 version 清單。 */
  skipped: string[];
}

/**
 * migration runner：讀 migrations/*.sql 依檔名序號排序，比對 schema_migrations，
 * 逐檔在**單一交易**內套用尚未套用者，並以應用層 UTC ISO-8601 記錄 applied_at（G11、D-001 §8）。
 * 冪等：重複執行只會略過已套用檔。
 */
export function runMigrations(db: Db): MigrationResult {
  // bootstrapping：確保追蹤表存在（0001_init.sql 亦有 IF NOT EXISTS，兩者皆冪等）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT NOT NULL PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 檔名零填充序號 → 字典序即套用順序。

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Pick<SchemaMigrationRow, 'version'>[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedSet.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // 單檔單交易：DDL 與追蹤紀錄同進退。
    const apply = db.transaction(() => {
      db.exec(sql);
      record.run(version, nowIso());
    });
    apply();
    applied.push(version);
  }

  return { applied, skipped };
}

/** CLI 入口：`npm run db:migrate`。對 config.databasePath 指向的 DB 套用未套用的 migration。 */
if (require.main === module) {
  const db = openDb();
  try {
    const result = runMigrations(db);
    const appliedMsg = result.applied.length > 0 ? result.applied.join(', ') : '(無)';
    const skippedMsg = result.skipped.length > 0 ? result.skipped.join(', ') : '(無)';
    console.log(`[migrate] 本次套用：${appliedMsg}`);
    console.log(`[migrate] 已套用略過：${skippedMsg}`);
  } finally {
    db.close();
  }
}
