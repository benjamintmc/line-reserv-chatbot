/**
 * 成長指標 dashboard 的**純函式**部分：把查詢結果組成模型、再組成 HTML。
 *
 * 刻意與 DB／檔案 IO 分離（IO 在 `scripts/metrics-report.ts`），使這一層可被 unit test 覆蓋
 * ——會出錯的是「數字對應到哪個指標」與「查無資料時顯示什麼」，不是 SQL（SQL 由 D-018 AC-9 覆蓋）。
 *
 * **不得**在此引入任何 `pg`／`node:fs` 相依，否則測試就得起 DB。
 */

/** 一個指標的靜態定義。`key` 對應 `docs/metrics.md` 查詢回傳的**欄位名**。 */
export interface MetricSpec {
  /** SQL 結果的欄位名（不是區塊順序）——metrics.md 改順序不影響本檔，改欄位名才會。 */
  key: string;
  label: string;
  /** 目標值；null = 這個數字只是脈絡，沒有達成率可言。 */
  target: number | null;
  unit: 'count' | 'percent';
  /** 卡片下方的一句說明。 */
  note?: string;
  /** true = 這是推估值，不是精確數字（會在卡片上明示）。 */
  estimate?: boolean;
}

/** 有目標的五項指標（使用者 2026-08-28 指定）。 */
export const TARGET_METRICS: readonly MetricSpec[] = [
  {
    key: 'real_users',
    label: '實際使用者',
    target: 100,
    unit: 'count',
    note: '有過未取消報名的人；被代報名者不計（沒跟機器人互動過）',
  },
  {
    key: 'events_created',
    label: '辦成的活動',
    target: 30,
    unit: 'count',
    note: '排除開到一半沒完成的草稿',
  },
  {
    key: 'repeat_hosts',
    label: '重複開團主',
    target: 10,
    unit: 'count',
    note: '開過 2 場以上的人',
  },
  {
    key: 'returning_pct',
    label: '回訪率',
    target: 40,
    unit: 'percent',
    note: '參加過 2 場以上不同活動的人佔比',
  },
  {
    key: 'groups_organic_est',
    label: '擴散群組',
    target: 5,
    unit: 'count',
    estimate: true,
    note: '我從未在其中開過團的群；會把「開了第一團後放手的群」誤算進來',
  },
];

/** 沒有目標、但看成長時同樣重要的脈絡數字。 */
export const CONTEXT_METRICS: readonly MetricSpec[] = [
  { key: 'groups_reached', label: '觸及的群組', target: null, unit: 'count' },
  { key: 'groups_activated', label: '其中開過團', target: null, unit: 'count' },
  {
    key: 'groups_dormant',
    label: '加了卻沒用',
    target: null,
    unit: 'count',
    note: '裝了機器人但從未開團——流失的前兆，本次觀測前完全看不到',
  },
];

/** 指標算完之後的呈現模型。 */
export interface Metric extends MetricSpec {
  /** null = 這個指標算不出來（欄位不存在，或缺少必要參數）。 */
  value: number | null;
  /** 達成率百分比（0–100+）；無目標或無值時為 null。 */
  pct: number | null;
  reached: boolean;
  /** value 為 null 時的原因，直接顯示給使用者看。 */
  unavailableReason?: string;
}

export interface BuildOptions {
  /**
   * 未提供自己的 LINE userId 時，第五項指標**不可信**——SQL 的 `$1` 對不到任何人，
   * 會把所有群組都算成「非我建立」而灌水。此時明確標成算不出來，而不是顯示一個錯的數字。
   */
  selfLineUserIdProvided: boolean;
}

/** pg 對 numeric 型別回傳字串（避免精度損失），故一律經此正規化。 */
function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function resolve(spec: MetricSpec, values: Record<string, unknown>, opts: BuildOptions): Metric {
  const base = { ...spec, value: null, pct: null, reached: false } satisfies Metric;

  if (spec.key === 'groups_organic_est' && !opts.selfLineUserIdProvided) {
    return { ...base, unavailableReason: '需要你的 LINE userId（設 ADMIN_USER_IDS 或加 --me=<id>）' };
  }
  if (!(spec.key in values)) {
    // 欄位不存在 ≠ 值為 0：多半代表 docs/metrics.md 的欄位被改名，靜默顯示 0 會讓人以為沒成長。
    return { ...base, unavailableReason: `docs/metrics.md 查詢未回傳 ${spec.key} 欄位` };
  }

  const value = toNumber(values[spec.key]);
  if (value === null) return { ...base, value: 0, pct: spec.target === null ? null : 0 };

  const pct = spec.target === null ? null : Math.round((value / spec.target) * 1000) / 10;
  return { ...spec, value, pct, reached: pct !== null && pct >= 100 };
}

/** 由所有查詢結果合併而成的扁平欄位表 → 呈現模型。 */
export function buildModel(
  values: Record<string, unknown>,
  opts: BuildOptions,
): { targets: Metric[]; context: Metric[] } {
  // 「加了卻沒用」是衍生值，不佔 metrics.md 一個欄位。
  const reached = toNumber(values.groups_reached);
  const activated = toNumber(values.groups_activated);
  const enriched: Record<string, unknown> =
    reached !== null && activated !== null
      ? { ...values, groups_dormant: reached - activated }
      : values;

  return {
    targets: TARGET_METRICS.map((s) => resolve(s, enriched, opts)),
    context: CONTEXT_METRICS.map((s) => resolve(s, enriched, opts)),
  };
}

export function formatValue(m: Metric): string {
  if (m.value === null) return '—';
  return m.unit === 'percent' ? `${m.value}%` : m.value.toLocaleString('zh-TW');
}

function formatTarget(m: Metric): string {
  if (m.target === null) return '';
  return m.unit === 'percent' ? `${m.target}%` : m.target.toLocaleString('zh-TW');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ReportMeta {
  /** 產生時間（已格式化為台灣時間的顯示字串）。 */
  generatedAt: string;
  /** 資料來源標示：**只放 host/db 名，絕不放連線字串**（內含密碼）。 */
  source: string;
}

/** 量表：填色寬度即達成率，超過 100% 截在 100%（數字另外標出真實值）。 */
function meter(m: Metric): string {
  if (m.pct === null) return '';
  const w = Math.max(0, Math.min(100, m.pct));
  return `<div class="meter" role="img" aria-label="達成率 ${m.pct}%"><div class="meter-fill" style="width:${w}%"></div></div>`;
}

function tile(m: Metric, opts: { hero?: boolean } = {}): string {
  const cls = opts.hero === true ? 'card hero' : 'card';
  const badge = m.reached ? '<span class="chip chip-good">✓ 已達標</span>' : '';
  const est = m.estimate === true ? '<span class="chip chip-est">推估值</span>' : '';
  const sub =
    m.value === null
      ? `<p class="unavailable">算不出來：${escapeHtml(m.unavailableReason ?? '')}</p>`
      : m.target === null
        ? ''
        : `<p class="progress">目標 ${formatTarget(m)}　·　達成 ${m.pct ?? 0}%</p>`;
  const note = m.note === undefined ? '' : `<p class="note">${escapeHtml(m.note)}</p>`;

  return `<article class="${cls}">
      <div class="card-head"><h3>${escapeHtml(m.label)}</h3>${badge}${est}</div>
      <p class="value">${formatValue(m)}</p>
      ${meter(m)}
      ${sub}
      ${note}
    </article>`;
}

function tableRow(m: Metric): string {
  return `<tr>
        <th scope="row">${escapeHtml(m.label)}</th>
        <td class="num">${formatValue(m)}</td>
        <td class="num">${m.target === null ? '—' : formatTarget(m)}</td>
        <td class="num">${m.pct === null ? '—' : `${m.pct}%`}</td>
      </tr>`;
}

/**
 * 產生自足的 HTML（無外部資源、無 JS）——直接用瀏覽器開啟即可，不需伺服器。
 * 配色取自 dataviz 參考調色盤的藍色 sequential ramp 與 status good，兩種模式皆通過驗證器。
 */
export function renderHtml(
  model: { targets: Metric[]; context: Metric[] },
  meta: ReportMeta,
): string {
  const allRows = [...model.targets, ...model.context].map(tableRow).join('\n');
  const [hero, ...rest] = model.targets;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>約球 Chatbot 成長指標</title>
<style>
  :root {
    color-scheme: light;
    --plane: #f9f9f7;
    --surface: #fcfcfb;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --hairline: #e1e0d9;
    --ring: rgba(11, 11, 11, 0.10);
    --accent: #2a78d6;
    --track: #cde2fb;
    --good: #0ca30c;
    --good-ink: #006300;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --plane: #0d0d0d;
      --surface: #1a1a19;
      --ink: #ffffff;
      --ink-2: #c3c2b7;
      --muted: #898781;
      --hairline: #2c2c2a;
      --ring: rgba(255, 255, 255, 0.10);
      --accent: #3987e5;
      --track: #184f95;
      --good: #0ca30c;
      --good-ink: #0ca30c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 64px;
    background: var(--plane);
    color: var(--ink);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header { margin-bottom: 28px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 13px; margin: 0; }
  h2 { font-size: 14px; color: var(--ink-2); margin: 32px 0 12px; font-weight: 600; }

  .card {
    background: var(--surface);
    border: 1px solid var(--ring);
    border-radius: 10px;
    padding: 16px 18px 18px;
  }
  .card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .card h3 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 0; }
  .value { font-size: 32px; font-weight: 600; margin: 6px 0 12px; letter-spacing: -0.02em; }
  .hero .value { font-size: 56px; margin: 4px 0 16px; }
  .progress { font-size: 12px; color: var(--ink-2); margin: 8px 0 0; }
  .note { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
  .unavailable { font-size: 12px; color: var(--ink-2); margin: 8px 0 0; }

  /* 量表：軌道是同一藍色 ramp 的淺步階，填色為 accent；資料端 4px 圓角、基線端切齊。 */
  .meter { height: 8px; background: var(--track); border-radius: 4px; overflow: hidden; }
  .meter-fill { height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; }

  .chip { font-size: 11px; padding: 2px 7px; border-radius: 999px; font-weight: 600; }
  .chip-good { color: var(--good-ink); border: 1px solid var(--good); }
  .chip-est { color: var(--muted); border: 1px solid var(--hairline); }

  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px; }
  caption { text-align: left; color: var(--muted); font-size: 12px; padding-bottom: 8px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--hairline); text-align: left; }
  thead th { color: var(--muted); font-weight: 600; font-size: 12px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody th { font-weight: 500; color: var(--ink); }

  .caveats {
    background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
    padding: 14px 18px; font-size: 13px; color: var(--ink-2);
  }
  .caveats ol { margin: 8px 0 0; padding-left: 20px; }
  .caveats li { margin-bottom: 6px; }
  .caveats strong { color: var(--ink); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>約球 Chatbot 成長指標</h1>
    <p class="meta">${escapeHtml(meta.generatedAt)}　·　資料來源 ${escapeHtml(meta.source)}</p>
  </header>

  ${hero === undefined ? '' : tile(hero, { hero: true })}

  <h2>其餘目標指標</h2>
  <div class="grid">
    ${rest.map((m) => tile(m)).join('\n    ')}
  </div>

  <h2>觸及概況（無目標，看擴散與流失）</h2>
  <div class="grid">
    ${model.context.map((m) => tile(m)).join('\n    ')}
  </div>

  <h2>解讀時必須知道的兩件事</h2>
  <div class="caveats">
    <ol>
      <li><strong>「擴散群組」是推估值，不是精確數字。</strong>LINE 平台不提供群組建立者資訊，
        所以只能用「我從未在其中開過團的群」近似——你去別人群開了第一團之後放手，
        那個群其實算擴散，卻會被算成你的群。</li>
      <li><strong>回填進來的舊群組，加入時間只是上限。</strong>它取自該群最早一場活動的建立時間，
        實際加入更早且不可考。算「加入到首次開團要多久」時要排除
        <code>discovered_via = 'backfill'</code> 那批。</li>
    </ol>
  </div>

  <h2>完整數字</h2>
  <table>
    <caption>與上方卡片同源；口徑定義見 docs/metrics.md</caption>
    <thead>
      <tr><th scope="col">指標</th><th scope="col" class="num">目前</th>
          <th scope="col" class="num">目標</th><th scope="col" class="num">達成率</th></tr>
    </thead>
    <tbody>
${allRows}
    </tbody>
  </table>
</div>
</body>
</html>
`;
}
