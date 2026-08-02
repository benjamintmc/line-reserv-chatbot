// src/domain/billing.ts
//
// D-005 §2：計費計算純函式。對 DB / LINE 零耦合、**嚴禁 any（G6）**、不下 SQL、不 import LINE SDK。
// 均攤取整一律在此純函式計算，**不進 DB**（settled_per_person 由 event-service 於 close 交易寫入）。

import type { EventRow } from '../db/schema';

/**
 * 每人金額。
 * - split_venue：`ceil(venue_fee / max(confirmedCount, 1))`（G1 無條件進位 + 分母保底防除零）。
 * - per_person：`price_per_person`（每人固定；回歸不變）。
 *
 * 分母 robustness（G1/AC-15）：主辦自動登記已保證 confirmedCount>=1，仍以 max(,1) 防除零
 * （confirmedCount=0 的防禦性極端不 NaN/Infinity）。
 */
export function perPersonAmount(event: EventRow, confirmedCount: number): number {
  if (event.price_mode === 'split_venue') {
    const fee = event.venue_fee ?? 0; // 一致性（G4）下 split 恆有 venue_fee>0
    return Math.ceil(fee / Math.max(confirmedCount, 1));
  }
  return event.price_per_person;
}

/**
 * 顯示用預估總額。
 * - per_person：`confirmedCount × price_per_person`（沿用 D-003 §8(E) 現行語意）。
 * - split_venue：`venue_fee`（固定總額，與正取數無關）。
 */
export function estimatedTotal(event: EventRow, confirmedCount: number): number {
  return event.price_mode === 'split_venue'
    ? (event.venue_fee ?? 0)
    : confirmedCount * event.price_per_person;
}
