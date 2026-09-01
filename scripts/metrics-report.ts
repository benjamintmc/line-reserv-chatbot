/**
 * 成長指標 dashboard 產生器（本機用，不部署）。
 *
 *   npm run metrics                      # 用 .env 的 DATABASE_URL 與 ADMIN_USER_IDS
 *   npm run metrics -- --open            # 產生後直接用預設瀏覽器打開
 *   npm run metrics -- --me=U1234…       # 覆寫「我的」LINE userId（第五項指標需要）
 *   npm run metrics -- --out=foo.html
 *
 * **SQL 一律讀自 `docs/metrics.md`**，本檔不自帶任何查詢——文件即唯一真相，
 * 且該檔的每段 SQL 都已被 `src/db/__tests__/metrics-sql.test.ts` 對真 PG 跑過（D-018 AC-9）。
 *
 * 產出的 HTML 含營運數字，已列入 .gitignore；**不得**把連線字串寫進輸出（內含密碼）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import 'dotenv/config';
import { buildModel, renderHtml } from '../src/metrics/report';

const ROOT = join(__dirname, '..');
const METRICS_DOC = join(ROOT, 'docs', 'metrics.md');

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const hasFlag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

/** 抽出 docs/metrics.md 的所有 SQL 圍籬區塊（與 AC-9 測試同一支 regex）。 */
function metricQueries(): string[] {
  const md = readFileSync(METRICS_DOC, 'utf8');
  const out: string[] = [];
  const re = /```sql\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // capture group 1 於本 regex 必然存在；noUncheckedIndexedAccess 下顯式收窄，不用非空斷言。
  while ((m = re.exec(md)) !== null) {
    const body = m[1];
    if (body !== undefined) out.push(body.trim());
  }
  return out;
}

/** 只取 host/db 作為來源標示——連線字串含密碼，絕不落進輸出檔。 */
function describeSource(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(無法解析的連線字串)';
  }
}

async function main(): Promise<void> {
  const databaseUrl = arg('url') ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('缺少 DATABASE_URL（可用 .env、環境變數，或 --url=<連線字串>）。');
    process.exit(1);
  }

  // 第五項指標的 $1。ADMIN_USER_IDS 逗號分隔，取第一個當「我」。
  const selfId = arg('me') ?? (process.env.ADMIN_USER_IDS ?? '').split(',')[0]?.trim();
  const selfLineUserIdProvided = selfId !== undefined && selfId !== '';

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const values: Record<string, unknown> = {};
  try {
    const queries = metricQueries();
    if (queries.length === 0) throw new Error(`${METRICS_DOC} 找不到任何 SQL 區塊`);

    for (const sql of queries) {
      // 帶 $1 的查詢需要「我的」userId；沒有就跳過，由 buildModel 標成算不出來
      // （硬跑會把所有群組都算成「非我建立」而灌水）。
      if (sql.includes('$1') && !selfLineUserIdProvided) continue;
      const res = await pool.query(sql, sql.includes('$1') ? [selfId] : []);
      Object.assign(values, res.rows[0] ?? {});
    }
  } finally {
    await pool.end();
  }

  const model = buildModel(values, { selfLineUserIdProvided });
  const html = renderHtml(model, {
    generatedAt: new Intl.DateTimeFormat('zh-TW', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Taipei',
    }).format(new Date()),
    source: describeSource(databaseUrl),
  });

  const out = join(ROOT, arg('out') ?? 'metrics-report.html');
  writeFileSync(out, html, 'utf8');
  console.log(`已產生：${out}`);
  if (!selfLineUserIdProvided) {
    console.log('提醒：未提供 LINE userId，「擴散群組」一項顯示為算不出來（見 --me）。');
  }

  if (hasFlag('open')) {
    // Windows 的 start 是 shell 內建指令，需經 cmd；mac/linux 各有自己的開檔器。
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', out]]
        : process.platform === 'darwin'
          ? ['open', [out]]
          : ['xdg-open', [out]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

main().catch((err: unknown) => {
  console.error('產生指標報表失敗：', err);
  process.exit(1);
});
