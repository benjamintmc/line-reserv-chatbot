#!/usr/bin/env node
/**
 * harness 品質關卡的統一入口（`npm run harness:check`）。
 *
 * 存在理由：
 * 1. 直譯器名稱不可攜——本機 `python3` 是 Windows Store app 別名 stub（exit 49、無輸出），
 *    真 Python 要用 `py`；CI 的 Linux runner 則只有 `python3`。逐一嘗試並選出真的能跑的那個。
 * 2. 輸出編碼——設 PYTHONIOENCODING 作為第二道保險（腳本內另有 reconfigure）。
 *
 * 用法：
 *   npm run harness:check              預設（doc_budget 只警告不擋）
 *   npm run harness:check              doc_budget 超標即失敗（--strict 已寫進 package.json
 *                                      的 script，本機與 CI 同一標準；先前本機不帶此旗標，
 *                                      造成「本機全綠、CI 紅」的假綠，2026-09-02 對齊）
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

/** 找出真的能執行的 Python：`py` 的 Store stub 會 exit 49 且無 stdout，故以實際輸出判定。 */
function findPython() {
  for (const cmd of ['py', 'python3', 'python']) {
    const probe = spawnSync(cmd, ['-c', 'print("ok")'], { encoding: 'utf8', shell: false });
    if (probe.status === 0 && (probe.stdout ?? '').trim() === 'ok') return cmd;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error('找不到可用的 Python 直譯器（試過 py / python3 / python）。');
  console.error('Windows 上的 `python3` 可能是 Microsoft Store 的別名 stub，請安裝真 Python 或改用 `py`。');
  process.exit(1);
}

const checks = [
  ['check_ac_coverage.py', []],
  ['check_doc_budget.py', strict ? ['--strict'] : []],
  ['check_board_sync.py', []],
];

let failed = 0;
for (const [script, args] of checks) {
  console.log(`\n── ${script} ${args.join(' ')}`.trimEnd());
  const r = spawnSync(python, [path.join('harness', 'checks', script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) failed++;
}

console.log('');
if (failed > 0) {
  console.log(`✗ harness 關卡有 ${failed} 項未通過`);
  process.exit(1);
}
console.log(`✓ harness 關卡全數通過（直譯器：${python}）`);
