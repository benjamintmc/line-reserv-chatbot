// src/commands/validators.ts
//
// D-002 §4 欄位驗證的**單一 source of truth**（D-004 OP-9 / G7 / AC-22）。
// 一行式開團（parse.ts）與逐步問答（domain/create-flow.ts）共用同一組規則，
// 不得各自硬編一套 regex/範圍。純函式：無副作用、無 I/O、不讀 env、任何輸入皆不拋例外。
//
// 輸入契約：token 已完成白名單字元正規化（見 normalize.ts；parse.ts 於整串正規化後呼叫，
// create-flow 於逐欄答案 normalizeWhitelist + trim 後呼叫），故此處僅做格式/範圍判定與零填充輸出。

import type { PriceMode } from '../db/schema';
import type { InvalidReason } from './types';
import { MAX_CAPACITY, MAX_LOCATION_LEN } from './types';

/** 欄位驗證結果：成功帶正規化後的值，失敗帶 D-002 原因碼。嚴禁 any（G6）。 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: InvalidReason };

/**
 * 場地名稱：去頭尾空白後須非空、且不超過 `MAX_LOCATION_LEN`（**不截斷**，D-015 G6）。
 * 內部空白保留（「東方 A 場」是合法場地名）。
 *
 * D-017：原本只有 `編輯 場地` 這條路徑有上限檢查，開團（一行式與逐步問答）完全沒有
 * ⇒ 可以建出 100 字的地點，事後卻不能編輯它。此函式是三條路徑的共同上限。
 */
export function validateLocation(tok: string): ValidationResult<string> {
  const value = tok.trim();
  if (value.length === 0 || value.length > MAX_LOCATION_LEN) {
    return { ok: false, reason: 'bad_location' };
  }
  return { ok: true, value };
}

/** `YYYY/MM/DD` 或 `YYYY-MM-DD`；月 1–12、日 1–31；零填充輸出 `YYYY-MM-DD`。 */
export function validateDate(tok: string): ValidationResult<string> {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(tok);
  if (m === null) {
    return { ok: false, reason: 'create_bad_date' };
  }
  const year = m[1] ?? '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: 'create_bad_date' };
  }
  return { ok: true, value: `${year}-${pad2(month)}-${pad2(day)}` };
}

/** `H:MM` 或 `HH:MM`；時 0–23、分 0–59；零填充輸出 `HH:MM`。 */
export function validateTime(tok: string): ValidationResult<string> {
  const m = /^(\d{1,2}):(\d{2})$/.exec(tok);
  if (m === null) {
    return { ok: false, reason: 'create_bad_time' };
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, reason: 'create_bad_time' };
  }
  return { ok: true, value: `${pad2(hour)}:${pad2(minute)}` };
}

/** 去尾綴 `人`；須為 `1 <= capacity <= MAX_CAPACITY` 的整數。 */
export function validateCapacity(tok: string): ValidationResult<number> {
  const digits = stripSuffix(tok, '人');
  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: 'create_bad_capacity' };
  }
  const value = Number(digits);
  if (value < 1 || value > MAX_CAPACITY) {
    return { ok: false, reason: 'create_bad_capacity' };
  }
  return { ok: true, value };
}

/** 去尾綴 `元`；須為 `price >= 0` 的整數（per_person 每人金額）。 */
export function validatePrice(tok: string): ValidationResult<number> {
  const digits = stripSuffix(tok, '元');
  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: 'create_bad_price' };
  }
  return { ok: true, value: Number(digits) };
}

/**
 * 場地費（split_venue）驗證（D-005 §6.1 / OP-2）：去可選前綴 `場地費`/`均攤`、去尾綴 `元`；
 * 須為 `> 0` 的整數；失敗回 `create_bad_venue_fee`。
 */
export function validateVenueFee(tok: string): ValidationResult<number> {
  const noPrefix = stripPrefixAny(tok, ['場地費', '均攤']);
  const digits = stripSuffix(noPrefix, '元');
  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: 'create_bad_venue_fee' };
  }
  const value = Number(digits);
  if (value <= 0) {
    return { ok: false, reason: 'create_bad_venue_fee' };
  }
  return { ok: true, value };
}

/**
 * 費用驗證（D-005 §6.1 一行式第 5 欄 + §6.2 逐步問答單題 awaiting_fee 共用）：依前綴關鍵字判計費模式。
 * - `場地費N` / `均攤N` → split_venue，`venue_fee=N`（>0，reason create_bad_venue_fee）。
 * - `每人N` / 裸 `N`（無前綴，回歸 D-002）→ per_person，`price_per_person=N`（>=0）。
 *
 * 容錯：**去除所有空白**後再判定，容忍關鍵字與數字間空白（「場地費 3000」「每人 2200」「場地費 3000元」）。
 * 一行式 token 於切分後本無內部空白，故此容錯對一行式解析為 no-op（AC-9 零回歸）；
 * 逐步問答單題整串為答案、可能含空白，故此容錯為必要（D-005 §6.2 修訂）。
 */
export function validateFee(
  tok: string,
): ValidationResult<{ mode: PriceMode; amount: number }> {
  const compact = tok.replace(/\s+/g, '');
  if (compact.startsWith('場地費') || compact.startsWith('均攤')) {
    const r = validateVenueFee(compact);
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, value: { mode: 'split_venue', amount: r.value } };
  }
  const noPrefix = stripPrefixAny(compact, ['每人']);
  const r = validatePrice(noPrefix);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, value: { mode: 'per_person', amount: r.value } };
}

/** 若字串以 `suffix` 結尾則去除該單一尾綴，否則原樣回傳。 */
function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/** 去除首個命中的前綴（依序嘗試）；皆不符則原樣回傳。 */
function stripPrefixAny(s: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (s.startsWith(p)) return s.slice(p.length);
  }
  return s;
}

/** 整數零填充為兩位字串。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
