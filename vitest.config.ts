import { defineConfig } from 'vitest/config';

// 測試只掃 src 下的原始碼；明確排除編譯輸出 dist，
// 避免 build 後 dist 內的 .test.js 被重複收集（CommonJS 輸出無法被 vitest require）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
