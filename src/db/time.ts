/**
 * 時間戳共用 helper（G11 / D-001 §0）。
 * 一律以 UTC ISO-8601（秒精度、以 `Z` 結尾）字串輸出，格式為
 * `YYYY-MM-DDTHH:MM:SSZ`（無毫秒、無空格），符合 AC-13 的正規式。
 * 時間戳一律於應用層（repository / migrate runner）顯式寫入，
 * TEXT 時間欄不使用 SQLite `DEFAULT CURRENT_TIMESTAMP`。
 */
export function nowIso(): string {
  // toISOString() 產生 `...SS.mmmZ`；去掉毫秒段以符合本專案自訂的秒精度 ISO 格式。
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 秒精度 UTC ISO-8601（`...Z`，無毫秒）。內部把 Date 正規化為本專案格式。 */
function toSecondIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Taipei 固定 UTC+8（無 DST，D-008 OP-6）

/**
 * 台灣本地 wall time（`YYYY-MM-DD` + `HH:MM`）→ UTC ISO-8601（`YYYY-MM-DDTHH:MM:00Z`）。
 * 固定 −8h 偏移算術（Asia/Taipei 無 DST，D-008 §3/OP-6）：確定性、免時區函式庫、可純測。
 * 輸入預期已由 commands validator（validateDate/validateTime）驗過格式；此處只作算術轉換。
 * 秒段固定補 `00`（輸入僅到分）。
 *
 * 邊界（AC-7）：台灣 `2026-08-15 07:30` → `2026-08-14T23:30:00Z`（跨 UTC 日界）。
 */
export function taipeiToUtcIso(date: string, time: string): string {
  const dm = date.split('-');
  const tm = time.split(':');
  const y = Number(dm[0]);
  const mo = Number(dm[1]);
  const d = Number(dm[2]);
  const h = Number(tm[0]);
  const mi = Number(tm[1]);
  if (![y, mo, d, h, mi].every((n) => Number.isFinite(n))) {
    throw new Error(`taipeiToUtcIso: 無法解析日期/時間（date=${date}, time=${time}）`);
  }
  // 把台灣本地 wall time 當成該時刻的「元件」，先以 UTC 元件組出毫秒，再減 8h 得真正 UTC。
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, 0) - TAIPEI_OFFSET_MS;
  return toSecondIso(new Date(utcMs));
}

/**
 * UTC ISO-8601 → 台灣本地 wall time `{ date: 'YYYY-MM-DD', time: 'HH:MM' }`（+8h，D-008 §3）。
 * 顯示層還原（formatter 用）：與 `taipeiToUtcIso` 互逆 → 顯示字面與輸入一致（AC-10）。
 */
export function utcIsoToTaipei(iso: string): { date: string; time: string } {
  const utcMs = Date.parse(iso);
  if (Number.isNaN(utcMs)) {
    throw new Error(`utcIsoToTaipei: 無法解析 ISO（iso=${iso}）`);
  }
  const local = new Date(utcMs + TAIPEI_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  return { date, time };
}
