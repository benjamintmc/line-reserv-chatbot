/**
 * 各資料表列的 TS 介面（D-001 §9）。**嚴禁 `any`（G4）**。
 * 欄位名為 snake_case 以對映 SQLite 資料列；nullable 欄位以 `| null` 標註。
 */

/** users 表列。 */
export interface UserRow {
  id: number;
  line_user_id: string;
  display_name: string;
  /** 布林以 0/1 表示（SQLite）；MVP 不寫入、不作授權依據（Q1）。 */
  is_host: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** events.status 合法值（D-001 §7 狀態機）。 */
export type EventStatus = 'draft' | 'open' | 'closed' | 'cancelled' | 'done';

/**
 * events.price_mode 合法值（D-005 §1；DB CHECK 強制）。
 * - `per_person`：每人固定價（price_per_person 為金額、venue_fee=NULL）。
 * - `split_venue`：固定場地費總額均攤（venue_fee>0、price_per_person=0；每人金額由應用層 ceil 動態算）。
 */
export type PriceMode = 'per_person' | 'split_venue';

/** active 集合：受 ux_events_active_group 約束（G3）。 */
export const ACTIVE_EVENT_STATUSES: ReadonlyArray<EventStatus> = ['draft', 'open', 'closed'];

/** events 表列。 */
export interface EventRow {
  id: number;
  group_id: string;
  host_user_id: number;
  /** 顯示文字 YYYY-MM-DD（Q2）。 */
  event_date: string;
  /** 顯示文字 HH:MM（Q2）。 */
  event_time: string;
  location: string;
  capacity: number;
  /** 整數新台幣元。split_venue 模式恆為 0（不適用，見 D-005 §1.1）。 */
  price_per_person: number;
  /** 計費模式（D-005 §1）；migration 0002 對既有列 backfill 為 'per_person'。 */
  price_mode: PriceMode;
  /** 場地費總額（元）；split_venue 時 >0、per_person 時 NULL（D-005 §1）。 */
  venue_fee: number | null;
  /** 關閉報名(split)時快照的最終每人攤額（元）；未關閉或 per_person 為 NULL（OP-3）。 */
  settled_per_person: number | null;
  status: EventStatus;
  created_at: string;
  updated_at: string;
}

/** registrations.kind：本人報名 / 代報名。 */
export type RegistrationKind = 'self' | 'proxy';

/** registrations.status：僅表達佇列位置（取消以 cancelled_at 正交表達）。 */
export type RegistrationStatus = 'confirmed' | 'waitlist';

/** registrations 表列（per-slot）。 */
export interface RegistrationRow {
  id: number;
  event_id: number;
  owner_user_id: number;
  /** 報名當下快照；proxy 時為輸入名字（改名不回溯，G5）。 */
  display_name: string;
  kind: RegistrationKind;
  status: RegistrationStatus;
  /** event 內單調遞增序號；取消列仍佔用（G7）。 */
  seq: number;
  /** NULL=有效；非 NULL=已取消（soft-delete 唯一有效性依據，G10）。 */
  cancelled_at: string | null;
  /** 執行取消者（owner 或 host），供稽核。 */
  cancelled_by_user_id: number | null;
  created_at: string;
}

/** conversation_states 表列（逐步開團問答暫存）。 */
export interface ConversationStateRow {
  line_user_id: string;
  group_id: string | null;
  state: string;
  /** 已收集的部分 event 欄位（JSON 字串）。 */
  payload: string | null;
  updated_at: string;
}

/** processed_events 表列（webhook 冪等去重）。 */
export interface ProcessedEventRow {
  message_id: string;
  created_at: string;
}

/** schema_migrations 表列（migration 追蹤）。 */
export interface SchemaMigrationRow {
  version: string;
  applied_at: string;
}
