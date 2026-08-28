/**
 * scripts/backfill-group-names.ts — 一次性維運腳本（D-018 遺留項）
 *
 * migration `0005_groups` 直接以 SQL 建列，未經過應用層的 `getGroupSummary` 取名路徑，
 * 因此回填進來的舊群組 `group_name` 為 NULL，在 dashboard 上只剩一串 `group_id` 無法辨識。
 * 本腳本對每個缺名且仍在群的列各打一次 LINE API 補上名稱。
 *
 * 用法：
 *   npm run db:backfill-names              # 實際寫入
 *   npm run db:backfill-names -- --dry-run # 只查不寫，先看會改哪幾列
 *
 * 環境變數（走 .env，不進版控）：`DATABASE_URL`、`LINE_CHANNEL_ACCESS_TOKEN`。
 *
 * **只補 NULL、只補仍在群的列**，不覆蓋任何既有名稱——名稱是快照，
 * 應用層在該群首見時已寫入的值比本腳本後補的更貼近當時狀態。
 * 單一群組失敗（機器人已被移出、API 暫時異常）只記一行訊息並繼續，不中斷其餘。
 */
import { Pool } from 'pg';
import 'dotenv/config';
import { lineClient } from '../src/line/client';
import { nowIso } from '../src/db/time';

const dryRun = process.argv.slice(2).includes('--dry-run');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    console.error('缺少 DATABASE_URL。');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, max: 1 });
  let filled = 0;
  let failed = 0;
  try {
    const { rows } = await pool.query<{ group_id: string }>(
      'SELECT group_id FROM groups WHERE group_name IS NULL AND left_at IS NULL ORDER BY joined_at',
    );
    console.log(`缺名且仍在群的群組：${rows.length} 個${dryRun ? '（dry-run，不寫入）' : ''}`);

    for (const { group_id: groupId } of rows) {
      const short = `${groupId.slice(0, 12)}…`;
      try {
        const summary = await lineClient.getGroupSummary(groupId);
        if (summary.groupName === '') {
          console.log(`  ${short} → API 回傳空名稱，略過`);
          continue;
        }
        if (!dryRun) {
          await pool.query('UPDATE groups SET group_name = $2, updated_at = $3 WHERE group_id = $1', [
            groupId,
            summary.groupName,
            nowIso(),
          ]);
        }
        filled++;
        console.log(`  ${short} → ${summary.groupName}`);
      } catch (err) {
        // 最常見原因：機器人早已被移出該群，但沒收到 leave 事件（功能上線前發生的）。
        failed++;
        console.log(`  ${short} → 取名失敗，維持空白（${String(err).slice(0, 80)}）`);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`\n完成：${dryRun ? '可補' : '已補'} ${filled} 個，失敗 ${failed} 個。`);
  if (failed > 0) {
    console.log('失敗多半是機器人已不在該群——請確認後手動把該列的 left_at 補上，指標才不會高估觸及數。');
  }
}

main().catch((err: unknown) => {
  console.error('補名失敗：', err);
  process.exit(1);
});
