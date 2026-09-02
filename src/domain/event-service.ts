// src/domain/event-service.ts
//
// D-004 §1–§6 / D-005 §3–§4 / D-006 §1–§2：開團 domain。組合 D-001 repository 原語 + create-flow 純邏輯。
// D-006（授權簡化）：開團全開（無授權，G1）；`關閉報名`/`取消活動` 授權 = canManageEvent
// （event.host_user_id ∪ super-admin，唯讀 getByLineUserId，非授權零副作用，G2）；狀態轉移合法性（G2）、
// 同群 active 查重（D-021 §1：0006 起為場地+時間，G3）、交易 + 去重（G4）、
// host_user_id=建立者（G8）、取消活動不刪 registrations（G6/D-004 G10）。
//
// D-005：`確認` 建立 open event 後於同交易插入主辦第 1 正取（§3、走既有 insertSlot）；
// `關閉報名`(split) 於同交易計算 ceil 最終攤額並持久化 settled_per_person（§4、OP-3）。
//
// D-007 移植：sync→async（呼叫 repo/runner 處加 await）＋路線 A——交易閉包 (repos)=>Promise<T>，
// 閉包**內** this.<repo> 改用注入的 repos.<repo>（同一 client）；閉包**外**唯讀查詢仍用 this.<repo>。
// 窄捕捉改判 PG `23505` + `constraint`（D-021 G8：0006 後為 `ux_events_active_group_venue_time`）。
//
// D-008 T-014（單場名額自動釋放）：
//   - 入口早退放寬為 `active && !isExpired`（過期 open 於入口放行、不 flip，§1b）。
//   - `確認` 交易內、insert 新 open 前：現存 active 若未過期 → already_active（清 conversation，nit-1）；
//     若過期 → updateStatus('done') flip 釋放索引槽，再 insert（原子，§1b/G1）。
//   - `確認` 建立前以 taipeiToUtcIso 合併 draft.date/time → event_datetime（UTC，§3）。
//   - close/cancel 遇過期 open → no_active（不 flip，OP-7/G5）；closed 已釋放 → 不在 active 候選集合內。
//
// D-004 errata（跨群語意，2026-08-18）：continueFlow/confirm/abort 皆先比對
// `conv.group_id === input.groupId`，不同群一律 noop（別群訊息不被當流程答案、不建立活動、
// 不放棄流程）。handler 亦於攔截處同步比對。
//
// D-013 T-022（conversation 以 (group_id, line_user_id) 為 PK）：conversation 的讀／寫／刪一律
// 帶 groupId（`conversations.get(groupId, userId)` / `delete(groupId, userId)`，G2），故同一人在
// 不同群的流程**並行共存**、跨群不可讀由結構保證。上述三道 `conv.group_id` 比對**保留**為縱深
// 防禦與回歸錨點（G3，已成冗餘但零成本）。
//
// 本層**回傳結構化 domain 結果物件（非 LINE 訊息）**，對 LINE SDK 零耦合、可純測。
// 嚴禁 any（D-006 G4）；不得出現 SQL 字串或直接存取 db（D-006 G4）——一律經 repository / tx runner。
// super-admin 集合只認注入的 superAdminUserIds、不讀環境變數（由 server.ts 注入，D-006 G3）。

import { parseCommand } from '../commands';
import type { ConversationStateRow, EventRow, PriceMode } from '../db/schema';
import { GROUPING_STATE } from './grouping-service';
import type { EventReader } from '../db/repositories/event-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ConversationReader } from '../db/repositories/conversation-repository';
import type { ImmediateRunner, TransactionRunner } from '../db/tx';
import { nowIso, taipeiToUtcIso, utcIsoToTaipei } from '../db/time';
import { validateFee } from '../commands/validators';
import type { EditEventField } from '../commands/types';
import { isExpired } from './event-status';
import { perPersonAmount } from './billing';
import { feeLabel } from './event-formatter';
import { canManageEvent as canManageEventAuthz } from './authz';
import {
  applyAnswer,
  FIRST_STATE,
  isComplete,
  parseDraft,
  serializeDraft,
  type CreateEventDraft,
  type CreateState,
} from './create-flow';

// ── 結果物件型別（D-004 §7.1 / D-006 §2；嚴禁 any） ─────────────────────

/**
 * 被新流程覆寫掉的「前一段未完成流程」種類（D-004 errata 跨群，2026-08-18）。
 *
 * D-013 §3（(N2) 收斂）：`'create'` 已移除——查詢鍵改為 `(group_id, line_user_id)` 後，撈回的
 * `prev` **由構造必然同群**，原本判定 `'create'` 的條件（`prev.group_id !== groupId`）恆為 false。
 * `'grouping'` 保留（仍可達）：同群內開團問答與分組 session 仍共用同一列。
 * **刻意不帶來源群資訊**：回覆若能讓讀者判斷前一段流程在哪一群，等同洩漏他群活動的存在（G7）。
 */
export type AbandonedKind = 'grouping';

/** `開團`（一行式 / 逐步）入口結果。D-006：開團全開，移除 not_authorized。 */
export type CreateEntryResult =
  | { kind: 'already_active'; event: EventRow }
  | { kind: 'duplicate' }
  | { kind: 'flow_started'; state: CreateState; abandoned?: AbandonedKind }
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft; abandoned?: AbandonedKind };

/** 一行式格式畸形（invalid create_event）結果。D-006：開團全開，收斂為單一 format_help。 */
export type InvalidOnelineResult = { kind: 'format_help' };

/** 進行中流程收到一則訊息的結果（confirm/abort/答案/重問）。 */
export type ContinueFlowResult =
  | { kind: 'noop' }
  | { kind: 'field_error'; state: CreateState }
  | { kind: 'advanced'; state: CreateState }
  | { kind: 'awaiting_confirm'; draft: CreateEventDraft }
  | { kind: 'confirm_reprompt' }
  | { kind: 'aborted' }
  | { kind: 'created'; event: EventRow }
  | { kind: 'already_active' }
  | { kind: 'duplicate' };

/** `確認`（無流程時 noop）結果。 */
export type ConfirmResult =
  | { kind: 'noop' }
  | { kind: 'duplicate' }
  | { kind: 'already_active' }
  | { kind: 'created'; event: EventRow };

/** `取消`（abort）結果。 */
export type AbortResult = { kind: 'noop' } | { kind: 'duplicate' } | { kind: 'aborted' };

/**
 * `關閉報名`（close_event）結果。
 * D-005 §4：ok 帶 confirmedCount（凍結正取數）與 settledPerPerson（split 最終攤額；per_person 為 null）。
 * D-006：not_authorized（非建立者非 super-admin）於進交易前 early-return。
 * D-008：`already_closed` 因 closed 不在 active 候選集合內 → 不可達（保留供防禦，errata D-004 §5.1）。
 */
export type CloseResult =
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'no_active' }
  | { kind: 'already_closed' }
  | { kind: 'ok'; event: EventRow; confirmedCount: number; settledPerPerson: number | null };

/** `取消活動`（cancel_event）結果。 */
export type CancelResult =
  | { kind: 'not_authorized' }
  | { kind: 'duplicate' }
  | { kind: 'no_active' }
  | { kind: 'ok'; event: EventRow };

// ── D-015 編輯活動資訊（`編輯 日期／時間／場地／費用`） ──────────────────────

/**
 * 單則訊息可帶的 mention 數上限（LINE 平台硬限制）。
 *
 * **官方出處**（AC-13 前置）：LINE Messaging API reference,
 * Text message (v2) → Mention object：「Up to 20 mentions can be substituted in a single message.」
 * <https://developers.line.biz/en/reference/messaging-api/#text-message-v2-mention-object>
 * （同頁另載：mention object 只能用於 reply／push message，且收訊端須為 group/multi-person chat
 *   ——本設計走 reply 回群組，皆滿足。）
 *
 * 註：LINE 官方 SDK（v9.5.0）的 `TextMessageV2.substitution` 由官方 OpenAPI 產生、
 * 為開放 map 無 `maxProperties`，故此上限**無法**由型別強制，必須在應用層自行守住：
 * （此處刻意不寫出 SDK 套件名字面，以免觸發 domain 純度靜態檢查的字串比對——
 *   本檔確實**未** import 任何 LINE SDK 型別，D-004 AC-19／D-005 AC-16／D-006 AC-14）
 * 超限致 reply 400 時 DB 已 COMMIT 且 message.id 已消費 → 使用者看不到成功訊息、重送也不再回覆。
 */
export const MAX_MENTIONS_PER_MESSAGE = 20;

/** 可實際編輯的欄位（`capacity` 不在此集合——人數不可編輯，D-015 §1）。 */
export type EditField = Exclude<EditEventField, 'capacity'>;

/**
 * 編輯請求（D-015 §2）。由 handler 依 parser 結果轉換：
 * `edit_event{field!=capacity}` → `set`；`edit_event{field=capacity}` → `capacity`；
 * `edit_help` → `help`；`invalid{command:'edit_event'}` → `format_error`。
 */
export type EditEventRequest =
  | { kind: 'set'; field: EditField; value: string }
  | { kind: 'capacity' }
  | { kind: 'help' }
  | { kind: 'format_error'; field: 'date' | 'time' | 'location'; detail?: { len: number } };

export interface EditEventInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  request: EditEventRequest;
  /** D-021 §5.1：消歧義解出的目標活動；`undefined` 時沿用既有 `findLatestDisplayable` 回退。 */
  eventId?: number;
}

/**
 * 編輯結果（D-015 §2）。
 *
 * 對 §2 型別表的兩處**唯讀補充**（非行為變更，供 §3 釘死文案取值；已回報 Orchestrator）：
 * - `ok` 增 `confirmedCount`：split 成功句需顯示「目前正取 {K} 人」，K 為正取**列數**，
 *   與去重後的 `tagOwnerIds.length` 不同（同一人可有多列），不可互相替代。
 * - `help` 增 `confirmedCount` 與 `now`：help 的 `{費用列}` 為 `feeLine(event, K, 'live')` 需 K，
 *   範例日期需 now（§2「時鐘由 service 取一次、下傳 formatter」；formatter 不得自取時鐘，G7）。
 */
export type EditEventResult =
  | {
      kind: 'ok';
      field: EditField;
      /** 改前值（date/time 為合併後完整時刻 `YYYY-MM-DD HH:MM`；D-019：費用切換模式時為帶標籤全稱）。 */
      before: string;
      /** 改後值（同上格式）。 */
      after: string;
      /** split_venue 改費用時的**改後**每人攤額（per_person 不帶）。 */
      perPerson?: number;
      /** 有效正取列數（split 成功句的 K）。 */
      confirmedCount: number;
      /** 待 @ 的正取 owner user id（依 seq 首見序、已去重）。 */
      tagOwnerIds: number[];
      /** 超過單則 mention 上限 → 整則退化為無 @ 提醒句（G9）。 */
      overflow: boolean;
      /**
       * D-019 §一.3/§6：`field==='fee'` 且本次編輯切換了 `price_mode`（per_person↔split_venue）
       * 時為 `true`；其餘欄位或費用未切換模式時省略（等同 `false`）。
       */
      feeModeSwitched?: boolean;
    }
  | { kind: 'help'; event: EventRow; confirmedCount: number; now: string }
  | { kind: 'capacity' }
  | { kind: 'format_error'; field: 'date' | 'time' | 'location'; detail?: { len: number } }
  | { kind: 'bad_fee' }
  | { kind: 'past_datetime'; now: string }
  | { kind: 'not_authorized' }
  | { kind: 'no_active' }
  | { kind: 'closed_not_editable' }
  | { kind: 'event_ended' }
  | { kind: 'duplicate' };

// ── 輸入型別 ─────────────────────────────────────────────────────────

export interface StartCreationInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export interface OnelineInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  date: string;
  time: string;
  location: string;
  capacity: number;
  /** per_person 每人金額；split_venue 時為 0（D-005 §6.1）。 */
  price: number;
  /** 計費模式（D-005 §6.1）。 */
  priceMode: PriceMode;
  /** 場地費總額（僅 split_venue 帶值，>0）。 */
  venueFee?: number;
}

export interface ContinueFlowInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  text: string;
  /** confirm 建立時 host_user_id 快照名（handler 以 getGroupMemberProfile 取得，§4 note）。 */
  hostDisplayName: string;
}

export interface ConfirmInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  hostDisplayName: string;
}

export interface AbortInput {
  /** D-004 errata（跨群語意）：只放棄**同一來源群**的進行中流程；別群的 `取消` 一律 noop。 */
  groupId: string;
  executorLineUserId: string;
  messageId: string;
}

export interface LifecycleInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  /**
   * D-021 §5.1：由 handler 層消歧義解出的目標活動（`undefined` = 候選數為 0，
   * 沿用既有「查無 active」分支，行為零改變）。跨群校驗已於 dispatch 層完成（G14），
   * 此處 `getById(eventId)` 不重複比對 `group_id`。
   */
  eventId?: number;
}

export interface EventServiceDeps {
  events: EventReader;
  users: UserRepository;
  conversations: ConversationReader;
  runInTransaction: TransactionRunner;
  /**
   * D-015 §2：`編輯` 的鎖內 read-modify-write 需 `FOR UPDATE`（既有 runner，server.ts 注入）。
   * 選填以維持既有測試/呼叫端零回歸；未注入時呼叫 `editEvent` 會明確拋錯（不靜默降級為無鎖）。
   */
  runImmediate?: ImmediateRunner;
  /** super-admin 集合（來源 env ADMIN_USER_IDS，由 server.ts 注入；跨群安全網、domain 不讀 env，D-006 G3）。 */
  superAdminUserIds: ReadonlyArray<string>;
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * 窄捕捉：判斷 err 是否為「命中 `ux_events_active_group_venue_time`（同群 active 內場地+時間
 * 不得重複）」的 PG 唯一約束違反。PG 錯誤帶 `code` 與 `constraint` 欄：`code==='23505'`
 * （unique_violation）且 `constraint` 為該索引名。結構化型別守衛，不 import pg、不使用 any（G5/G6）。
 *
 * **D-021 G8（窄捕捉限定新索引名）**：0006 已 DROP 舊的 `ux_events_active_group`，本判斷式必須
 * 比對**新**索引名；**不得**改用「任何 `23505` 皆視為重複活動」的寬鬆判斷——那會誤吞其他唯一
 * 索引的違反，掩蓋真正的錯誤。
 */
function isActiveGroupUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === 'ux_events_active_group_venue_time';
}

export class EventService {
  private readonly events: EventReader;
  private readonly users: UserRepository;
  private readonly conversations: ConversationReader;
  private readonly tx: TransactionRunner;
  private readonly runImmediate: ImmediateRunner | undefined;
  private readonly superAdmins: ReadonlySet<string>;
  private readonly logError: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(deps: EventServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.conversations = deps.conversations;
    this.tx = deps.runInTransaction;
    this.runImmediate = deps.runImmediate;
    this.superAdmins = new Set(deps.superAdminUserIds);
    this.logError =
      deps.logError ??
      ((msg, meta): void => {
        console.error(msg, meta ?? {});
      });
  }

  /**
   * D-006 §1.2：生命週期管理授權（`關閉報名`/`取消活動`）。
   * = super-admin（注入，跨群、純 line_user_id 比對、不查 DB）
   *   ∨ 該活動建立者（executor 經**唯讀** getByLineUserId 解析出的 user.id === event.host_user_id）。
   * **唯讀不 upsert**：對非授權者不寫任何 users 列 → 滿足「非授權者無 DB 變更」（G2）。
   */
  private async canManageEvent(event: EventRow, executorLineUserId: string): Promise<boolean> {
    // D-010 nit N1：委派共享謂詞（src/domain/authz.ts），與 registration-service 的 addCapacity 共用。
    return canManageEventAuthz(this.users, this.superAdmins, event, executorLineUserId);
  }

  /**
   * 判定「即將被新流程覆寫的前一段流程」種類（D-004 errata (N2) → D-013 §3 收斂）。
   *
   * 背景：開新流程會 upsert 覆寫同一 `(群, 人)` 的舊列；若靜默吃掉，使用者回頭作答會因
   * `unknown` 而完全無回覆（＝D-004 §3.3 刻意消除過的靜默死角）。故此處偵測、由 handler 附一句告知。
   *
   * **D-013：只剩 `'grouping'` 一種。** 移除 `'create'` 的理由是**構造性**的——查詢鍵已是
   * `(groupId, lineUserId)`，撈回的 `prev` 必然同群，原判定條件 `prev.group_id !== groupId` 恆為 false。
   * （**不是**「handler 已攔截」：handler 的攔截讀在交易外，且 server.ts 以 `Promise.all` 並行處理
   * 同一 webhook body 的多個事件 ⇒ 兩則 `開團` 可同時通過攔截，TOCTOU，不可倚賴。）
   * 同群競態殘留時回 `undefined`（靜默）可接受：使用者就在該視窗、且已收到新流程的提問，無資訊落差；
   * **不得**為求保險改寫成「prev 存在且非 grouping → 告知」（會在並發下產生假告知句，G4）。
   *
   * **必於交易內以 client-bound repos 讀取**（與隨後的 upsert 同連線，避免 TOCTOU）。
   */
  private detectAbandoned(prev: ConversationStateRow | undefined): AbandonedKind | undefined {
    return prev?.state === GROUPING_STATE ? 'grouping' : undefined;
  }

  // ── `開團`（逐步問答入口，§3；D-006 §1.1 開團全開） ──────────────────
  async startCreation(input: StartCreationInput): Promise<CreateEntryResult> {
    // 入口先查（§6 fail fast）：已有**未過期** active（open）→ 拒絕、不寫 conversation。
    // D-008 §1b：過期 open 於入口放行（不 flip、不建立），實際 flip 延至 `確認` 交易。
    //
    // D-021 §1 開團側過渡條文（G1 的明示例外，T-033c 落地 §3 時整段移除）：機械替換為
    // `listActiveByGroup` 取**末列**（`ORDER BY id ASC` ⇒ `.at(-1)` = id 最大者 = 舊
    // `findActiveByGroup` 的 `ORDER BY id DESC LIMIT 1`）。**不得取 `[0]`**（會取到最舊一場，
    // 是靜默行為變更），亦不得抽成共用函式／方法（抽出去就成了 G1 禁止的 wrapper）。
    const actives = await this.events.listActiveByGroup(input.groupId);
    const active = actives.at(-1);
    if (active !== undefined && !isExpired(active, nowIso())) {
      return { kind: 'already_active', event: active };
    }

    return this.tx<CreateEntryResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      // errata（跨群）：upsert 前先看有無將被覆寫的舊流程，供 handler 附告知句（消除靜默死角）。
      const abandoned = this.detectAbandoned(
        await repos.conversations.get(input.groupId, input.executorLineUserId),
      );
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: FIRST_STATE,
        payload: serializeDraft({}),
      });
      return {
        kind: 'flow_started',
        state: FIRST_STATE,
        ...(abandoned !== undefined ? { abandoned } : {}),
      };
    });
  }

  // ── `開團 <欄位…>`（一行式入口，§2 / D-005 §6.1；D-006 §1.1 開團全開） ──
  async handleOneline(input: OnelineInput): Promise<CreateEntryResult> {
    // D-021 §1 開團側過渡條文（同 startCreation：取末列、不得取 [0]、不得抽共用函式）。
    const actives = await this.events.listActiveByGroup(input.groupId);
    const active = actives.at(-1);
    if (active !== undefined && !isExpired(active, nowIso())) {
      return { kind: 'already_active', event: active };
    }

    const draft: CreateEventDraft = {
      date: input.date,
      time: input.time,
      location: input.location,
      capacity: input.capacity,
      price: input.price,
      priceMode: input.priceMode,
      ...(input.venueFee !== undefined ? { venueFee: input.venueFee } : {}),
    };

    return this.tx<CreateEntryResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      // errata（跨群）：同 startCreation——一行式亦會覆寫舊列，須告知。
      const abandoned = this.detectAbandoned(
        await repos.conversations.get(input.groupId, input.executorLineUserId),
      );
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: 'awaiting_confirm',
        payload: serializeDraft(draft),
      });
      return {
        kind: 'awaiting_confirm',
        draft,
        ...(abandoned !== undefined ? { abandoned } : {}),
      };
    });
  }

  // ── invalid（create_event 格式畸形；§9 (K′)；D-006 §1.1 開團全開，恆回 format_help） ──
  handleInvalidOneline(): InvalidOnelineResult {
    // 純引導、無 DB 副作用、不 mark（§9 註）。開團全開 → 無授權分支。
    return { kind: 'format_help' };
  }

  // ── 進行中流程的一則訊息（§3.3/§3.4） ─────────────────────────────
  async continueFlow(input: ContinueFlowInput): Promise<ContinueFlowResult> {
    const conv = await this.conversations.get(input.groupId, input.executorLineUserId);
    if (conv === undefined) return { kind: 'noop' }; // 安全網（handler 已先攔截存在者）
    // D-004 errata（跨群語意，2026-08-18）：只有**流程發生的那個群**的訊息才是流程答案；
    // 別群訊息 → noop（不前進、不寫、不 mark）。
    // D-013 G3：查詢鍵已含 group_id 使本比對恆成立（冗餘），仍**保留**為縱深防禦與回歸錨點。
    if (conv.group_id !== input.groupId) return { kind: 'noop' };

    const cmd = parseCommand(input.text);

    // `取消`（abort）：任一 state 皆放棄流程（§3.4）。
    if (cmd.type === 'abort') {
      const r = await this.abort({
        groupId: input.groupId,
        executorLineUserId: input.executorLineUserId,
        messageId: input.messageId,
      });
      if (r.kind === 'aborted') return { kind: 'aborted' };
      if (r.kind === 'duplicate') return { kind: 'duplicate' };
      return { kind: 'noop' };
    }

    const state = conv.state as CreateState;

    if (state === 'awaiting_confirm') {
      // `確認` → 建立；其餘非 確認/取消 → 重新提示 (M)，停留、不建立（B2/§3.3）。
      if (cmd.type === 'confirm') {
        const r = await this.confirm({
          groupId: input.groupId,
          executorLineUserId: input.executorLineUserId,
          messageId: input.messageId,
          hostDisplayName: input.hostDisplayName,
        });
        if (r.kind === 'created') return { kind: 'created', event: r.event };
        if (r.kind === 'already_active') return { kind: 'already_active' };
        if (r.kind === 'duplicate') return { kind: 'duplicate' };
        return { kind: 'noop' };
      }
      return { kind: 'confirm_reprompt' };
    }

    // 其餘 state：整串 text 當該欄答案（含使用者恰好輸入 `確認` → 多半格式錯重問）。
    const draft = parseDraft(conv.payload);
    const applied = applyAnswer(state, draft, input.text);
    if (!applied.ok) {
      // 欄位錯：停留同一 state、不前進、不 INSERT、不 mark（§3.2）。
      return { kind: 'field_error', state: applied.state };
    }

    // 前進一步（有 DB 副作用 → 交易內 markProcessed 首步，去重 AC-14）。
    return this.tx<ContinueFlowResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      await repos.conversations.upsert({
        lineUserId: input.executorLineUserId,
        groupId: input.groupId,
        state: applied.nextState,
        payload: serializeDraft(applied.payload),
      });
      if (applied.nextState === 'awaiting_confirm') {
        return { kind: 'awaiting_confirm', draft: applied.payload };
      }
      return { kind: 'advanced', state: applied.nextState };
    });
  }

  // ── `確認` 建立 open event + 主辦自動登記（§4 / D-005 §3 / D-008 §1b/§3） ───────────
  async confirm(input: ConfirmInput): Promise<ConfirmResult> {
    const conv = await this.conversations.get(input.groupId, input.executorLineUserId);
    if (conv === undefined || conv.state !== 'awaiting_confirm') return { kind: 'noop' };
    // D-004 errata（跨群語意）：draft 屬於 conv.group_id 那一群，**不得**因別群的 `確認` 而在別群建立活動。
    // D-013 G3：保留為縱深防禦（查詢鍵已含 group_id）。
    if (conv.group_id !== input.groupId) return { kind: 'noop' };
    const draft = parseDraft(conv.payload);
    if (!isComplete(draft)) return { kind: 'noop' }; // 欄位不齊不建立（AC-20）

    try {
      return await this.tx<ConfirmResult>(async (repos) => {
        if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };

        // G3 入口再確認（交易內權威重讀）。D-008 §1b：
        //   未過期 active → already_active（清 conversation，nit-1）；
        //   過期 open → flip done（釋放索引槽），再於同交易 insert 新 open（原子，G1）。
        // D-021 §1 開團側過渡條文（同 startCreation：取末列、不得取 [0]、不得抽共用函式）。
        const actives = await repos.events.listActiveByGroup(input.groupId);
        const active = actives.at(-1);
        if (active !== undefined) {
          if (!isExpired(active, nowIso())) {
            await repos.conversations.delete(input.groupId, input.executorLineUserId);
            return { kind: 'already_active' };
          }
          await repos.events.updateStatus(active.id, 'done');
        }

        // G8：host_user_id = 建立者（任一群成員，D-006 開團全開）的 user.id。
        const host = await repos.users.upsert(input.executorLineUserId, input.hostDisplayName);

        // D-008 §3：台灣本地 draft.date/time → UTC event_datetime（一行式與逐步問答皆匯流至此）。
        const eventDatetime = taipeiToUtcIso(draft.date, draft.time);

        // 真正安全網：INSERT 撞 ux_events_active_group_venue_time（並行競態）。PG 下唯一違反會 abort 整個交易，
        // 故此處**不** catch-and-continue；讓錯誤逸出 → 交易 runner ROLLBACK + rethrow → 由下方 catch
        // 於**另一交易**清落敗者流程（nit-2）並回 already_active。
        const event = await repos.events.create({
          groupId: input.groupId,
          hostUserId: host.id,
          eventDatetime,
          location: draft.location,
          capacity: draft.capacity,
          pricePerPerson: draft.price,
          priceMode: draft.priceMode,
          venueFee: draft.venueFee,
          status: 'open',
        });

        // D-005 §3：主辦自動登記為第 1 正取（名單第 1 位；均攤分母天然 >=1）。
        // 走既有 per-slot 交易原語 insertSlot（G3，不繞過）；此 DEFERRED 交易內 event 尚未 COMMIT、
        // 無並行 signup 可觀察 → 無超賣風險（G2 carve-out，ADR-004）。空 event → seq=1。
        await repos.registrations.insertSlot({
          eventId: event.id,
          ownerUserId: host.id,
          displayName: input.hostDisplayName,
          kind: 'self',
          status: 'confirmed',
        });

        await repos.conversations.delete(input.groupId, input.executorLineUserId);
        return { kind: 'created', event };
      });
    } catch (err) {
      // G3 窄捕捉：僅命中 ux_events_active_group_venue_time 的 UNIQUE → already_active；其餘一律 re-throw。
      if (!isActiveGroupUniqueViolation(err)) throw err;
      // 落敗者：上方交易已整批 ROLLBACK（含 markProcessed）。另起交易清落敗者流程，不卡 awaiting_confirm（nit-2）。
      await this.tx(async (repos) => {
        await repos.conversations.delete(input.groupId, input.executorLineUserId);
        return undefined;
      });
      return { kind: 'already_active' };
    }
  }

  // ── `取消`（abort，§3.4） ─────────────────────────────────────────
  async abort(input: AbortInput): Promise<AbortResult> {
    const conv = await this.conversations.get(input.groupId, input.executorLineUserId);
    if (conv === undefined) return { kind: 'noop' }; // 無流程 → 靜默 no-op（G9）
    // D-004 errata（跨群語意）：別群的 `取消` 不得放棄本人在他群的流程 → 靜默 noop。
    // D-013 G3：保留為縱深防禦（查詢鍵已含 group_id）。
    if (conv.group_id !== input.groupId) return { kind: 'noop' };

    return this.tx<AbortResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      await repos.conversations.delete(input.groupId, input.executorLineUserId);
      return { kind: 'aborted' };
    });
  }

  // ── `關閉報名`（close_event，§5.2 / D-005 §4 / D-006 §1.2·§2 / D-008 OP-7） ───────
  async closeEvent(input: LifecycleInput): Promise<CloseResult> {
    // D-006 §2：授權需先讀 active 取 host_user_id → no_active 與 not_authorized 皆於**進交易前**
    // early-return（不 mark、無 DB 變更，G2）。
    // D-008 OP-7：過期 open → no_active、不 flip（讀寫最小，reads 不寫，G5）。
    //
    // D-021 §5.1：查詢方式由 `findActiveByGroup(groupId)` 換成 `getById(eventId)`（eventId 由
    // handler 消歧義解出）；`undefined` = 候選數 0 → 沿用既有「查無 active」分支。
    // **雙層授權模式維持不變**：交易外 early-return 授權檢查 + 交易內 `FOR UPDATE` 權威重讀，
    // 兩次查詢都保留，不得因為改成 getById 就合併成一次（TOCTOU 防護）。
    const eventId = input.eventId;
    if (eventId === undefined) return { kind: 'no_active' };
    const active0 = await this.events.getById(eventId);
    if (active0 === undefined) return { kind: 'no_active' };
    if (isExpired(active0, nowIso())) return { kind: 'no_active' };
    if (!(await this.canManageEvent(active0, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }

    return this.tx<CloseResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      const active = await repos.events.getById(eventId); // 交易內權威重讀（D-004 §5.2）
      if (active === undefined) return { kind: 'no_active' };
      if (isExpired(active, nowIso())) return { kind: 'no_active' }; // 交易內重檢（OP-7）
      if (active.status === 'closed') return { kind: 'already_closed' }; // D-008：不可達（防禦保留）
      if (active.status !== 'open') return { kind: 'no_active' }; // draft 未物化，其餘非法
      // G2：open → closed（讀當前 status 判定合法後才寫）。
      await repos.events.updateStatus(active.id, 'closed');

      // D-005 §4：凍結正取數（有效正取），split 計算並持久化最終攤額。
      const confirmedCount = await repos.registrations.countConfirmed(active.id);
      const closed: EventRow = { ...active, status: 'closed' };
      if (active.price_mode === 'split_venue') {
        // ceil + 分母 max(,1)（perPersonAmount 已保底）。同交易寫 settled_per_person（OP-3）。
        const settled = perPersonAmount(closed, confirmedCount);
        await repos.events.updateSettledPerPerson(active.id, settled);
        return {
          kind: 'ok',
          event: { ...closed, settled_per_person: settled },
          confirmedCount,
          settledPerPerson: settled,
        };
      }
      // per_person：不寫 settled_per_person（維持 NULL），不附結算列（AC-8）。
      return { kind: 'ok', event: closed, confirmedCount, settledPerPerson: null };
    });
  }

  // ── `取消活動`（cancel_event，§5.2；刪除類 R2 / D-006 §1.2·§2 / D-008 OP-7） ──────
  async cancelEvent(input: LifecycleInput): Promise<CancelResult> {
    // D-006 §2：授權於進交易前判定（不 mark、無 DB 變更，G2）。
    // D-008 OP-7：過期 open → no_active、不 flip。
    // D-021 §5.1：同 closeEvent——改讀 `getById(eventId)`，雙層（交易外 + 交易內 FOR UPDATE）
    // 兩次查詢皆保留，不得合併（TOCTOU 防護）。
    const eventId = input.eventId;
    if (eventId === undefined) return { kind: 'no_active' };
    const active0 = await this.events.getById(eventId);
    if (active0 === undefined) return { kind: 'no_active' };
    if (isExpired(active0, nowIso())) return { kind: 'no_active' };
    if (!(await this.canManageEvent(active0, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }

    return this.tx<CancelResult>(async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
      const active = await repos.events.getById(eventId); // 交易內權威重讀
      if (active === undefined) return { kind: 'no_active' };
      if (isExpired(active, nowIso())) return { kind: 'no_active' }; // 交易內重檢（OP-7）
      // open 可取消；draft 未物化（closed 不在 active 候選集合內，此處為防禦）。
      if (active.status !== 'open' && active.status !== 'closed') return { kind: 'no_active' };
      // G2：open → cancelled（終態）。G6：僅狀態轉移，不刪 registrations。
      await repos.events.updateStatus(active.id, 'cancelled');
      return { kind: 'ok', event: { ...active, status: 'cancelled' } };
    });
  }

  // ── `編輯 日期／時間／場地／費用`（D-015 §2；R2 鎖內 read-modify-write） ──────────
  //
  // 與 close/cancel 的差異（刻意，且已由 D-015 明文界定 D-006 §2/G2 與 D-010 §二/G4 的適用範圍）：
  //   1. 授權判定改**在鎖內**做——`canManageEvent` 的輸入 `fresh` 必須是鎖內權威重讀值（G1），
  //      交易外唯讀查詢的快照只用來取 `id` 當鎖鍵，其欄位不得作任何決策輸入。
  //   2. **拒絕回覆一律消費 message.id**（CLAUDE.md §4 去重政策）：`markProcessed` 是交易第一步，
  //      置於所有拒絕 early-return 之前（G5）。非授權者仍**不得** upsert users（唯讀解析，G4）。
  async editEvent(input: EditEventInput): Promise<EditEventResult> {
    const runImmediate = this.runImmediate;
    if (runImmediate === undefined) {
      // 不靜默降級為無鎖交易（無鎖等於失去 read-modify-write 的正確性，G1）。
      throw new Error('EventService.editEvent 需要注入 runImmediate（D-015 §2）');
    }
    // §2：時鐘由 service 取一次，下傳過期判定、past_datetime 與 formatter（G7 formatter 不自取時鐘）。
    const now = nowIso();

    // 交易外唯讀：**僅**用於取 id 當鎖鍵。取 id 後該列若被並行 flip，鎖內重讀會回 no_active
    // （窄競態、良性，刻意不加補償邏輯，N10）。
    // D-021 §5.1：改讀 `getById(eventId)`；`undefined`（候選數 0）沿用下方既有 (B) 分支——
    // editEvent 原邏輯本就只在 0 候選時查 closed，不受 D-022 §5.4 那個 bug 影響。
    const candidate =
      input.eventId === undefined ? undefined : await this.events.getById(input.eventId);

    // (B) 無候選活動（含 closed 已離開 active 集）→ 仍須消費 message.id（G5）。
    if (candidate === undefined) {
      return this.tx<EditEventResult>(async (repos) => {
        if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };
        const latest = await repos.events.findLatestDisplayable(input.groupId);
        if (latest !== undefined && latest.status === 'closed') {
          return { kind: 'closed_not_editable' };
        }
        return { kind: 'no_active' };
      });
    }

    // (A) 有候選活動 → FOR UPDATE 鎖住該列後才做任何判定與寫入。
    return runImmediate<EditEventResult>(candidate.id, async (repos) => {
      // 1. 去重為第一步，且在所有拒絕 early-return 之前（G5）。
      if (!(await repos.processed.markProcessed(input.messageId))) return { kind: 'duplicate' };

      // 2. 鎖內權威重讀：改前值與所有狀態/過期判定的**唯一**來源（G1）。
      const fresh = await repos.events.getById(candidate.id);
      if (fresh === undefined) return { kind: 'no_active' };
      if (fresh.status === 'closed') return { kind: 'closed_not_editable' };
      if (fresh.status !== 'open') return { kind: 'no_active' };
      if (isExpired(fresh, now)) return { kind: 'event_ended' };

      // 3. 授權：共用謂詞（唯讀 getByLineUserId，不 upsert users；G4）。
      if (!(await canManageEventAuthz(repos.users, this.superAdmins, fresh, input.executorLineUserId))) {
        return { kind: 'not_authorized' };
      }

      // 4. 三條唯讀分派（已 mark、無 UPDATE）。仍走同一個 FOR UPDATE 入口：
      //    統一入口的可維護性優先於省一次列鎖（刻意取捨，N9）。
      const req = input.request;
      if (req.kind === 'capacity') return { kind: 'capacity' };
      if (req.kind === 'format_error') {
        return req.detail === undefined
          ? { kind: 'format_error', field: req.field }
          : { kind: 'format_error', field: req.field, detail: req.detail };
      }
      if (req.kind === 'help') {
        return {
          kind: 'help',
          event: fresh,
          confirmedCount: await repos.registrations.countConfirmed(fresh.id),
          now,
        };
      }

      // 5. set：改前值一律取自 fresh。
      //    鎖內只取該 event 的 confirmed 列一次——K（正取列數）與 tagOwnerIds（去重 owner）共用；
      //    等價於 countConfirmed()（同一 WHERE 述詞、同一交易快照），少一次鎖內查詢（N5 精神）。
      const confirmedRows = await repos.registrations.listConfirmed(fresh.id);
      const confirmedCount = confirmedRows.length;
      // owner_user_id 去重（同一人只 tag 一次；依 seq 首見序，listConfirmed 已 ORDER BY seq）。
      const tagOwnerIds = [...new Set(confirmedRows.map((r) => r.owner_user_id))];
      // overflow 於解析 line_user_id **之前**判定（可能高估 → 偏向退化，N-b 釘死，不留第二種算法）。
      const overflow = tagOwnerIds.length > MAX_MENTIONS_PER_MESSAGE;

      let before: string;
      let after: string;
      let perPerson: number | undefined;
      let feeModeSwitched: boolean | undefined;

      switch (req.field) {
        case 'date':
        case 'time': {
          // 日期與時間共用 event_datetime：拆本地 → 只換被編輯的半邊 → 合回 UTC（另一半原樣保留）。
          const cur = utcIsoToTaipei(fresh.event_datetime);
          const next =
            req.field === 'date'
              ? { date: req.value, time: cur.time }
              : { date: cur.date, time: req.value };
          const newIso = taipeiToUtcIso(next.date, next.time);
          // G3：不得存在任何可寫入 event_datetime <= now 的分支（同一注入時鐘、UTC ISO 字串比較）。
          if (newIso <= now) return { kind: 'past_datetime', now };
          await repos.events.updateEventDatetime(fresh.id, newIso);
          // 成功句恆顯示合併後完整時刻，讓使用者確認另一半沒被動到（§3，刻意設計）。
          before = `${cur.date} ${cur.time}`;
          after = `${next.date} ${next.time}`;
          break;
        }
        case 'location': {
          await repos.events.updateLocation(fresh.id, req.value);
          before = fresh.location;
          after = req.value;
          break;
        }
        case 'fee': {
          // D-019 §一.3：G3（複用 validateFee，不得另寫驗證）——費用值解析與模式判定一律呼叫
          // validateFee（同開團一行式）；bad_fee 純粹由 validateFee 回傳 ok:false 決定，
          // 不得讀取 fresh.price_mode（G4，與現有模式解耦）。
          const r = validateFee(req.value);
          if (!r.ok) return { kind: 'bad_fee' };
          const { mode, amount } = r.value;
          const pricePerPerson = mode === 'split_venue' ? 0 : amount;
          const venueFee = mode === 'split_venue' ? amount : null;
          // G2：三欄（price_mode/price_per_person/venue_fee）單一 UPDATE 原子寫入，
          // 不論是否切換模式皆用此原語（同模式改價＝兩欄不變、一欄變，仍走同一 UPDATE）。
          await repos.events.updateBilling(fresh.id, { priceMode: mode, pricePerPerson, venueFee });
          const switched = mode !== fresh.price_mode;
          const oldAmount = fresh.price_mode === 'split_venue' ? fresh.venue_fee ?? 0 : fresh.price_per_person;
          // 未切換：維持 D-015 原樣裸數字（回歸零風險）；切換：改用帶標籤全稱，左右標籤對稱。
          before = switched ? feeLabel(fresh.price_mode, oldAmount) : String(oldAmount);
          after = switched ? feeLabel(mode, amount) : String(amount);
          if (mode === 'split_venue') {
            // N6：新攤額必須以**改後**值算（不得用 fresh.venue_fee）。
            perPerson = perPersonAmount({ ...fresh, price_mode: mode, venue_fee: amount }, confirmedCount);
          }
          feeModeSwitched = switched;
          break;
        }
        default: {
          const _exhaustive: never = req;
          return _exhaustive;
        }
      }

      // 6. 回結果即 COMMIT。`users.getById` 解析 line_user_id／顯示名於**交易外**進行
      //    （比照 buildPromotionNotice／renderAddCapacity），不得在鎖內做 N+1 查詢延長鎖期（N5/G9）。
      return {
        kind: 'ok',
        field: req.field,
        before,
        after,
        ...(perPerson !== undefined ? { perPerson } : {}),
        confirmedCount,
        tagOwnerIds,
        overflow,
        ...(feeModeSwitched !== undefined ? { feeModeSwitched } : {}),
      };
    });
  }
}
