// src/db/tx.ts
//
// D-007 §3「路線 A」：PG 交易 runner。取代 SQLite 版 better-sqlite3 的
// db.transaction().immediate()/.deferred() 與 RegistrationRepository.runImmediate。
//
// 連線一致性（G1，本移植最易犯的靜默 bug）：pg pool 下若交易內各查詢各自 pool.query() 會落在
// **不同連線** → FOR UPDATE 鎖在 client A、INSERT 卻在 client B → 鎖失效、靜默超賣。
// 故 runner 在**該次 checkout 的同一 `PoolClient`** 上建構一束 client-bound repository（TxRepos），
// 顯式注入 work；work 只能經 `repos.*` 查詢（同連線），此事實由型別強制（拒斥 AsyncLocalStorage）。

import type { Pool, PoolClient } from './index';
import { EventRepository } from './repositories/event-repository';
import { UserRepository } from './repositories/user-repository';
import { RegistrationRepository } from './repositories/registration-repository';
import { ConversationRepository } from './repositories/conversation-repository';
import { ProcessedEventRepository } from './repositories/processed-event-repository';

/**
 * client-bound repository 束（路線 A）：五個 repository 皆綁定**同一** checked-out `PoolClient`。
 * 交易 work 透過本束查詢 → 交易內所有查詢天然同連線（FOR UPDATE 鎖生效、防超賣，G1）。
 * 這裡曝露的是**完整**類別（含寫方法）——與 pool-bound 依賴只曝讀方法（Reader 介面）相對：
 * 「寫入必在交易內」由編譯器強制（N-new-2）。
 */
export interface TxRepos {
  events: EventRepository;
  users: UserRepository;
  registrations: RegistrationRepository;
  processed: ProcessedEventRepository;
  conversations: ConversationRepository;
}

/** 於 checked-out client 上建構 client-bound TxRepos（匯出供 AC-3 連線一致性測試探針）。 */
export function buildTxRepos(client: PoolClient): TxRepos {
  return {
    events: new EventRepository(client),
    users: new UserRepository(client),
    registrations: new RegistrationRepository(client),
    processed: new ProcessedEventRepository(client),
    conversations: new ConversationRepository(client),
  };
}

/**
 * DEFERRED 交易 runner（D-004；開團/生命週期，**不鎖 event**）。
 * `BEGIN → work(repos) → COMMIT`（或 ROLLBACK）。同群活動查重由 `ux_events_active_group_venue_time`
 * 於 INSERT 當下強制（撞約束 → 由呼叫端窄捕捉 23505 → already_active）。
 */
export type TransactionRunner = <T>(work: (repos: TxRepos) => Promise<T>) => Promise<T>;

/**
 * IMMEDIATE 等價 runner（D-003；報名/取消/遞補防超賣）。
 * `BEGIN → SELECT id FROM events WHERE id=$1 FOR UPDATE → work(repos) → COMMIT`（或 ROLLBACK）。
 * 第二個並行者的 FOR UPDATE 阻塞至第一者 COMMIT，之後才 count → 決策 → 寫入 → 不超賣（G1）。
 */
export type ImmediateRunner = <T>(
  eventId: number,
  work: (repos: TxRepos) => Promise<T>,
) => Promise<T>;

/** 交易收尾：ROLLBACK 為 best-effort（失敗多半連線已斷），保留並向上拋原始錯誤（不吞例外，G6）。 */
async function withTransaction<T>(
  pool: Pool,
  begin: (client: PoolClient) => Promise<void>,
  work: (repos: TxRepos) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await begin(client);
    const result = await work(buildTxRepos(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // ROLLBACK 二次錯誤忽略（保留原始錯誤向上拋，見下）；不吞原始例外。
      void rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 由 Pool 建立 DEFERRED 交易 runner（不鎖 event）。 */
export function createTransactionRunner(pool: Pool): TransactionRunner {
  return <T>(work: (repos: TxRepos) => Promise<T>): Promise<T> =>
    withTransaction(pool, async () => {}, work);
}

/** 由 Pool 建立 FOR UPDATE 交易 runner（先鎖該 event 列，再跑 work）。 */
export function createImmediateRunner(pool: Pool): ImmediateRunner {
  return <T>(eventId: number, work: (repos: TxRepos) => Promise<T>): Promise<T> =>
    withTransaction(
      pool,
      async (client) => {
        await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      },
      work,
    );
}
