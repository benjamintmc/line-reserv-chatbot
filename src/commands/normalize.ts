// src/commands/normalize.ts
//
// D-002 §2 / §5：正規化 helpers。
// 僅正規化白名單字元類（§5 對照表），刻意「不」做全域 NFKC / 全形標點轉換（G6）。
// 全部為純函式（無副作用），供 parse.ts 組裝管線使用。

import { MAX_PROXY_NAME_LEN } from './types';

/**
 * 白名單字元正規化（§5）：對「全串」生效，token 切分前執行。
 *
 * 轉換範圍（僅此白名單字元類）：
 *   - 全形空格 U+3000 → 半形空格 ' '
 *   - 全形數字 U+FF10–U+FF19 → 0–9
 *   - 全形加號 U+FF0B → '+'
 *   - 全形減號 U+FF0D → '-'
 *   - Unicode 減號 U+2212 → '-'
 *   - 全形冒號 U+FF1A → ':'
 *   - 全形 at U+FF20 → '@'（D-024 §4.2 步驟 1：`@selector` 前綴切分需要，併入同一張白名單表）
 *
 * 中文與其他非白名單字元一律保留原樣（不做無差別 NFKC，G6）。
 * 故 location/proxyName 內若含這些白名單字元也會被轉半形（預期行為，見 §5）。
 */
export function normalizeWhitelist(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code === undefined) {
      out += ch;
      continue;
    }
    if (code === 0x3000) {
      out += ' '; // 全形空格 → 半形空格
    } else if (code >= 0xff10 && code <= 0xff19) {
      out += String.fromCharCode(code - 0xff10 + 0x30); // 全形數字 → 半形數字
    } else if (code === 0xff0b) {
      out += '+'; // 全形加號
    } else if (code === 0xff0d || code === 0x2212) {
      out += '-'; // 全形減號 / Unicode 減號
    } else if (code === 0xff1a) {
      out += ':'; // 全形冒號
    } else if (code === 0xff20) {
      out += '@'; // 全形 at（D-024 §4.2：selector 前綴）
    } else {
      out += ch; // 非白名單字元：原樣保留
    }
  }
  return out;
}

/**
 * ASCII 大小寫折疊比對工具（§2 步驟 6）。
 * 僅用於關鍵字比對（如 `list`、`我的ID` 的 `ID`）；中文字元不受影響。
 */
export function equalsIgnoreAsciiCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * proxyName 正規化（§3.1 step 4 / §5）：
 *   - trim
 *   - 內部連續空白折疊為單一空白
 *   - 超過 MAX_PROXY_NAME_LEN（20 code unit）→ 截斷取前 20 個 code unit（O-4，非 invalid）
 *
 * 回傳空字串代表「無 proxyName」（呼叫端據此決定是否帶 proxyName）。
 * 長度以 JS string length（UTF-16 code unit）計；MVP 不做 grapheme/emoji 群集精算。
 */
export function normalizeProxyName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length > MAX_PROXY_NAME_LEN) {
    return collapsed.slice(0, MAX_PROXY_NAME_LEN);
  }
  return collapsed;
}
