// src/db/tx.ts
//
// D-004「需新增原語」：中性的跨 repo 原子交易 runner。
//
// 用於開團 / 生命週期寫入（markProcessed + conversation.upsert / events.create /
// events.updateStatus / conversation.delete）的原子成敗（G4）。
//
// 隔離級別 DEFERRED（architect-reviewer 2026-07-31 裁定，非 IMMEDIATE）：
// 開團/生命週期非「讀後寫防超賣」，同群唯一由 `ux_events_active_group` 於 INSERT 當下強制；
// 且 markProcessed（寫）為交易第一步，write-first pattern 下 DEFERRED 於首寫即取 RESERVED 鎖。
// 刻意「不」複用 RegistrationRepository.runImmediate（後者語意屬報名防超賣的 IMMEDIATE 鎖，
// 耦合 RegistrationRepository 不當）。

import type { Db } from './index';

/** 中性交易 runner 型別：以 DEFERRED 交易包裹跨 repo 的原子寫入。 */
export type TransactionRunner = <T>(work: () => T) => T;

/** 由 db 建立 DEFERRED 交易 runner（注入 domain，維持 domain 不觸 db 的分層）。 */
export function createTransactionRunner(db: Db): TransactionRunner {
  return <T>(work: () => T): T => db.transaction(work).deferred();
}
