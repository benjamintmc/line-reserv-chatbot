import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * G10 / AC-16 靜態守門：src/domain/*.ts（非測試）不得出現 SQL 字串或直接存取 db；
 * 一律經 repository 原語。以原始碼靜態掃描實作。
 */
describe('domain 層不直接下 SQL（G10 / AC-16）', () => {
  it('[D-003 AC-16] src/domain 內無 SQL 關鍵字、無 db.prepare/db.transaction 直呼', () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, `${f} 不應含 SQL SELECT`).not.toMatch(/\bSELECT\b\s+.*\bFROM\b/i);
      expect(src, `${f} 不應含 INSERT/UPDATE/DELETE INTO`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
      );
      expect(src, `${f} 不應直接呼叫 db.prepare`).not.toMatch(/\bdb\.prepare\b/);
      expect(src, `${f} 不應直接呼叫 db.transaction`).not.toMatch(/\bdb\.transaction\b/);
    }
  });
});
