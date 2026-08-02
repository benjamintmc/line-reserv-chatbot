import { createPool, type Pool } from '../index';
import { runMigrations } from '../migrate';
import {
  createTransactionRunner,
  createImmediateRunner,
  type TransactionRunner,
  type ImmediateRunner,
} from '../tx';
import type { EventStatus } from '../schema';
import { UserRepository } from '../repositories/user-repository';
import { EventRepository } from '../repositories/event-repository';
import { RegistrationRepository } from '../repositories/registration-repository';
import { ConversationRepository } from '../repositories/conversation-repository';
import { ProcessedEventRepository } from '../repositories/processed-event-repository';

/**
 * 測試用 Postgres 連線字串（D-007 OP-5，PG-only）。走 env（DATABASE_URL_TEST），
 * 預設對應 docker-compose.yml 的本機 postgres（port 5433）。見 test/setup-env.ts。
 */
const TEST_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://golf:golf@localhost:5433/golf_test';

/**
 * D-008 測試共用固定時刻（UTC ISO；event_datetime 皆用此類值，過期判定不倚賴真實時鐘）：
 * - `FUTURE_ISO`：遠未來 → 未過期（seedEvent 預設；既有 live 行為測試保持綠）。
 * - `PAST_ISO`：已過去 → 過期（過期 open / ended phase 測試用）。
 */
export const FUTURE_ISO = '2999-01-01T00:00:00Z';
export const PAST_ISO = '2000-01-01T00:00:00Z';

/**
 * 測試用 DB handle（含 pool-bound repository 集合與交易 runner）。
 * pool-bound repository 於此以**完整類別**曝露，讓 repository 層單元測試可直接驗讀寫原語；
 * domain 服務測試則透過 runImmediate/runInTransaction 注入 client-bound repos（同 prod 路徑）。
 */
export interface TestDb {
  pool: Pool;
  users: UserRepository;
  events: EventRepository;
  registrations: RegistrationRepository;
  conversations: ConversationRepository;
  processed: ProcessedEventRepository;
  /** 防超賣交易 runner（FOR UPDATE）；work 收 client-bound TxRepos。 */
  runImmediate: ImmediateRunner;
  /** DEFERRED 交易 runner（開團/生命週期）；work 收 client-bound TxRepos。 */
  runInTransaction: TransactionRunner;
  cleanup(): Promise<void>;
}

/** 每個 test file 內只需 migrate 一次（idempotent；docker DB 跨檔共用）。 */
let migrated = false;

/**
 * 建立測試 DB：連 docker postgres、（首次）套用 migration、TRUNCATE 全表回到乾淨狀態
 * （RESTART IDENTITY 使 id 由 1 起，等義 SQLite fresh-db AUTOINCREMENT），組裝 repository + runner。
 */
export async function createTestDb(): Promise<TestDb> {
  const pool = createPool(TEST_URL);

  if (!migrated) {
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
    migrated = true;
  }

  await pool.query(
    'TRUNCATE users, events, registrations, conversation_states, processed_events RESTART IDENTITY CASCADE',
  );

  return {
    pool,
    users: new UserRepository(pool),
    events: new EventRepository(pool),
    registrations: new RegistrationRepository(pool),
    conversations: new ConversationRepository(pool),
    processed: new ProcessedEventRepository(pool),
    runImmediate: createImmediateRunner(pool),
    runInTransaction: createTransactionRunner(pool),
    async cleanup(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * 建立一位 user 與一場 open 活動的常用夾具。
 * D-008：event_datetime 預設 {@link FUTURE_ISO}（未過期 → live）；可傳 `eventDatetime`/`status` 覆寫
 * 以構造過期（PAST_ISO）或 closed 情境。
 */
export async function seedEvent(
  t: TestDb,
  opts: {
    capacity: number;
    groupId?: string;
    hostLineId?: string;
    eventDatetime?: string;
    status?: EventStatus;
  },
): Promise<{
  host: Awaited<ReturnType<UserRepository['upsert']>>;
  event: Awaited<ReturnType<EventRepository['create']>>;
}> {
  const host = await t.users.upsert(opts.hostLineId ?? 'U-host', '主辦人');
  const event = await t.events.create({
    groupId: opts.groupId ?? 'G-1',
    hostUserId: host.id,
    eventDatetime: opts.eventDatetime ?? FUTURE_ISO,
    location: '林口高球場',
    capacity: opts.capacity,
    status: opts.status ?? 'open',
  });
  return { host, event };
}
