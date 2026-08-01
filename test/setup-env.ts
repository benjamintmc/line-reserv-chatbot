// vitest setupFiles：於任何 src 模組（含 config.ts）被 import 前設定測試用環境變數預設值。
// 本機測試用、非真 secret；prod 一律走真環境變數（見 .env.example）。
process.env.DATABASE_URL_TEST ??= 'postgres://golf:golf@localhost:5433/golf_test';
// webhook 驗簽測試（AC-4）需非空 channelSecret；config.channelSecret 讀此值。
process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
