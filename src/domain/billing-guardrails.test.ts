import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * [D-005 AC-16] 守則回歸靜態審查（G3/G5/G6）：
 *  - billing.ts / formatter / create-flow / event-service 無 any、無 SQL 字串、無 @line/bot-sdk。
 *  - registration-service.ts / roster.ts 與計費零耦合（不 import billing、不引用計費欄位）——報名核心不動。
 *  - 主辦自動登記經 insertSlot（非裸 INSERT INTO registrations）。
 */
describe('D-005 計費守則靜態審查（AC-16）', () => {
  const dir = __dirname;
  const src = (f: string): string => readFileSync(join(dir, f), 'utf8');

  const codeFiles = [
    'billing.ts',
    'list-formatter.ts',
    'event-formatter.ts',
    'create-flow.ts',
    'event-service.ts',
  ];

  it('[D-005 AC-16] 新增/改動檔無 any、無 SQL、無 @line/bot-sdk import', () => {
    for (const f of codeFiles) {
      const s = src(f);
      expect(s, `${f} 不應含 : any / as any / <any>`).not.toMatch(/(:\s*any\b|as\s+any\b|<any>|\bany\[\]|Array<any>)/);
      expect(s, `${f} 不應含 SQL SELECT`).not.toMatch(/\bSELECT\b\s+.*\bFROM\b/i);
      expect(s, `${f} 不應含 INSERT/UPDATE/DELETE`).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
      expect(s, `${f} 不應直接呼叫 db.prepare`).not.toMatch(/\bdb\.prepare\b/);
      expect(s, `${f} 不應 import @line/bot-sdk`).not.toMatch(/@line\/bot-sdk/);
    }
  });

  it('[D-005 AC-16] registration-service.ts / roster.ts 與計費零耦合（報名核心不動，G5）', () => {
    for (const f of ['registration-service.ts', 'roster.ts']) {
      const s = src(f);
      expect(s, `${f} 不應 import billing`).not.toMatch(/from\s+['"]\.\/billing['"]/);
      expect(s, `${f} 不應引用 price_mode`).not.toMatch(/price_mode/);
      expect(s, `${f} 不應引用 venue_fee`).not.toMatch(/venue_fee/);
      expect(s, `${f} 不應引用 settled_per_person`).not.toMatch(/settled_per_person/);
    }
  });

  it('[D-005 AC-16] 主辦自動登記走 insertSlot（非裸 INSERT INTO registrations，G3）', () => {
    const s = src('event-service.ts');
    expect(s).toMatch(/this\.registrations\.insertSlot\(/);
    expect(s).not.toMatch(/INSERT\s+INTO\s+registrations/i);
  });
});
