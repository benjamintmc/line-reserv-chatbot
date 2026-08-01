import { defineConfig } from 'vitest/config';

// 測試只掃 src 下的原始碼；明確排除編譯輸出 dist，
// 避免 build 後 dist 內的 .test.js 被重複收集（CommonJS 輸出無法被 vitest require）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // 於 config.ts 等 src 模組 import 前設定測試用環境變數（DATABASE_URL_TEST / LINE_CHANNEL_SECRET）。
    setupFiles: ['./test/setup-env.ts'],
    // 關閉檔案層平行（D-007 PG-only）：測試共用同一個 docker postgres，各檔 beforeEach 以 TRUNCATE
    // 回到乾淨狀態；序列執行避免跨檔資料互相污染與連線爭用，跨環境（Windows/CI）穩定。
    fileParallelism: false,
  },
});
