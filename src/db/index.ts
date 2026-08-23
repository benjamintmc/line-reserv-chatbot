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
 * 連線工廠：建立 `pg.Pool`（D-007 §5、D-014）。
 *
 * - `max: 2`（G4）：Cloud Run 可能起多實例，每實例小 pool + Neon PgBouncer 兩層防連線爆量。
 * - **TLS 策略完全交由連線字串的 `sslmode` 決定**（D-014 G1/G2）：PROD 與 migrate 一律
 *   `sslmode=verify-full`（驗憑證鏈 + 驗 hostname），這是唯一在 pg 現行語意與未來 libpq
 *   語意下意義相同的值；本機 docker postgres 連線字串無 `sslmode` → 不啟用 TLS。
 *   **不得**在此傳入任何 `ssl` 選項——舊版曾傳入「關閉憑證驗證」的選項，該設定實為死碼
 *   （`pg` 以連線字串解析結果覆蓋顯式 `ssl`），卻會誤導日後 reviewer 以為「不驗證」是本意。
 *   升級攔截見 `__tests__/pool-ssl.test.ts` 的金絲雀測試。
 *
 * 連線字串走環境變數（`config.databaseUrl` = `DATABASE_URL`），不寫死、不進版控（G6）。
 * app runtime 用 pooled（-pooler）字串；migrate 走直連（見 migrate.ts / runbook）。
 */
export function createPool(connectionString: string = config.databaseUrl): Pool {
  return new Pool({ connectionString, max: 2 });
}

export { nowIso } from './time';
