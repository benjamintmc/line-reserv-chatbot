// postbuild：把 migration .sql 檔複製到 dist（tsc 只編譯 .ts、不搬 .sql）。
// 解 deployment.md §6 的「容器跑 node dist/index.js 時 .sql 不在 dist」問題（D-007 §6）。
// 跨平台（node fs），不依賴 shell cp。
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'src', 'db', 'migrations');
const dest = join(root, 'dist', 'db', 'migrations');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[postbuild] 已複製 migrations → ${dest}`);
