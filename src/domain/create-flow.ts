// src/domain/create-flow.ts
//
// D-004 §3 / D-005 §6.2：逐步問答 state machine 純邏輯。**不觸 DB、不觸 LINE（G6）**、嚴禁 any。
// 欄位驗證複用 commands 層 validator（單一 source of truth，G7/AC-22）；
// 不在此重新硬編一套 date/time/capacity/price regex。
//
// D-005：在 awaiting_capacity 後插入計費方式提問 awaiting_price_mode，據答案分岔至
// awaiting_price（每人固定）或 awaiting_venue_fee（場地費均攤），二者皆前進 awaiting_confirm。

import type { PriceMode } from '../db/schema';
import {
  normalizeWhitelist,
  validateCapacity,
  validateDate,
  validatePrice,
  validateTime,
  validateVenueFee,
} from '../commands';

/** conversation_states.state 的合法值（D-004 §3.1 + D-005 §6.2；schema 只存字串、不在 DB 強制列舉）。 */
export type CreateState =
  | 'awaiting_date'
  | 'awaiting_time'
  | 'awaiting_location'
  | 'awaiting_capacity'
  | 'awaiting_price_mode'
  | 'awaiting_price'
  | 'awaiting_venue_fee'
  | 'awaiting_confirm';

/** 逐步問答首個 state（`開團` 觸發後的第一問）。 */
export const FIRST_STATE: CreateState = 'awaiting_date';

/**
 * 收集中的 event 欄位；欄位齊備後即等同 create event 所需輸入（D-004 §3.1 / D-005 §6.2）。
 * price 可為 0（免費/split 不適用），故齊備判定以 `!== undefined`（G6/G20）。
 */
export interface CreateEventDraft {
  date?: string; // 'YYYY-MM-DD'
  time?: string; // 'HH:MM'
  location?: string; // 原樣（trim；逐步問答可含空白，§3.1）
  capacity?: number; // 正整數
  price?: number; // per_person 每人金額（非負整數，元）；split 時為 0
  priceMode?: PriceMode; // 計費模式（D-005 §6.2）
  venueFee?: number; // split 場地費總額（>0，元）
}

/**
 * 欄位齊備的 draft（isComplete 型別守衛結果）。
 * date/time/location/capacity/priceMode 必存；price/venueFee 依 mode 至少一者有效（見 isComplete）。
 */
export interface CompleteDraft {
  date: string;
  time: string;
  location: string;
  capacity: number;
  priceMode: PriceMode;
  price?: number;
  venueFee?: number;
}

/** applyAnswer 結果：成功前進（帶新 payload 與下一 state）或欄位錯（停留同一 state 重問）。 */
export type ApplyResult =
  | { ok: true; payload: CreateEventDraft; nextState: CreateState }
  | { ok: false; state: CreateState };

/** 逐步問答計費方式答案接受詞（D-005 §6.2；OP-2 關鍵字 `場地費`，均攤為同義）。 */
const PER_PERSON_WORDS = ['每人'];
const SPLIT_WORDS = ['場地費', '均攤'];

/**
 * 某 state 成功填答後前進到的下一 state（線性部分 + 分岔匯流）。
 * 注意：awaiting_price_mode 的實際分岔（→ awaiting_price / awaiting_venue_fee）由 applyAnswer
 * 依所選 priceMode 明確決定，不經此函式（此處回線性預設 awaiting_price 供防禦）。
 */
export function nextState(state: CreateState): CreateState {
  switch (state) {
    case 'awaiting_date':
      return 'awaiting_time';
    case 'awaiting_time':
      return 'awaiting_location';
    case 'awaiting_location':
      return 'awaiting_capacity';
    case 'awaiting_capacity':
      return 'awaiting_price_mode';
    case 'awaiting_price_mode':
      return 'awaiting_price';
    case 'awaiting_price':
      return 'awaiting_confirm';
    case 'awaiting_venue_fee':
      return 'awaiting_confirm';
    case 'awaiting_confirm':
      return 'awaiting_confirm';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** payload 是否欄位齊備（可進 `確認` 建立；D-004 AC-20 / D-005 §6.2）。 */
export function isComplete(payload: CreateEventDraft): payload is CompleteDraft {
  const baseOk =
    payload.date !== undefined &&
    payload.time !== undefined &&
    payload.location !== undefined &&
    payload.location.length > 0 &&
    payload.capacity !== undefined &&
    payload.priceMode !== undefined;
  if (!baseOk) return false;
  if (payload.priceMode === 'split_venue') {
    return payload.venueFee !== undefined && payload.venueFee > 0;
  }
  return payload.price !== undefined;
}

/**
 * 對當前 state 套用一則答案（整串訊息即該欄答案）。
 * 驗證失敗 → 停留同一 state（`{ ok:false, state }`），呼叫端重問、不前進、不 INSERT（§3.2）。
 * location 可含空白（逐步問答特例，§3.1/AC-5）；空白/空字串視為無效。
 *
 * D-005 §6.2（design-reviewer B1）：awaiting_price_mode **僅接受**「每人」/「場地費（均攤）」，
 * 其餘任何輸入（含裸數字、其他字）一律停留重問、不猜測、不當金額（AC-17）。
 */
export function applyAnswer(
  state: CreateState,
  payload: CreateEventDraft,
  answer: string,
): ApplyResult {
  // 與一行式一致：先做白名單字元正規化（全形數字/加減/冒號/空白），再逐欄處理（G7）。
  const normalized = normalizeWhitelist(answer);
  const trimmed = normalized.trim();

  switch (state) {
    case 'awaiting_date': {
      const r = validateDate(trimmed);
      if (!r.ok) return { ok: false, state };
      return { ok: true, payload: { ...payload, date: r.value }, nextState: nextState(state) };
    }
    case 'awaiting_time': {
      const r = validateTime(trimmed);
      if (!r.ok) return { ok: false, state };
      return { ok: true, payload: { ...payload, time: r.value }, nextState: nextState(state) };
    }
    case 'awaiting_location': {
      // 任意非空字串（可含空白）；location 保留內部空白，僅去頭尾。
      if (trimmed.length === 0) return { ok: false, state };
      return {
        ok: true,
        payload: { ...payload, location: trimmed },
        nextState: nextState(state),
      };
    }
    case 'awaiting_capacity': {
      const r = validateCapacity(trimmed);
      if (!r.ok) return { ok: false, state };
      return { ok: true, payload: { ...payload, capacity: r.value }, nextState: nextState(state) };
    }
    case 'awaiting_price_mode': {
      // 僅接受計費方式關鍵字；其餘（含裸數字）一律停留重問（B1/AC-17，不猜測）。
      if (PER_PERSON_WORDS.includes(trimmed)) {
        return {
          ok: true,
          payload: { ...payload, priceMode: 'per_person' },
          nextState: 'awaiting_price',
        };
      }
      if (SPLIT_WORDS.includes(trimmed)) {
        return {
          ok: true,
          payload: { ...payload, priceMode: 'split_venue' },
          nextState: 'awaiting_venue_fee',
        };
      }
      return { ok: false, state };
    }
    case 'awaiting_price': {
      const r = validatePrice(trimmed);
      if (!r.ok) return { ok: false, state };
      // per_person：price 為每人金額；venue_fee 不適用（保持 undefined，一致性由 repo 邊界層 G4 兜底）。
      return {
        ok: true,
        payload: { ...payload, price: r.value },
        nextState: 'awaiting_confirm',
      };
    }
    case 'awaiting_venue_fee': {
      const r = validateVenueFee(trimmed);
      if (!r.ok) return { ok: false, state };
      // split：venueFee 為場地費總額；price 語意為 0（不適用）。
      return {
        ok: true,
        payload: { ...payload, venueFee: r.value, price: 0 },
        nextState: 'awaiting_confirm',
      };
    }
    case 'awaiting_confirm': {
      // awaiting_confirm 無待填欄位；此分支不由 applyAnswer 處理（confirm/reprompt 屬 service）。
      return { ok: false, state };
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** 型別安全解析 conversation_states.payload（JSON）為 CreateEventDraft（G6/AC-20；不以 any 承接）。 */
export function parseDraft(payloadJson: string | null): CreateEventDraft {
  if (payloadJson === null || payloadJson.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const draft: CreateEventDraft = {};
  if (typeof obj.date === 'string') draft.date = obj.date;
  if (typeof obj.time === 'string') draft.time = obj.time;
  if (typeof obj.location === 'string') draft.location = obj.location;
  if (typeof obj.capacity === 'number') draft.capacity = obj.capacity;
  if (typeof obj.price === 'number') draft.price = obj.price;
  if (obj.priceMode === 'per_person' || obj.priceMode === 'split_venue') {
    draft.priceMode = obj.priceMode;
  }
  if (typeof obj.venueFee === 'number') draft.venueFee = obj.venueFee;
  return draft;
}

/** 序列化 draft 為 JSON 供 conversation_states.payload 存放。 */
export function serializeDraft(draft: CreateEventDraft): string {
  return JSON.stringify(draft);
}
