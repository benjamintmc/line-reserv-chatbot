import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { createPool } from '../index';

/**
 * D-014（資安 H1）：DB 連線 TLS 驗證顯式化。
 * TLS 策略一律由連線字串的 `sslmode` 決定，`createPool` 不再傳任何 `ssl` 選項。
 */

type SslOption = boolean | { rejectUnauthorized?: boolean; checkServerIdentity?: unknown } | undefined;

interface ClientWithParams {
  connectionParameters: { ssl: SslOption };
}

/** 取「pg 實際生效」的 ssl 設定：createPool 的 options 交給 Client 解析（解析結果會覆蓋顯式 ssl）。 */
async function effectiveSsl(connectionString: string): Promise<SslOption> {
  const pool = createPool(connectionString);
  const client = new Client(pool.options) as unknown as ClientWithParams;
  await pool.end();
  return client.connectionParameters.ssl;
}

const VERIFY_FULL = 'postgres://u:p@h.example.invalid/db?sslmode=verify-full';
const NO_SSLMODE = 'postgres://u:p@localhost:5433/db';

describe('D-014 連線 TLS 設定', () => {
  it('[D-014 AC-1] verify-full 連線字串 → 啟用 TLS 且未關閉任何驗證', async () => {
    const ssl = await effectiveSsl(VERIFY_FULL);
    expect(ssl).toBeTruthy();
    if (typeof ssl === 'object' && ssl !== null) {
      expect(ssl.rejectUnauthorized).not.toBe(false);
      expect(ssl.checkServerIdentity).toBeUndefined();
    }
  });

  it('[D-014 AC-2] 無 sslmode（本機 docker）→ 不啟用 TLS，零回歸', async () => {
    const ssl = await effectiveSsl(NO_SSLMODE);
    expect(ssl).toBeFalsy();
  });

  it('[D-014 AC-3] 升級金絲雀：sslmode=require 目前等同 verify-full', async () => {
    // 此條**現在必然通過**，唯一用途是在未來 pg / pg-connection-string 主版本
    // 改採 libpq 語意（`require` = 加密但不驗證）時**轉紅**。
    // 轉紅＝預期中的語意變更，不是缺陷：應先確認 G2「PROD 一律 verify-full」仍被遵守，
    // 再據實調整本條敘述，不得改以放寬驗證的方式讓它變綠。
    const req = await effectiveSsl('postgres://u:p@h.example.invalid/db?sslmode=require');
    const full = await effectiveSsl(VERIFY_FULL);
    expect(req).toEqual(full);
  });

  it('[D-014 AC-4] src/db/index.ts 不含 rejectUnauthorized', () => {
    // 以 __dirname 定位（與其他測試一致）；import.meta 在 commonjs 型別設定下不可用（TS1343）。
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    // 註解說明用語不算違規，只禁真正的設定值寫法。
    expect(src).not.toMatch(/rejectUnauthorized\s*:/);
  });
});
