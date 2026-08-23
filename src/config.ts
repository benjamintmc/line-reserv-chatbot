import 'dotenv/config';

/** 執行期設定，全部來自環境變數（見 .env.example）。 */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  channelSecret: process.env.LINE_CHANNEL_SECRET ?? '',
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  adminUserIds: (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Postgres 連線字串（`DATABASE_URL`）；走環境變數、不進版控（G6）。
   * app runtime 用 Neon pooled（host 含 `-pooler`、`?sslmode=require`）字串；
   * migrate 例外走直連（非 -pooler，見 migrate.ts / 部署 runbook）。
   */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /**
   * 跨試/除錯用：設 DEBUG_WEBHOOK=1 時於 log 印出每個 webhook 事件的 source（groupId/userId）與**訊息全文**，
   * 方便手動取得 groupId 以 seed 活動。
   *
   * **資安 M5 fail-safe**：`NODE_ENV=production` 時**無條件關閉**，即使環境變數被設為 1。
   * 原本的防線只有 `.env.example` 的一句「生產請關閉」註解——那是紀律，不是機制；
   * 一旦有人為了追線上問題臨時打開又忘了關，群組每則訊息全文就會持續寫進 Cloud Logging。
   */
  debugWebhook:
    (process.env.DEBUG_WEBHOOK ?? '') === '1' && process.env.NODE_ENV !== 'production',
} as const;

/** 缺少 LINE 憑證時回傳缺項清單，供啟動時警告。 */
export function missingLineCredentials(): string[] {
  const missing: string[] = [];
  if (!config.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}
