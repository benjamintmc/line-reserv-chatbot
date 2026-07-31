// src/commands/validators.ts
//
// D-002 §4 欄位驗證的**單一 source of truth**（D-004 OP-9 / G7 / AC-22）。
// 一行式開團（parse.ts）與逐步問答（domain/create-flow.ts）共用同一組規則，
// 不得各自硬編一套 regex/範圍。純函式：無副作用、無 I/O、不讀 env、任何輸入皆不拋例外。
//
// 輸入契約：token 已完成白名單字元正規化（見 normalize.ts；parse.ts 於整串正規化後呼叫，
// create-flow 於逐欄答案 normalizeWhitelist + trim 後呼叫），故此處僅做格式/範圍判定與零填充輸出。

import type { InvalidReason } from './types';
import { MAX_CAPACITY } from './types';

/** 欄位驗證結果：成功帶正規化後的值，失敗帶 D-002 原因碼。嚴禁 any（G6）。 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: InvalidReason };

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

/** 去尾綴 `元`；須為 `price >= 0` 的整數。 */
export function validatePrice(tok: string): ValidationResult<number> {
  const digits = stripSuffix(tok, '元');
  if (!/^\d+$/.test(digits)) {
    return { ok: false, reason: 'create_bad_price' };
  }
  return { ok: true, value: Number(digits) };
}

/** 若字串以 `suffix` 結尾則去除該單一尾綴，否則原樣回傳。 */
function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/** 整數零填充為兩位字串。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
