import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * D-013 AC-8 / AC-9 的文件驗收。
 * 這兩條的交付物是文件而非程式碼，但仍需可重跑的守門——否則日後改動會靜默漂移
 * （尤其 AC-9「權威文件不得並存矛盾敘述」正是為了防止 D-004/D-011 續留已被取代的敘述）。
 */
const ROOT = join(__dirname, '..', '..');

function doc(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

describe('D-013 文件驗收', () => {
  it('[D-013 AC-8] deployment-runbook 的 0004 段落含單階段上線四要素', () => {
    const rb = doc('docs', 'deployment-runbook.md');
    expect(rb).toContain('0004_conversation_scope_pk');
    // ① 直連執行 → 立即部署新 revision（單階段，裁決 #1）
    expect(rb).toContain('立即');
    expect(rb).toMatch(/直連/);
    // ② 窗口內失效指令清單（皆走 upsert；get/delete 不受影響）
    for (const cmd of ['開團', '一行式', '分組', '下一輪']) expect(rb).toContain(cmd);
    // ③ lock_timeout 逾時 → 整檔 ROLLBACK、稍後重跑
    expect(rb).toContain('lock_timeout');
    expect(rb).toContain('ROLLBACK');
    // ④ 退版警語：反向 migration 需人工取捨 ⇒ 退版即有資料損失
    expect(rb).toContain('退版即有資料損失');
  });

  it('[D-013 AC-9] D-004 / D-011 已補 errata，標註被 D-013 取代之敘述', () => {
    const d004 = doc('design', 'D-004-event-creation.md');
    expect(d004).toContain('D-013');
    expect(d004).toMatch(/errata（2026-08-19[^\n]*D-013/);
    expect(d004).toContain('第 5 條');
    expect(d004).toContain('第 6 條');

    const d011 = doc('design', 'D-011-grouping.md');
    expect(d011).toContain('D-013');
    expect(d011).toContain('(group_id, line_user_id)');
    // AC-9 最容易漂移的是「互斥範圍縮為同群」這句語意——只鎖鍵字串會讓它被悄悄刪掉
    // 而測試仍綠（design-reviewer nit-3）。
    expect(d011).toContain('同群');
  });
});
