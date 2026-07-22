import { buildServer } from './server';
import { config, missingLineCredentials } from './config';

const app = buildServer();

const missing = missingLineCredentials();
if (missing.length > 0) {
  app.log.warn(
    `尚未設定 ${missing.join(', ')}，webhook 驗簽與回覆將失敗。請在 .env 填入憑證。`,
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
