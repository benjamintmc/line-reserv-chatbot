// src/domain/event-status.ts
//
// D-008 §0：單一過期判定原語（domain 純函式，全讀取點共用）。
// event_datetime 與 nowIso() 皆為同格式 UTC ISO-8601（`YYYY-MM-DDTHH:MM:SSZ`，固定 20 字元），
// 字典序 == 時序（同 D-001 G11 對 created_at FIFO 的不變式），故過期判定可純字串比較（G3）。
//
// 純函式：不觸 DB、不觸 LINE、嚴禁 any。now 一律由呼叫端傳入（nowIso()），保持可純測。

import type { EventRow } from '../db/schema';

/** 顯示分類（domain 依 isExpired/status 判定後傳 formatter；formatter 純函式不持時鐘）。 */
export type ListPhase = 'live' | 'ended' | 'closed';

/** 已過期 ⟺ NOW() > event_datetime（strict：超過開始時間即過期，D-008 §0 使用者裁決）。 */
export function isExpired(event: EventRow, now: string): boolean {
  return now > event.event_datetime;
}

/** 可報名 ⟺ status='open' 且未過期（event_datetime >= NOW()）。 */
export function isOpenForSignup(event: EventRow, now: string): boolean {
  return event.status === 'open' && !isExpired(event, now);
}

/**
 * 顯示 phase（D-008 §2）：
 * - `closed`：status='closed'（報名已截止；不論時間）。
 * - `ended`：open 且已過期（活動已結束）。
 * - `live`：其餘（未過期 open / draft）。
 * done/cancelled 不入顯示集，不由本函式承載（見 DISPLAYABLE_EVENT_STATUSES）。
 */
export function displayPhase(event: EventRow, now: string): ListPhase {
  if (event.status === 'closed') return 'closed';
  if (isExpired(event, now)) return 'ended';
  return 'live';
}
