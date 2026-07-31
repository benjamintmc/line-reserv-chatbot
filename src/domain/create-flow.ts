// src/domain/create-flow.ts
//
// D-004 §3：逐步問答 state machine 純邏輯。**不觸 DB、不觸 LINE（G5）**、嚴禁 any（G6）。
// 欄位驗證複用 commands 層 validator（單一 source of truth，G7/AC-22）；
// 不在此重新硬編一套 date/time/capacity/price regex。

import {
  normalizeWhitelist,
  validateCapacity,
  validateDate,
  validatePrice,
  validateTime,
} from '../commands';

/** conversation_states.state 的合法值（D-004 §3.1；schema 只存字串、不在 DB 強制列舉）。 */
export type CreateState =
  | 'awaiting_date'
  | 'awaiting_time'
  | 'awaiting_location'
  | 'awaiting_capacity'
  | 'awaiting_price'
  | 'awaiting_confirm';

/** 逐步問答首個 state（`開團` 觸發後的第一問）。 */
export const FIRST_STATE: CreateState = 'awaiting_date';

/**
 * 收集中的 event 欄位；欄位齊備後即等同 create event 所需輸入（D-004 §3.1）。
 * price 可為 0（免費），故齊備判定以 `!== undefined`（G6/G20）。
 */
export interface CreateEventDraft {
  date?: string; // 'YYYY-MM-DD'
  time?: string; // 'HH:MM'
  location?: string; // 原樣（trim；逐步問答可含空白，§3.1）
  capacity?: number; // 正整數
  price?: number; // 非負整數（元）
}

/** applyAnswer 結果：成功前進（帶新 payload 與下一 state）或欄位錯（停留同一 state 重問）。 */
export type ApplyResult =
  | { ok: true; payload: CreateEventDraft; nextState: CreateState }
  | { ok: false; state: CreateState };

/** 收集欄位的順序（date → time → location → capacity → price → confirm）。 */
const FIELD_ORDER: CreateState[] = [
  'awaiting_date',
  'awaiting_time',
  'awaiting_location',
  'awaiting_capacity',
  'awaiting_price',
  'awaiting_confirm',
];

/** 某 state 成功填答後前進到的下一 state。 */
export function nextState(state: CreateState): CreateState {
  const i = FIELD_ORDER.indexOf(state);
  if (i < 0 || i >= FIELD_ORDER.length - 1) {
    return 'awaiting_confirm';
  }
  return FIELD_ORDER[i + 1] as CreateState;
}

/** payload 是否欄位齊備（可進 `確認` 建立；D-004 AC-20/G6）。 */
export function isComplete(payload: CreateEventDraft): payload is Required<CreateEventDraft> {
  return (
    payload.date !== undefined &&
    payload.time !== undefined &&
    payload.location !== undefined &&
    payload.location.length > 0 &&
    payload.capacity !== undefined &&
    payload.price !== undefined
  );
}

/**
 * 對當前 state 套用一則答案（整串訊息即該欄答案）。
 * 驗證失敗 → 停留同一 state（`{ ok:false, state }`），呼叫端重問、不前進、不 INSERT（§3.2）。
 * location 可含空白（逐步問答特例，§3.1/AC-5）；空白/空字串視為無效。
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
    case 'awaiting_price': {
      const r = validatePrice(trimmed);
      if (!r.ok) return { ok: false, state };
      return { ok: true, payload: { ...payload, price: r.value }, nextState: nextState(state) };
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
  return draft;
}

/** 序列化 draft 為 JSON 供 conversation_states.payload 存放。 */
export function serializeDraft(draft: CreateEventDraft): string {
  return JSON.stringify(draft);
}
