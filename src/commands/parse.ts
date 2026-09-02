// src/commands/parse.ts
//
// D-002 §2/§3/§3.1/§4：`parseCommand(text)` 純解析層。
// 純函式（G2/G8）：無副作用、無 I/O、不讀 env、不觸時鐘/亂數、任何輸入皆不拋例外，
// 相同輸入必得相同輸出；最壞情況回 { type:'unknown' }。
//
// D-004 OP-9/G7：一行式欄位驗證改為複用 commands/validators.ts（單一 source of truth，
// 與逐步問答 create-flow 共用同一組規則）；本檔不再自持一套 date/time/capacity/price regex。
// D-005 §6.1：第 5 欄（費用）改呼叫 validateFee，依前綴判定 per_person / split_venue。
// D-011：新增 `分組`（`{M}場 [{R}輪] [單打]`）與 `下一輪` 解析。

import type { EditEventField, InvalidCommandKind, ParsedCommand } from './types';
import { MAX_COUNT, MAX_GROUP_PARAM } from './types';
import {
  equalsIgnoreAsciiCase,
  normalizeProxyName,
  normalizeWhitelist,
} from './normalize';
import {
  validateCapacity,
  validateDate,
  validateFee,
  validateLocation,
  validateTime,
} from './validators';

const UNKNOWN: ParsedCommand = { type: 'unknown' };

/** 開團觸發關鍵字（首 token）。 */
const CREATE_KEYWORDS = ['開團', '新活動'];

/**
 * 本檔 dispatch 表的**全部指令頭關鍵字**（§3 精確比對 + §4/D-010/D-011/D-015 的首 token）。
 *
 * D-024 G-selector-sync：`splitSelector` 的停止 token 集合**必須**是本集合的超集——新增任何
 * 指令首字關鍵字時兩處須同步更新，否則該關鍵字會被誤吞進 `@selector` 文字。
 * 由 `[D-024 AC-29]` 的子集斷言守門，並另有靜態掃描測試防止本清單與下方 dispatch 字面漂移。
 * 大小寫規則同 dispatch 表（`list`／`我的id` 以 case-fold 比對）。
 */
export const COMMAND_HEAD_KEYWORDS: ReadonlyArray<string> = [
  '名單',
  'list',
  '確認',
  '取消活動',
  '取消',
  '關閉報名',
  '下一輪',
  '我的id',
  '開團',
  '新活動',
  '分組',
  '加開',
  '編輯',
];

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
  if (s === '下一輪') {
    return { type: 'group_next' };
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

  // D-011：分組（`分組` 均分／`分組 {M}場 [{R}輪] [單打]` 多輪）。
  if (head === '分組') {
    if (tokens.length === 1) {
      return { type: 'group', strategy: 'balanced', mode: 'doubles' };
    }
    return parseGroupRounds(tokens.slice(1), text);
  }

  // D-010：加開名額（`加開 N`）。head==='加開'。
  if (head === '加開') {
    return parseAddCapacity(tokens.slice(1), text);
  }

  // D-015：編輯活動資訊（`編輯 <欄位> <新值>`）。首 token 為 `編輯` 者一律產生可回覆的結果
  // （edit_event / edit_help / invalid），**不落入 unknown**——`編輯` 不會出現在閒聊，
  // 故不套用 `+N`／`加開` 的靜默防洗版政策（D-015 §1 畸形輸入裁定）。
  if (head === '編輯') {
    return parseEditEvent(tokens.slice(1), text);
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
 * D-011 §1 分組多輪參數：`{M}場 [{R}輪] [單打]`（token 順序不拘、單打選填）。
 * 數字已於 normalizeWhitelist 全形→半形；場/輪數 1..MAX_GROUP_PARAM，否則 group_bad_args。
 */
function parseGroupRounds(args: string[], raw: string): ParsedCommand {
  const command: InvalidCommandKind = 'group';
  const bad: ParsedCommand = { type: 'invalid', command, reason: 'group_bad_args', raw };

  let courts: number | undefined;
  let rounds: number | undefined;
  let mode: 'singles' | 'doubles' = 'doubles';

  for (const tok of args) {
    if (tok === '單打') {
      mode = 'singles';
      continue;
    }
    if (tok === '雙打') {
      mode = 'doubles';
      continue;
    }
    const mCourt = /^(\d+)場$/.exec(tok);
    const mRound = /^(\d+)輪$/.exec(tok);
    if (mCourt !== null) {
      const v = Number(mCourt[1]);
      if (v < 1 || v > MAX_GROUP_PARAM) return bad;
      courts = v;
    } else if (mRound !== null) {
      const v = Number(mRound[1]);
      if (v < 1 || v > MAX_GROUP_PARAM) return bad;
      rounds = v;
    } else {
      return bad;
    }
  }

  if (courts !== undefined && rounds !== undefined) {
    return { type: 'group', strategy: 'rounds', mode, courts, rounds };
  }
  if (courts !== undefined) return { type: 'group', strategy: 'rounds', mode, courts };
  if (rounds !== undefined) return { type: 'group', strategy: 'rounds', mode, rounds };
  return { type: 'group', strategy: 'rounds', mode };
}

/**
 * D-010 §一.1 加開名額：`加開 N`（N=新增量）。`args` 為丟棄首 token（加開）後的剩餘 token。
 * 恰需一個純數字參數；1..MAX_COUNT → add_capacity{count}；`加開 0`/負/非數/無參 → unknown（靜默、防洗版）；
 * 位數過長或 >MAX_COUNT → invalid(count_out_of_range)（政策同 signup：上層靜默）。
 */
function parseAddCapacity(args: string[], raw: string): ParsedCommand {
  // 恰一個純數字 token；其餘（無參數/多參數/含非數字/負號）一律 unknown。
  if (args.length !== 1) {
    return UNKNOWN;
  }
  const tok = args[0] ?? '';
  const m = /^(\d+)$/.exec(tok);
  if (m === null) {
    return UNKNOWN;
  }
  const digits = m[1] ?? '';
  const count = Number(digits);
  // count<1（加開 0）→ unknown（靜默）。
  if (count < 1) {
    return UNKNOWN;
  }
  // 位數過長或超單次上限 → invalid(count_out_of_range)（domain 另以 MAX_CAPACITY 檢新總量 over_limit）。
  if (digits.length > 3 || count > MAX_COUNT) {
    return { type: 'invalid', command: 'add_capacity', reason: 'count_out_of_range', raw };
  }
  return { type: 'add_capacity', count };
}

/** `編輯` 的欄位名 → 內部欄位鍵（D-015 §1）。`地點` 為 F1 隱藏別名：parser 收、但文案一律示範「場地」。 */
const EDIT_FIELD_ALIASES: ReadonlyMap<string, EditEventField> = new Map<string, EditEventField>([
  ['日期', 'date'],
  ['時間', 'time'],
  ['場地', 'location'],
  ['地點', 'location'], // F1 隱藏別名（不對外示範）
  ['費用', 'fee'],
  ['人數', 'capacity'], // 導向用；domain 不執行任何異動（D-015 G2）
]);

/**
 * D-015 §1 編輯活動資訊：`編輯 <欄位> <新值>`。`args` 為丟棄首 token（編輯）後的剩餘 token。
 *
 * 取值規則（逐欄不同，勿統一）：
 * - date/time：compact（`join('')`）後送既有 validateDate/validateTime 正規化；格式錯 → invalid。
 * - location：`join(' ')` **保留空格**（場地名需要，如「東方 A 場」）；空 → edit_help；
 *   > MAX_LOCATION_LEN → invalid(bad_location)，**不截斷**（G6）。
 * - fee：**F2 compact**（`join('')` 後再去空白）。`validateVenueFee`／`validatePrice` 不吸收空白
 *   （只有被 G6 禁用的 `validateFee` 會 compact），不先壓掉空白則 `場地費 4000`／`2500 元` 會被誤拒。
 *   格式須依 `event.price_mode` 判定，parser 無此資訊 → 原樣下傳，由 domain 驗（§2 步驟 5）。
 * - capacity：不論有無新值一律回 edit_event{field:'capacity'}（domain 回導向文案、零異動）。
 * - 無參數／未知欄位名／date·time·location·fee 缺新值 → edit_help（回現值＋範例）。
 */
function parseEditEvent(args: string[], raw: string): ParsedCommand {
  const command: InvalidCommandKind = 'edit_event';
  const field = EDIT_FIELD_ALIASES.get(args[0] ?? '');
  if (field === undefined) {
    // `編輯`（無參數）／未知欄位名（如 `編輯 費率 100`）→ 導引。
    return { type: 'edit_help' };
  }
  const rest = args.slice(1);

  // 人數：一律導向（不落 help、不帶新值語意），缺值與帶值同路徑（AC-7）。
  if (field === 'capacity') {
    return { type: 'edit_event', field, value: rest.join(' ') };
  }

  if (rest.length === 0) {
    // 缺新值：`編輯 日期`／`編輯 場地`… → 導引（靜默會變成「打對一半卻沒反應」的死角）。
    return { type: 'edit_help' };
  }

  if (field === 'date') {
    const r = validateDate(rest.join(''));
    if (!r.ok) return { type: 'invalid', command, reason: r.reason, raw };
    return { type: 'edit_event', field, value: r.value };
  }
  if (field === 'time') {
    const r = validateTime(rest.join(''));
    if (!r.ok) return { type: 'invalid', command, reason: r.reason, raw };
    return { type: 'edit_event', field, value: r.value };
  }
  if (field === 'location') {
    const value = rest.join(' ').trim();
    if (value === '') return { type: 'edit_help' }; // 空值＝問「現在的場地是什麼」，非錯誤
    const r = validateLocation(value);
    if (!r.ok) {
      // detail 帶實際字數供文案顯示（D-015 §1）；此處已知非空，故必為超長。
      return { type: 'invalid', command, reason: r.reason, raw, detail: { len: value.length } };
    }
    return { type: 'edit_event', field, value: r.value };
  }
  // fee：F2 compact；金額格式與計費模式一致性由 domain 依 price_mode 判（§2 步驟 5）。
  const value = rest.join('').replace(/\s+/g, '');
  if (value === '') return { type: 'edit_help' };
  return { type: 'edit_event', field, value };
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

  // D-017：地點上限原本只存在於「編輯 場地」路徑，開團完全沒有 ⇒ 可建出事後不能編輯的長地點。
  const location = validateLocation(locationTok);
  if (!location.ok) {
    return { type: 'invalid', command, reason: location.reason, raw };
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
      location: location.value,
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
    location: location.value,
    capacity: capacity.value,
    price: fee.value.amount,
    priceMode: 'per_person',
  };
}
