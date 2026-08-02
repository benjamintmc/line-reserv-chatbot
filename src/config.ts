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
  /** 跨試/除錯用：設 DEBUG_WEBHOOK=1 時於 log 印出每個 webhook 事件的 source（groupId/userId）與文字，方便手動取得 groupId 以 seed 活動。生產請關閉。 */
  debugWebhook: (process.env.DEBUG_WEBHOOK ?? '') === '1',
} as const;

/** 缺少 LINE 憑證時回傳缺項清單，供啟動時警告。 */
export function missingLineCredentials(): string[] {
  const missing: string[] = [];
  if (!config.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}
