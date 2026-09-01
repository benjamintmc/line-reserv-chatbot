/**
 * scripts/seed-open-event.ts
 *
 * 跨試輔助：手動建立一場 status='open' 的活動，讓報名核心（+N/-N/名單）能在真實 LINE 群組上跨試。
 * D-007（PG-only）：對 DATABASE_URL 指向的 Postgres 執行（app runtime 用 pooled；此腳本可用直連或 pooled）。
 *
 * 用法（PowerShell）：
 *   $env:DATABASE_URL='postgres://...'; $env:GROUP_ID='Cxxxxxxxx...'; $env:HOST_LINE_USER_ID='Uxxxxxxxx...'; npm run db:seed
 *
 * 環境變數：
 *   DATABASE_URL       （必填）Postgres 連線字串（走 env、不進版控）。
 *   GROUP_ID           （必填）真實 LINE 群組 ID；先開 DEBUG_WEBHOOK=1 跑 server，於群組發一則訊息後從 log 取得。
 *   HOST_LINE_USER_ID  （選填）主辦人的 LINE userId；供「主辦跨 owner 代取消」路徑跨試。省略則以 GROUP_ID 衍生一個佔位 host。
 *   HOST_DISPLAY_NAME  （選填，預設「主辦人」）
 *   EVENT_DATE         （選填，預設 2026-08-15）
 *   EVENT_TIME         （選填，預設 07:30）
 *   EVENT_LOCATION     （選填，預設 東方球場）
 *   EVENT_CAPACITY     （選填，預設 16）
 *   EVENT_PRICE        （選填，預設 2200）
 *
 * 安全：若該群組已有 active 活動（draft/open/closed），本腳本不重複建立，直接印出既有活動並結束
 * （避免觸發 ux_events_active_group 唯一約束）。要重新來過請將該活動狀態改為 cancelled 後再跑本腳本。
 */
import { createPool } from '../src/db';
import { runMigrations } from '../src/db/migrate';
import { UserRepository } from '../src/db/repositories/user-repository';
import { EventRepository } from '../src/db/repositories/event-repository';
import { taipeiToUtcIso } from '../src/db/time';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(
      `缺少必填環境變數 ${name}。先以 DEBUG_WEBHOOK=1 啟動 server，於群組發訊後從 log 取得 groupId。`,
    );
  }
  return v.trim();
}

async function main(): Promise<void> {
  requireEnv('DATABASE_URL');
  const groupId = requireEnv('GROUP_ID');
  const hostLineUserId = (process.env.HOST_LINE_USER_ID ?? `seed-host:${groupId}`).trim();
  const hostDisplayName = (process.env.HOST_DISPLAY_NAME ?? '主辦人').trim();
  const eventDate = (process.env.EVENT_DATE ?? '2026-08-15').trim();
  const eventTime = (process.env.EVENT_TIME ?? '07:30').trim();
  const location = (process.env.EVENT_LOCATION ?? '東方球場').trim();
  const capacity = Number(process.env.EVENT_CAPACITY ?? '16');
  const pricePerPerson = Number(process.env.EVENT_PRICE ?? '2200');

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`EVENT_CAPACITY 必須為正整數，收到：${process.env.EVENT_CAPACITY}`);
  }
  if (!Number.isInteger(pricePerPerson) || pricePerPerson < 0) {
    throw new Error(`EVENT_PRICE 必須為非負整數，收到：${process.env.EVENT_PRICE}`);
  }

  const pool = createPool();
  try {
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }

    const users = new UserRepository(pool);
    const events = new EventRepository(pool);

    const existing = await events.findActiveByGroup(groupId);
    if (existing !== undefined) {
      console.log('⚠️  此群組已有 active 活動，未重複建立。既有活動：');
      console.log(JSON.stringify(existing, null, 2));
      console.log(
        '\n若要重來：將該活動狀態改為 cancelled 後再跑本腳本。',
      );
      return;
    }

    const host = await users.upsert(hostLineUserId, hostDisplayName);
    const event = await events.create({
      groupId,
      hostUserId: host.id,
      // D-008 §3：events.event_datetime 存 UTC ISO-8601，由台灣本地日期＋時間合併轉換。
      eventDatetime: taipeiToUtcIso(eventDate, eventTime),
      location,
      capacity,
      pricePerPerson,
      status: 'open',
    });

    console.log('✅ 已建立 open 活動，可於群組開始跨試 +N / -N / 名單：');
    console.log(JSON.stringify(event, null, 2));
    console.log(`\n主辦人 user：id=${host.id}, line_user_id=${host.line_user_id}`);
    if (!process.env.HOST_LINE_USER_ID) {
      console.log(
        '（未指定 HOST_LINE_USER_ID，以佔位 host 建立；「主辦跨 owner 代取消」跨試需重跑並帶入你的真實 userId。）',
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
