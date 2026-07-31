import { buildServer } from './server';
import { config, missingLineCredentials } from './config';

const app = buildServer();

const missing = missingLineCredentials();
if (missing.length > 0) {
  app.log.warn(
    `尚未設定 ${missing.join(', ')}，webhook 驗簽與回覆將失敗。請在 .env 填入憑證。`,
  );
}

// D-006 §6：super-admin 空時顯性警告（比照 missingLineCredentials）。無 super-admin →
// 建立者落跑/亂開時，卡住的活動將無法跨群救援（除 DB 手術）。
if (config.adminUserIds.length === 0) {
  app.log.warn(
    '未設定 ADMIN_USER_IDS（super-admin），卡住的活動將無法救援（除 DB 手術）。開團與 close/cancel 由開團的人自理。',
  );
}

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => {
    app.log.info(`golf-reserv-chatbot 已啟動：${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
