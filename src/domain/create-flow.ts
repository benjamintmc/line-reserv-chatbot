// src/domain/create-flow.ts
//
// D-004 §3 / D-005 §6.2：逐步問答 state machine 純邏輯。**不觸 DB、不觸 LINE（G6）**、嚴禁 any。
// 欄位驗證複用 commands 層 validator（單一 source of truth，G7/AC-22）；
// 不在此重新硬編一套 date/time/capacity/price regex。
//
// D-005 §6.2（修訂 2026-07-31，真機跨試回饋）：計費併為單一題 awaiting_fee。
// awaiting_capacity 後接 awaiting_fee，整串答案交 validateFee（與一行式同一 source of truth），
// 依前綴關鍵字判 mode（每人固定 / 場地費均攤），合法即前進 awaiting_confirm。

import type { PriceMode } from '../db/schema';
import {
  normalizeWhitelist,
  validateCapacity,
  validateDate,
  validateFee,
  validateTime,
} from '../commands';

/** conversation_states.state 的合法值（D-004 §3.1 + D-005 §6.2；schema 只存字串、不在 DB 強制列舉）。 */
export type CreateState =
  | 'awaiting_date'
  | 'awaiting_time'
  | 'awaiting_location'
  | 'awaiting_capacity'
  | 'awaiting_fee'
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

/** 某 state 成功填答後前進到的下一 state（線性；D-005 §6.2 修訂後計費為單題，無分岔）。 */
export function nextState(state: CreateState): CreateState {
  switch (state) {
    case 'awaiting_date':
      return 'awaiting_time';
    case 'awaiting_time':
      return 'awaiting_location';
    case 'awaiting_location':
      return 'awaiting_capacity';
    case 'awaiting_capacity':
      return 'awaiting_fee';
    case 'awaiting_fee':
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
 * D-005 §6.2（修訂）：awaiting_fee 整串答案交 validateFee 依前綴判 mode（每人 / 場地費均攤）；
 * validateFee 容忍關鍵字與數字間空白（「場地費 3000」「每人 2200」皆可）。無效停留重問（AC-17）。
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
    case 'awaiting_fee': {
      // 單題整串答案交 validateFee（依前綴判 mode；容忍關鍵字與數字間空白）。
      const r = validateFee(trimmed);
      if (!r.ok) return { ok: false, state };
      if (r.value.mode === 'split_venue') {
        // split：venueFee 為場地費總額；price 語意為 0（不適用）。
        return {
          ok: true,
          payload: { ...payload, priceMode: 'split_venue', venueFee: r.value.amount, price: 0 },
          nextState: 'awaiting_confirm',
        };
      }
      // per_person：price 為每人金額；venue_fee 不適用（保持 undefined，一致性由 repo 邊界層 G4 兜底）。
      return {
        ok: true,
        payload: { ...payload, priceMode: 'per_person', price: r.value.amount },
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
