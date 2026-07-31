import { defineConfig } from 'vitest/config';

// 測試只掃 src 下的原始碼；明確排除編譯輸出 dist，
// 避免 build 後 dist 內的 .test.js 被重複收集（CommonJS 輸出無法被 vitest require）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // 關閉檔案層平行：native better-sqlite3 在多 fork worker 同時冷載入時，
    // Windows 環境會偶發全檔 import 崩潰（`Cannot read properties of undefined (reading 'config')`）。
    // 測試量小（跑約 2s），單序執行以求跨環境穩定、避免 CI 假紅（LESSONS 記錄之反覆 flake）。
    fileParallelism: false,
  },
});
