// src/commands/selector.ts
//
// D-024 §4.2：`@selector` 前綴切分（擴充 D-002）。
//
// **純函式（G6）**：無副作用、無 I/O、不觸 DB、不判斷候選活動集合、不決定要不要回覆錯誤訊息。
// 語意解析（`@…` 究竟命中哪一場）一律留給 domain 層的 `resolveTargetEvent`／`matchSelector`。
// 正規化只沿用／擴充 D-002 §5 的白名單字元類（本次新增 `＠`(U+FF20) → `@`），
// **不**對整串做無差別 NFKC／全形標點轉換（G5）。

import { equalsIgnoreAsciiCase, normalizeWhitelist } from './normalize';

export interface SelectorSplit {
  /** 選擇器原文（trim；跨多 token 以原始間距切出，非重新 join）。undefined = 無 @ 前綴。 */
  selectorRaw: string | undefined;
  /** 供 parseCommand 使用的剩餘文字，**保留原始換行**（供 D-012 多行批次沿用既有拆行）。 */
  rest: string;
}

/**
 * 停止 token 集合（§4.2 步驟 5）：掃到這些 token 即中止 selector 累積，該 token 起算為 `rest`。
 *
 * **G-selector-sync**：本集合必須是 `parse.ts` 之 `COMMAND_HEAD_KEYWORDS` 的**超集**——
 * 新增任何指令首字關鍵字時兩處須同步更新，否則該關鍵字會被誤吞進 selector 文字。
 * 由 `[D-024 AC-29]` 的子集斷言守門（該斷言具偵測力，見測試）。
 * 大小寫規則與 D-002 §3 dispatch 表一致：以 ASCII case-fold 比對（中文不受影響）。
 */
export const SELECTOR_STOP_KEYWORDS: ReadonlyArray<string> = [
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

/** `+N`／`-N` 起手（§4.2 步驟 5 第一項停止條件）。 */
const COUNT_HEAD_RE = /^[+-]\d/;

/** 該 token 是否為停止 token。 */
function isStopToken(token: string): boolean {
  if (COUNT_HEAD_RE.test(token)) return true;
  return SELECTOR_STOP_KEYWORDS.some((kw) => equalsIgnoreAsciiCase(token, kw));
}

/** token 與其在（正規化後）字串中的字元位移。換行亦視為分隔（`\S+`）。 */
interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    m = re.exec(s);
  }
  return out;
}

/**
 * `@selector` 前綴切分（§4.2 演算法步驟 1–6）。
 *
 * 只有**第一個** token 以 `@` 開頭才視為選擇器；其餘一律原樣回傳（`rest === text`，零回歸）。
 * 換行也算 token 分隔，故「選擇器獨佔第一行、指令在第二行」的批次寫法（`@旭陽\n+1\n-1 陳先生`）
 * 天然成立——D-012 的拆行在本函式**之後**才做（D-026 §5.2）。
 */
export function splitSelector(text: string): SelectorSplit {
  if (typeof text !== 'string') return { selectorRaw: undefined, rest: '' };

  // 步驟 1：白名單正規化（含本次新增的 `＠`→`@`）。逐 code point 1:1 對映 ⇒ 字元位移不變，
  // 故步驟 6 的「依原文字元切出」可直接在正規化後字串上切片。
  const s = normalizeWhitelist(text);
  const tokens = tokenize(s);

  // 步驟 3：第一個 token 不以 `@` 開頭（含全空白訊息）→ 原樣不動。
  const first = tokens[0];
  if (first === undefined || !first.text.startsWith('@')) {
    return { selectorRaw: undefined, rest: text };
  }

  // 步驟 4：`@` 後為空（`@` 單獨成 token）→ 視為無效前綴，原樣不動（讓它按舊行為落入 unknown）。
  if (first.text.length === 1) {
    return { selectorRaw: undefined, rest: text };
  }

  // 步驟 5：自首 token（去 `@`）起累積，逐一檢查後續 token 直到命中停止 token。
  const selectorStart = first.start + 1;
  let selectorEnd = first.end;
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (isStopToken(tok.text)) {
      // 步驟 6：selector 依字元切片（不重組）；rest 自停止 token 起始位置起（含該 token），
      // 保留原始空白／換行給 D-012 拆行用。
      return { selectorRaw: s.slice(selectorStart, selectorEnd).trim(), rest: s.slice(tok.start) };
    }
    selectorEnd = tok.end;
  }

  // 掃到結尾仍未命中停止 token → selector 佔滿剩餘全部文字，rest 為空字串。
  return { selectorRaw: s.slice(selectorStart, selectorEnd).trim(), rest: '' };
}
