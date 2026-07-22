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
} as const;

/** 缺少 LINE 憑證時回傳缺項清單，供啟動時警告。 */
export function missingLineCredentials(): string[] {
  const missing: string[] = [];
  if (!config.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}
