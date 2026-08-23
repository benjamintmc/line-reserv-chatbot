import { describe, it, expect } from 'vitest';
import { parseCommand } from '../index';
import { validateLocation } from '../validators';
import { MAX_LOCATION_LEN } from '../types';
import { applyAnswer } from '../../domain/create-flow';
import { formatAlreadyClosed, formatNoActiveEvent } from '../../domain/event-formatter';
import { formatNoOpenEvent } from '../../domain/list-formatter';

/** D-017：文案與驗證一致性收斂。 */

const LONG = 'x'.repeat(MAX_LOCATION_LEN + 1);
const OK = 'x'.repeat(MAX_LOCATION_LEN);

describe('D-017 場地名稱上限三路徑一致', () => {
  it('[D-017 AC-1] validateLocation：空、超長皆拒；上限值本身放行；保留內部空白', () => {
    expect(validateLocation('').ok).toBe(false);
    expect(validateLocation('   ').ok).toBe(false);
    expect(validateLocation(LONG).ok).toBe(false);
    const r = validateLocation('  東方 A 場  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('東方 A 場'); // 只去頭尾
    expect(validateLocation(OK).ok).toBe(true);
  });

  it('[D-017 AC-2] 一行式開團：超長地點被拒（先前完全無上限，可建出事後不可編輯的活動）', () => {
    const bad = parseCommand(`開團 2026/09/01 08:00 ${LONG} 12 每人1200`);
    expect(bad.type).toBe('invalid');
    if (bad.type === 'invalid') expect(bad.reason).toBe('bad_location');

    const good = parseCommand(`開團 2026/09/01 08:00 ${OK} 12 每人1200`);
    expect(good.type).toBe('create_event_oneline');
  });

  it('[D-017 AC-3] 逐步問答：超長地點停留同一步重問，不寫入 draft', () => {
    const bad = applyAnswer('awaiting_location', {}, LONG);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.state).toBe('awaiting_location');

    const good = applyAnswer('awaiting_location', {}, `  ${OK}  `);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.payload.location).toBe(OK); // 已 trim
  });

  it('[D-017 AC-4] 編輯 場地：超長仍回 bad_location 並帶實際字數；空值仍是 edit_help', () => {
    const bad = parseCommand(`編輯 場地 ${LONG}`);
    expect(bad.type).toBe('invalid');
    if (bad.type === 'invalid') {
      expect(bad.reason).toBe('bad_location');
      expect(bad.detail?.len).toBe(MAX_LOCATION_LEN + 1);
    }
    expect(parseCommand('編輯 場地').type).toBe('edit_help');
  });
});

describe('D-017 回歸關卡', () => {
  it('[D-017 AC-9] 四條關卡指令俱在（lint/build/test/harness:check）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const s of ['lint', 'build', 'test', 'harness:check']) {
      expect(pkg.scripts[s], `package.json 缺少 script: ${s}`).toBeTruthy();
    }
  });
});

describe('D-017 同一狀態的說法收斂', () => {
  it('[D-017 AC-5] closed 狀態一律說「報名已截止」，不再出現「已關閉報名」', () => {
    expect(formatAlreadyClosed().text).toContain('報名已截止');
    expect(formatAlreadyClosed().text).not.toContain('已關閉報名');
  });

  it('[D-017 AC-6] 兩句「沒有活動」維持刻意分工，但句式一致（皆以句號結尾）', () => {
    // 管理類指令用 formatNoActiveEvent，報名類用 formatNoOpenEvent——語意不同，不合併。
    expect(formatNoActiveEvent().text).toBe('目前沒有進行中的活動。');
    expect(formatNoOpenEvent().text).toBe('目前沒有開放報名的活動。');
    expect(formatNoActiveEvent().text).not.toBe(formatNoOpenEvent().text);
  });
});
