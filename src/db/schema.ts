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

/**
 * active 集合（擋團/生命週期）。**0006（D-021 §1）起不再受「同群至多一場」的
 * `ux_events_active_group` 約束**——該索引已 DROP，改由 `ux_events_active_group_venue_time`
 * （同群 active 內場地+時間不得重複）把關（D-008 §1a 的 predicate 語意沿用）。
 * D-008 T-014：`closed` 移出 active 集合——closed 釋放擋團（不再擋新開團），
 * 但名單仍可查（見 {@link DISPLAYABLE_EVENT_STATUSES}）。migration 0003 同步重定義索引 predicate。
 */
export const ACTIVE_EVENT_STATUSES: ReadonlyArray<EventStatus> = ['draft', 'open'];

/**
 * 顯示集（`名單` 查詢用；D-008 §2/OP-4）：含 closed，供關閉報名後仍可查最終名單。
 * 不含 `done`/`cancelled`（done 僅內部釋放槽物化、必被更新 open 取代；cancelled 為終態不顯示）。
 */
export const DISPLAYABLE_EVENT_STATUSES: ReadonlyArray<EventStatus> = ['draft', 'open', 'closed'];

/** events 表列。 */
export interface EventRow {
  id: number;
  group_id: string;
  host_user_id: number;
  /**
   * 活動開始時刻，UTC ISO-8601（`YYYY-MM-DDTHH:MM:SSZ`，秒精度；D-008 §3）。
   * 由台灣本地輸入經 `taipeiToUtcIso` 轉存；顯示時 `utcIsoToTaipei` 還原。與 `nowIso()` 同格式，
   * 字典序 == 時序 → 過期判定 `nowIso() > event_datetime` 可純字串比較（G3，倚 D-001 G11）。
   */
  event_datetime: string;
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
  /** D-013（migration 0004）：與 line_user_id 共同構成 PK，且已 SET NOT NULL ⇒ 不再可能為 null。 */
  group_id: string;
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

/**
 * groups.discovered_via：本列是怎麼被發現的（D-018 §1）。
 * - `join`：收到 LINE 加入群組事件 → `joined_at` 精確。
 * - `message`：功能上線前機器人已在該群（不會再收到 join 事件），由群組訊息首見補登。
 * - `backfill`：migration 0005 自 events 回填 → **`joined_at` 僅為上限估計**，算「加入到首次
 *   開團的間隔」這類指標時必須排除或另行標註。
 */
export type GroupDiscoverySource = 'join' | 'message' | 'backfill';

/** groups 表列（觸及與擴散觀測；D-018）。 */
export interface GroupRow {
  group_id: string;
  /** 群組名稱快照（best-effort）；取不到或未接線時為 null，純供人辨識、不參與任何邏輯。 */
  group_name: string | null;
  /** 機器人加入該群的時間；語意精度依 {@link GroupRow.discovered_via} 而異。 */
  joined_at: string;
  discovered_via: GroupDiscoverySource;
  /** 被移出該群的時間；null = 仍在群。重新加入時清回 null（joined_at 保留首次值）。 */
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

/** schema_migrations 表列（migration 追蹤）。 */
export interface SchemaMigrationRow {
  version: string;
  applied_at: string;
}
