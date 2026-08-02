import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * [D-004 AC-19] domain 三檔（create-flow / event-service / event-formatter）
 * 不得下 SQL、不得 import @line/bot-sdk（G5）。以原始碼靜態掃描實作。
 */
describe('D-004 domain 不下 SQL、不觸 LINE（G5 / AC-19）', () => {
  const files = ['create-flow.ts', 'event-service.ts', 'event-formatter.ts'];

  it('[D-004 AC-19] 三檔內無 SQL 字串、無 db.prepare/db.transaction、無 @line/bot-sdk import', () => {
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, `${f} 不應含 SQL SELECT`).not.toMatch(/\bSELECT\b\s+.*\bFROM\b/i);
      expect(src, `${f} 不應含 INSERT/UPDATE/DELETE`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
      );
      expect(src, `${f} 不應直接呼叫 db.prepare`).not.toMatch(/\bdb\.prepare\b/);
      expect(src, `${f} 不應直接呼叫 db.transaction`).not.toMatch(/\bdb\.transaction\b/);
      expect(src, `${f} 不應 import @line/bot-sdk`).not.toMatch(/@line\/bot-sdk/);
    }
  });
});
