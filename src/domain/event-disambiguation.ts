// src/domain/event-disambiguation.ts
//
// D-023 §4.3：語意解析核心（**純函式**）。
//
// `resolveTargetEvent` 決定「這個指令要作用在哪一場活動」；`matchSelector` 是它內部使用的
// selector 比對（亦單獨導出供測試）。
//
// **G6（純函式、不越界）**：兩者皆不得接受 `groupId` 參數、不得存取 DB——跨群校驗是 dispatch
// 層的職責（G14，見 D-026 §5.2 的 `resolveQuotedEventInGroup`）。傳入的 `quotedEventId` 保證
// 「若非 undefined，必屬於當前 groupId」。
//
// **G2（判斷順序不可重排）**：`candidates.length <= 1` 必須**最先**判斷，且完全略過 quote／
// selector 的解析與驗證——單場時的既有行為零回歸（AC-6）。

import type { EventRow } from '../db/schema';
import { utcIsoToTaipei } from '../db/time';

/** 目標活動解析結果（§4.3）。 */
export type TargetResolution =
  | { kind: 'none' } // candidates.length === 0
  | { kind: 'single'; eventId: number } // candidates.length === 1（忽略 quote/selector）
  | { kind: 'resolved'; eventId: number } // >1 候選，quote 或 selector 命中恰一場
  | { kind: 'ambiguous' } // >1 候選，無 quote 也無 selector
  | { kind: 'conflict' } // quote 與 selector 都給了，指向不同活動
  | { kind: 'not_found'; selectorRaw: string } // selector 命中 0 場
  | { kind: 'too_many'; selectorRaw: string }; // selector 命中 >1 場

/** 完整日期 token：`YYYY/M/D`／`YYYY-M-D`。 */
const FULL_DATE_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;
/** 月日 token（無年）：`M/D`／`M-D`。 */
const MONTH_DAY_RE = /^(\d{1,2})[/-](\d{1,2})$/;
/** 時間 token：`H:MM`。 */
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function pad2(v: string): string {
  return v.padStart(2, '0');
}

/** token 分類結果（§4.3 比對規則步驟 2）。 */
interface SelectorTokens {
  /** 完整日期（正規化為 `YYYY-MM-DD`）。 */
  fullDates: string[];
  /** 月日（正規化為 `MM-DD`）。 */
  monthDays: string[];
  /** 時間（正規化為 `HH:MM`）。 */
  times: string[];
  /** 場地文字 tokens 以單一空白 join 後的查詢字串（可能為空字串＝無場地條件）。 */
  locationQuery: string;
}

function classify(selectorRaw: string): SelectorTokens {
  const fullDates: string[] = [];
  const monthDays: string[] = [];
  const times: string[] = [];
  const locationTokens: string[] = [];

  for (const tok of selectorRaw.split(/\s+/)) {
    if (tok === '') continue;
    const full = FULL_DATE_RE.exec(tok);
    if (full !== null) {
      fullDates.push(`${full[1] ?? ''}-${pad2(full[2] ?? '')}-${pad2(full[3] ?? '')}`);
      continue;
    }
    const md = MONTH_DAY_RE.exec(tok);
    if (md !== null) {
      monthDays.push(`${pad2(md[1] ?? '')}-${pad2(md[2] ?? '')}`);
      continue;
    }
    const t = TIME_RE.exec(tok);
    if (t !== null) {
      times.push(`${pad2(t[1] ?? '')}:${t[2] ?? ''}`);
      continue;
    }
    locationTokens.push(tok);
  }

  return { fullDates, monthDays, times, locationQuery: locationTokens.join(' ') };
}

/**
 * selector 對候選集合的比對（§4.3「`matchSelector` 比對規則」步驟 1–6）。回傳所有命中的列（0/1/多）。
 *
 * 1. 空白切分 tokens；2. 逐 token 分類（完整日期／月日／時間／場地文字）；
 * 3. 場地查詢字串非空 → 先以 `location.includes(query)` 子字串（區分大小寫）過濾；
 * 4. 有日期 token → 再以台灣本地日期過濾（完整日期精確比對；月日只比 `MM-DD`，忽略年份）；
 * 5. **時間 token 僅在「場地+日期過濾後仍 >1 場」時才進一步套用**（時間是次要窄化條件）；
 * 6. 回傳最終集合。
 *
 * @param now 目前時刻（UTC ISO）。屬 §4.3 釘死的簽名；比對規則步驟 4 明定月日 token「忽略年份」
 *   （只比對 `MM-DD` 後兩段）⇒ 本函式不需要讀取年份，`now` 目前不參與任何判斷（保留簽名一致性，
 *   亦供 `resolveTargetEvent` 透傳）。
 */
export function matchSelector(
  candidates: EventRow[],
  selectorRaw: string,
  now: string,
): EventRow[] {
  void now; // 見上方 @param 說明：規則 4 明定忽略年份，故不讀取 now。
  const { fullDates, monthDays, times, locationQuery } = classify(selectorRaw);

  // 步驟 3：場地子字串過濾（區分大小寫）。
  let hits = candidates;
  if (locationQuery !== '') {
    hits = hits.filter((e) => e.location.includes(locationQuery));
  }

  // 步驟 4：日期過濾。
  if (fullDates.length > 0 || monthDays.length > 0) {
    hits = hits.filter((e) => {
      const { date } = utcIsoToTaipei(e.event_datetime);
      if (fullDates.includes(date)) return true;
      return monthDays.includes(date.slice(5)); // `YYYY-MM-DD` → `MM-DD`
    });
  }

  // 步驟 5：時間僅在仍 >1 場時才套用（次要窄化條件，非必要條件）。
  if (times.length > 0 && hits.length > 1) {
    hits = hits.filter((e) => times.includes(utcIsoToTaipei(e.event_datetime).time));
  }

  return hits;
}

/**
 * 目標活動解析（§4.3 判斷順序步驟 1–6；**G2 不得重排**）。
 *
 * 1. `candidates.length <= 1` → 0 回 `none`、1 回 `single`（**完全不看** quote/selector）。
 * 2. `>1`：a. quote 與 selector 皆有 → 兩者不指向同一場即 `conflict`；
 *          b. 只有 quote → `resolved`；
 *          c. 只有 selector → 依命中數 0/`>1`/1 回 `not_found`/`too_many`/`resolved`；
 *          d. 兩者皆無 → `ambiguous`。
 *
 * `quotedEventId` **不**過濾「是否仍在 candidates 內」——使用者可引用指向已關閉/已取消活動的舊
 * 訊息；該場還能不能做這件事，交給各指令自身既有的狀態判斷（分工單一，§4.3 附註）。
 */
export function resolveTargetEvent(
  candidates: EventRow[],
  quotedEventId: number | undefined,
  selectorRaw: string | undefined,
  now: string,
): TargetResolution {
  // 步驟 1（G2：必須最先判斷，且完全略過 selector/quote 的解析與驗證）。
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only === undefined) return { kind: 'none' }; // 不可達（length===1）；型別收斂用
    return { kind: 'single', eventId: only.id };
  }

  // 步驟 2a：quote 與 selector 都給了 → 必須指向同一場，否則 conflict。
  if (quotedEventId !== undefined && selectorRaw !== undefined) {
    const hits = matchSelector(candidates, selectorRaw, now);
    const hit = hits.length === 1 ? hits[0] : undefined;
    if (hit === undefined || hit.id !== quotedEventId) return { kind: 'conflict' };
    return { kind: 'resolved', eventId: quotedEventId };
  }

  // 步驟 2b：只有 quote。
  if (quotedEventId !== undefined) return { kind: 'resolved', eventId: quotedEventId };

  // 步驟 2c：只有 selector。
  if (selectorRaw !== undefined) {
    const hits = matchSelector(candidates, selectorRaw, now);
    if (hits.length === 0) return { kind: 'not_found', selectorRaw };
    if (hits.length > 1) return { kind: 'too_many', selectorRaw };
    const hit = hits[0];
    if (hit === undefined) return { kind: 'not_found', selectorRaw }; // 不可達；型別收斂用
    return { kind: 'resolved', eventId: hit.id };
  }

  // 步驟 2d：兩者皆無。
  return { kind: 'ambiguous' };
}
