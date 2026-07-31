// src/commands/parse.ts
//
// D-002 §2/§3/§3.1/§4：`parseCommand(text)` 純解析層。
// 純函式（G2/G8）：無副作用、無 I/O、不讀 env、不觸時鐘/亂數、任何輸入皆不拋例外，
// 相同輸入必得相同輸出；最壞情況回 { type:'unknown' }。
//
// D-004 OP-9/G7：一行式欄位驗證改為複用 commands/validators.ts（單一 source of truth，
// 與逐步問答 create-flow 共用同一組規則）；本檔不再自持一套 date/time/capacity/price regex。
// D-005 §6.1：第 5 欄（費用）改呼叫 validateFee，依前綴判定 per_person / split_venue。

import type { InvalidCommandKind, ParsedCommand } from './types';
import { MAX_COUNT } from './types';
import {
  equalsIgnoreAsciiCase,
  normalizeProxyName,
  normalizeWhitelist,
} from './normalize';
import {
  validateCapacity,
  validateDate,
  validateFee,
  validateTime,
} from './validators';

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
 * 欄位驗證複用 commands/validators.ts（單一 source of truth，D-004 G7/AC-22）。
 * D-005 §6.1：第 5 欄改呼叫 validateFee，據 mode 填 priceMode/price/venueFee。
 */
function parseOnelineCreate(args: string[], raw: string): ParsedCommand {
  const command: InvalidCommandKind = 'create_event';

  if (args.length !== 5) {
    return { type: 'invalid', command, reason: 'create_wrong_arity', raw };
  }

  const [dateTok, timeTok, locationTok, capacityTok, feeTok] = args as [
    string,
    string,
    string,
    string,
    string,
  ];

  // 檢查順序：date → time → capacity → fee，多欄同錯回第一個（AC-24）。
  const date = validateDate(dateTok);
  if (!date.ok) {
    return { type: 'invalid', command, reason: date.reason, raw };
  }

  const time = validateTime(timeTok);
  if (!time.ok) {
    return { type: 'invalid', command, reason: time.reason, raw };
  }

  const capacity = validateCapacity(capacityTok);
  if (!capacity.ok) {
    return { type: 'invalid', command, reason: capacity.reason, raw };
  }

  const fee = validateFee(feeTok);
  if (!fee.ok) {
    return { type: 'invalid', command, reason: fee.reason, raw };
  }

  if (fee.value.mode === 'split_venue') {
    return {
      type: 'create_event_oneline',
      date: date.value,
      time: time.value,
      location: locationTok,
      capacity: capacity.value,
      price: 0,
      priceMode: 'split_venue',
      venueFee: fee.value.amount,
    };
  }

  return {
    type: 'create_event_oneline',
    date: date.value,
    time: time.value,
    location: locationTok,
    capacity: capacity.value,
    price: fee.value.amount,
    priceMode: 'per_person',
  };
}
