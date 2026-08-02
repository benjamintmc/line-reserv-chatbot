import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { config } from '../config';

export type { Pool, PoolClient };

/**
 * 可執行查詢的連線 handle：`Pool`（自動借還一次連線，適合單筆唯讀）或
 * `PoolClient`（交易期間 checkout 的固定連線，交易內所有查詢須綁同一個，G1/G4）。
 * repository 建構子接此型別（取代 better-sqlite3 的 `Db`）。
 */
export type Queryable = Pool | PoolClient;

/**
 * 連線工廠：建立 `pg.Pool`（D-007 §5）。
 *
 * - `max: 2`（G4）：Cloud Run 可能起多實例，每實例小 pool + Neon PgBouncer 兩層防連線爆量。
 * - `ssl`：連線字串含 `sslmode=require`（Neon pooled）時啟用 TLS；本機 docker postgres 無此參數 → 不啟用。
 *   Neon 憑證由平台簽發，MVP 以 `rejectUnauthorized:false` 相容（不驗 CA 鏈，僅加密傳輸）。
 *
 * 連線字串走環境變數（`config.databaseUrl` = `DATABASE_URL`），不寫死、不進版控（G6）。
 * app runtime 用 pooled（-pooler）字串；migrate 走直連（見 migrate.ts / runbook）。
 */
export function createPool(connectionString: string = config.databaseUrl): Pool {
  const requireSsl = /[?&]sslmode=require/.test(connectionString);
  return new Pool({
    connectionString,
    max: 2,
    ssl: requireSsl ? { rejectUnauthorized: false } : undefined,
  });
}

export { nowIso } from './time';
