import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D-006 靜態審查 Acceptance Checks：
 * [D-006 AC-13] 零 schema / 零 migration / 零新指令；無 group_admins/group_settings 表。
 * [D-006 AC-14] domain（event-service / event-formatter）不下 SQL、不觸 LINE、禁 any。
 * [D-006 AC-15] super-admin 注入、domain（event-service）不讀 process.env。
 */

const SRC = join(__dirname, '..');

describe('D-006 靜態審查（G3 / G4 / G5）', () => {
  it('[D-006 AC-13] 零 migration：D-006 本身未新增 migration（清單僅隨他案增長）', () => {
    // 本 AC 驗的是「D-006 沒有帶 migration」。清單隨後續已 APPROVED 的他案增長：
    // 0003 = D-008 T-014、0004 = D-013 T-022（conversation 複合 PK）、0005 = D-018 T-029（groups 觀測表）。
    const files = readdirSync(join(SRC, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toEqual([
      '0001_init.sql',
      '0002_billing_modes.sql',
      '0003_merge_event_datetime.sql',
      '0004_conversation_scope_pk.sql',
      '0005_groups.sql',
      '0006_multi_event_per_group.sql', // D-021 T-033a（解除同群單場限制 + message_event_map）
    ]);
  });

  it('[D-006 AC-13] 零新指令：ParsedCommand 無 group_admins/管理人 類新成員（my_id 沿用既有）', () => {
    const types = readFileSync(join(SRC, 'commands', 'types.ts'), 'utf8');
    expect(types).not.toMatch(/group_admin|manage_admin|claim_admin|我是管理人|管理人設定/);
    // my_id 仍存在（既有，非新增）。
    expect(types).toMatch(/type:\s*'my_id'/);
  });

  it('[D-006 AC-13] 無 group_admins / group_settings 資料表（全 src 掃描）', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.name === '__tests__') continue; // 略過測試目錄（本檢查針對正式碼）
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.test.ts')) continue; // 略過測試檔（其字面含表名字串）
        else if (e.name.endsWith('.ts') || e.name.endsWith('.sql')) out.push(p);
      }
      return out;
    };
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} 不應含 group_admins 表`).not.toMatch(/\bgroup_admins\b/);
      expect(src, `${f} 不應含 group_settings 表`).not.toMatch(/\bgroup_settings\b/);
    }
  });

  it('[D-006 AC-14] event-service / event-formatter 無 SQL、無 db.prepare/transaction、無 @line/bot-sdk、無 any', () => {
    for (const f of ['event-service.ts', 'event-formatter.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, `${f} 不應含 SQL SELECT`).not.toMatch(/\bSELECT\b\s+.*\bFROM\b/i);
      expect(src, `${f} 不應含 INSERT/UPDATE/DELETE`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
      );
      expect(src, `${f} 不應直接呼叫 db.prepare`).not.toMatch(/\bdb\.prepare\b/);
      expect(src, `${f} 不應直接呼叫 db.transaction`).not.toMatch(/\bdb\.transaction\b/);
      expect(src, `${f} 不應 import @line/bot-sdk`).not.toMatch(/@line\/bot-sdk/);
      expect(src, `${f} 不應使用 any 型別標註`).not.toMatch(/:\s*any\b|<any>|as\s+any\b/);
    }
  });

  it('[D-006 AC-15] event-service 不讀 process.env（super-admin 經注入）', () => {
    const src = readFileSync(join(__dirname, 'event-service.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).toMatch(/superAdminUserIds/); // 經 DI 注入
  });
});
