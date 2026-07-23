// src/commands/parse.ts
//
// D-002 §2/§3/§3.1/§4：`parseCommand(text)` 純解析層。
// 純函式（G2/G8）：無副作用、無 I/O、不讀 env、不觸時鐘/亂數、任何輸入皆不拋例外，
// 相同輸入必得相同輸出；最壞情況回 { type:'unknown' }。

import type { InvalidCommandKind, ParsedCommand } from './types';
import { MAX_CAPACITY, MAX_COUNT } from './types';
import {
  equalsIgnoreAsciiCase,
  normalizeProxyName,
  normalizeWhitelist,
} from './normalize';

const UNKNOWN: ParsedCommand = { type: 'unknown' };

/** 開團觸發關鍵字（首 token）。 */
const CREATE_KEYWORDS = ['開團', '新活動'];

/**
 * 文字訊息 → 結構化指令。詳見 D-002。
 * @param text LINE `message.text`（型別上恆為 string；防禦性上非 string 一律 unknown）。
 */
export function parseCommand(text: string): ParsedCommand {
  // 1. 型別防禦（§2 步驟 1）：非 string → unknown。
  if (typeof text !== 'string') {
    return UNKNOWN;
  }

  // 2. 全形空格 → 半形（§2 步驟 2，供 trim 與 token 切分）。
  // 3. 外層 trim（§2 步驟 3）。
  const trimmed = text.replace(/　/g, ' ').trim();

  // 4. 空字串短路（§2 步驟 4）。
  if (trimmed === '') {
    return UNKNOWN;
  }

  // 5. 白名單字元正規化（§2 步驟 5 / §5，對全串生效）。
  const s = normalizeWhitelist(trimmed);

  // 6/7. 大小寫折疊比對 + 分派（§3 dispatch 表，順序固定）。
  if (s === '名單' || equalsIgnoreAsciiCase(s, 'list')) {
    return { type: 'list' };
  }
  if (s === '確認') {
    return { type: 'confirm' };
  }
  if (s === '取消活動') {
    return { type: 'cancel_event' };
  }
  if (s === '取消') {
    return { type: 'abort' };
  }
  if (s === '關閉報名') {
    return { type: 'close_event' };
  }
  if (equalsIgnoreAsciiCase(s, '我的id')) {
    return { type: 'my_id' };
  }

  // 7/8. 開團 / 新活動：無其他 token → start；有其他 token → 一行式（§4）。
  const tokens = s.split(/\s+/);
  const head = tokens[0] ?? '';
  if (CREATE_KEYWORDS.includes(head)) {
    if (tokens.length === 1) {
      return { type: 'create_event_start' };
    }
    return parseOnelineCreate(tokens.slice(1), text);
  }

  // 9. `+` 開頭 → 報名；10. `-` 開頭 → 取消（§3.1）。
  if (s.startsWith('+')) {
    return parseCountCommand('signup', s, text);
  }
  if (s.startsWith('-')) {
    return parseCountCommand('cancel', s, text);
  }

  // 11. 其餘一切 → unknown。
  return UNKNOWN;
}

/**
 * §3.1 `+N`/`-N`（含代報名）。`s` 已正規化，且首字元為 '+' 或 '-'。
 * `raw` 為原始輸入，供 invalid 帶回。
 */
function parseCountCommand(
  type: 'signup' | 'cancel',
  s: string,
  raw: string,
): ParsedCommand {
  const body = s.slice(1);
  // sign 後必須「緊接」1+ 數字；否則（+abc、+、'+ 1'）→ unknown。
  const m = /^(\d+)([\s\S]*)$/.exec(body);
  if (m === null) {
    return UNKNOWN;
  }
  const digits = m[1] ?? '';
  const remainder = m[2] ?? '';
  const count = Number(digits);

  // 計數邊界（§0 / §3.1，O-3）——檢查順序不可顛倒：
  // 先判 count<1（+0/-0）→ unknown（靜默）；否則 +0000 之類會被位數判斷誤傷。
  if (count < 1) {
    return UNKNOWN;
  }
  // 位數過長或超上限 → invalid(count_out_of_range)。
  if (digits.length > 3 || count > MAX_COUNT) {
    return { type: 'invalid', command: type, reason: 'count_out_of_range', raw };
  }

  // 1 <= count <= MAX_COUNT：擷取代報名名字（寬鬆規則，O-6）。
  const proxyName = normalizeProxyName(remainder);
  if (proxyName === '') {
    return { type, count };
  }
  return { type, count, proxyName };
}

/**
 * §4 一行式開團。`args` 為丟棄首 token（開團/新活動）後的剩餘 token（皆已正規化）。
 * `raw` 為原始輸入，供 invalid 帶回。
 */
function parseOnelineCreate(args: string[], raw: string): ParsedCommand {
  const command: InvalidCommandKind = 'create_event';

  if (args.length !== 5) {
    return { type: 'invalid', command, reason: 'create_wrong_arity', raw };
  }

  const [dateTok, timeTok, locationTok, capacityTok, priceTok] = args as [
    string,
    string,
    string,
    string,
    string,
  ];

  // 檢查順序：date → time → capacity → price，多欄同錯回第一個（AC-24）。
  const date = parseDate(dateTok);
  if (date === null) {
    return { type: 'invalid', command, reason: 'create_bad_date', raw };
  }

  const time = parseTime(timeTok);
  if (time === null) {
    return { type: 'invalid', command, reason: 'create_bad_time', raw };
  }

  const capacity = parseCapacity(capacityTok);
  if (capacity === null) {
    return { type: 'invalid', command, reason: 'create_bad_capacity', raw };
  }

  const price = parsePrice(priceTok);
  if (price === null) {
    return { type: 'invalid', command, reason: 'create_bad_price', raw };
  }

  return {
    type: 'create_event_oneline',
    date,
    time,
    location: locationTok,
    capacity,
    price,
  };
}

/** `YYYY/MM/DD` 或 `YYYY-MM-DD`；月 1–12、日 1–31；零填充輸出 `YYYY-MM-DD`。失敗回 null。 */
function parseDate(tok: string): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(tok);
  if (m === null) {
    return null;
  }
  const year = m[1] ?? '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** `H:MM` 或 `HH:MM`；時 0–23、分 0–59；零填充輸出 `HH:MM`。失敗回 null。 */
function parseTime(tok: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(tok);
  if (m === null) {
    return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** 去尾綴 `人`；須為 `1 <= capacity <= MAX_CAPACITY` 的整數。失敗回 null。 */
function parseCapacity(tok: string): number | null {
  const digits = stripSuffix(tok, '人');
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const value = Number(digits);
  if (value < 1 || value > MAX_CAPACITY) {
    return null;
  }
  return value;
}

/** 去尾綴 `元`；須為 `price >= 0` 的整數。失敗回 null。 */
function parsePrice(tok: string): number | null {
  const digits = stripSuffix(tok, '元');
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  return Number(digits);
}

/** 若字串以 `suffix` 結尾則去除該單一尾綴，否則原樣回傳。 */
function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/** 整數零填充為兩位字串。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
