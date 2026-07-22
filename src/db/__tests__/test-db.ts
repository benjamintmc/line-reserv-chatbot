import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../index';
import { runMigrations } from '../migrate';
import { UserRepository } from '../repositories/user-repository';
import { EventRepository } from '../repositories/event-repository';
import { RegistrationRepository } from '../repositories/registration-repository';
import { ConversationRepository } from '../repositories/conversation-repository';
import { ProcessedEventRepository } from '../repositories/processed-event-repository';

/** 測試用檔案型 SQLite（含 repository 集合），用完 cleanup 移除臨時目錄。 */
export interface TestDb {
  db: Db;
  path: string;
  dir: string;
  users: UserRepository;
  events: EventRepository;
  registrations: RegistrationRepository;
  conversations: ConversationRepository;
  processed: ProcessedEventRepository;
  reopen(): Db;
  cleanup(): void;
}

/** 建立臨時檔案型 DB、套用 migration、組裝 repository。 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'golf-db-'));
  const path = join(dir, 'test.db');
  let db = openDb(path);
  runMigrations(db);

  const wrap = (): Pick<
    TestDb,
    'users' | 'events' | 'registrations' | 'conversations' | 'processed'
  > => ({
    users: new UserRepository(db),
    events: new EventRepository(db),
    registrations: new RegistrationRepository(db),
    conversations: new ConversationRepository(db),
    processed: new ProcessedEventRepository(db),
  });

  const handle: TestDb = {
    db,
    path,
    dir,
    ...wrap(),
    reopen() {
      if (db.open) db.close();
      db = openDb(path);
      const repos = {
        users: new UserRepository(db),
        events: new EventRepository(db),
        registrations: new RegistrationRepository(db),
        conversations: new ConversationRepository(db),
        processed: new ProcessedEventRepository(db),
      };
      handle.db = db;
      handle.users = repos.users;
      handle.events = repos.events;
      handle.registrations = repos.registrations;
      handle.conversations = repos.conversations;
      handle.processed = repos.processed;
      return db;
    },
    cleanup() {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}

/** 建立一位 user 與一場 open 活動的常用夾具。 */
export function seedEvent(
  t: TestDb,
  opts: { capacity: number; groupId?: string; hostLineId?: string },
): { host: ReturnType<UserRepository['upsert']>; event: ReturnType<EventRepository['create']> } {
  const host = t.users.upsert(opts.hostLineId ?? 'U-host', '主辦人');
  const event = t.events.create({
    groupId: opts.groupId ?? 'G-1',
    hostUserId: host.id,
    eventDate: '2026-08-01',
    eventTime: '07:30',
    location: '林口高球場',
    capacity: opts.capacity,
    status: 'open',
  });
  return { host, event };
}
