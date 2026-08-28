import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedEvent, type TestDb } from './test-db';

/**
 * D-018 §1.1：migration 0005 的 backfill 段——把「曾出現過活動的群組」補進 groups。
 *
 * 為何要單獨測：runner 在測試 DB 首次 migrate 時 events 是空的，backfill 影響 0 列，
 * 一般測試路徑**永遠碰不到這段 SQL**。此處直接抽出該段對有資料的 DB 實跑，
 * 否則等於上線那天才第一次執行（PROD 已有既有群組，這是唯一一次機會）。
 */

const MIGRATION = join(__dirname, '..', 'migrations', '0005_groups.sql');

/** 自 0005 抽出 backfill 的 INSERT…SELECT 段（`CREATE` 已由 runner 套用，重跑會撞既有表）。 */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const idx = sql.indexOf('INSERT INTO groups');
  expect(idx).toBeGreaterThan(-1); // 檔案結構若改變，這裡先紅，而不是靜默測到空字串。
  return sql.slice(idx);
}

describe('D-018 migration 0005 backfill', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-018 AC-7] 每個曾出現過的 group_id 都補一列；重跑不重複插入', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G-a', hostLineId: 'U-1' });
    await seedEvent(t, { capacity: 4, groupId: 'G-b', hostLineId: 'U-2' });
    // 同群第二場（先把第一場移出 active 集合，避開 ux_events_active_group）。
    await t.pool.query("UPDATE events SET status = 'done' WHERE group_id = 'G-a'");
    await seedEvent(t, { capacity: 4, groupId: 'G-a', hostLineId: 'U-1' });

    const sql = backfillSql();
    await t.pool.query(sql);

    const rows = await t.pool.query<{ group_id: string; discovered_via: string; joined_at: string }>(
      'SELECT group_id, discovered_via, joined_at FROM groups ORDER BY group_id',
    );
    expect(rows.rows.map((r) => r.group_id)).toEqual(['G-a', 'G-b']);
    expect(rows.rows.every((r) => r.discovered_via === 'backfill')).toBe(true);

    // joined_at 取該群**最早**一場活動的建立時間（下限估計，見 docs/metrics.md 限制 1）。
    const earliest = await t.pool.query<{ m: string }>(
      "SELECT MIN(created_at) AS m FROM events WHERE group_id = 'G-a'",
    );
    expect(rows.rows[0].joined_at).toBe(earliest.rows[0].m);

    // 冪等：ON CONFLICT DO NOTHING ⇒ 重跑不報錯、不長列數。
    await t.pool.query(sql);
    const again = await t.pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM groups');
    expect(again.rows[0].n).toBe(2);
  });

  it('[D-018 AC-7] backfill 不覆蓋已由 join/message 建立的列', async () => {
    await seedEvent(t, { capacity: 4, groupId: 'G-a', hostLineId: 'U-1' });
    await t.groups.recordJoin('G-a'); // 該群已有精確的加入紀錄。

    await t.pool.query(backfillSql());

    const row = await t.groups.get('G-a');
    // 精確來源優先：不得被時間較不準的 backfill 蓋掉。
    expect(row?.discovered_via).toBe('join');
  });
});
