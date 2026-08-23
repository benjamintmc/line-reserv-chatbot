import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * D-015 AC-15 的守門測試。
 *
 * AC-15 的交付物是「四道機器關卡全綠，且輸出貼於審查包」——這本身無法由某段程式碼斷言，
 * 但可以守住「審查包確實存在且四關輸出俱全」，避免日後 RP 被改瘦、reviewer 讀不到證據。
 * 同 D-013 AC-8/AC-9 的文件驗收作法（src/__tests__/d013-docs.test.ts）。
 */
const ROOT = join(__dirname, '..', '..');
const RP = join(ROOT, 'docs', 'reviews', 'RP-T-026.md');

describe('D-015 機器關卡與審查包', () => {
  it('[D-015 AC-15] 審查包存在且四關輸出俱全', () => {
    expect(existsSync(RP)).toBe(true);
    const rp = readFileSync(RP, 'utf8');
    for (const gate of [
      'npm run lint',
      'npm run build',
      'npm test',
      'npm run harness:check',
    ]) {
      expect(rp, `審查包缺 ${gate} 的輸出`).toContain(gate);
    }
    // AC 覆蓋結果必須是實際數字（check_ac_coverage 的輸出格式）。
    expect(rp).toMatch(/AC 覆蓋：\d+\/\d+/);
  });

  it('[D-015 AC-15] 審查包含 G1–G9 逐條自評', () => {
    const rp = readFileSync(RP, 'utf8');
    for (let i = 1; i <= 9; i += 1) {
      expect(rp, `審查包缺 G${i} 自評`).toContain(`G${i}`);
    }
  });

  it('[D-015 AC-15] 審查包含 AC-1..AC-15 對照', () => {
    const rp = readFileSync(RP, 'utf8');
    for (let i = 1; i <= 15; i += 1) {
      expect(rp, `審查包缺 AC-${i} 對照`).toContain(`AC-${i}`);
    }
  });
});
