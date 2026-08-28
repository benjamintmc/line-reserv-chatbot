import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedEvent, type TestDb } from './test-db';

/**
 * D-018 §1.5：`docs/metrics.md` 內的指標 SQL 逐段對真 PG 實跑。
 *
 * 這份文件是 PM 直接複製去 Neon 執行的東西，沒有任何程式路徑會用到它 ⇒ 欄位改名、
 * 資料表演進都不會讓它變紅，只會在需要看數字的那天才發現壞掉。此測試把它綁回 schema。
 */

const METRICS_DOC = join(__dirname, '..', '..', '..', 'docs', 'metrics.md');

/** 抽出所有 ```sql 圍籬區塊。 */
function metricQueries(): string[] {
  const md = readFileSync(METRICS_DOC, 'utf8');
  const out: string[] = [];
  const re = /```sql\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

describe('D-018 指標 SQL', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-018 AC-9] docs/metrics.md 的五段 SQL 皆可執行且各回傳單列', async () => {
    const queries = metricQueries();
    // 文件被裁掉或圍籬寫壞時先紅，而不是「跑了 0 段」假綠。
    expect(queries).toHaveLength(5);

    // 給一點資料，確保聚合走過非空路徑（空表也應回單列，下一個案例驗）。
    const { host, event } = await seedEvent(t, { capacity: 4, groupId: 'G-a' });
    await t.registrations.insertSlot({
      eventId: event.id,
      ownerUserId: host.id,
      displayName: '主辦人',
      kind: 'self',
      status: 'confirmed',
    });
    await t.groups.recordSeen('G-a', 'message');
    await t.groups.recordSeen('G-b', 'join');

    for (const sql of queries) {
      // 第五段帶 $1（我的 LINE userId）；其餘無參數。
      const params = sql.includes('$1') ? ['U-me'] : [];
      const res = await t.pool.query(sql, params);
      expect(res.rows).toHaveLength(1);
    }
  });

  it('[D-018 AC-9] 空資料庫下五段 SQL 仍各回傳單列（不得因除以零而爆）', async () => {
    for (const sql of metricQueries()) {
      const params = sql.includes('$1') ? ['U-me'] : [];
      const res = await t.pool.query(sql, params);
      expect(res.rows).toHaveLength(1);
    }
  });
});
