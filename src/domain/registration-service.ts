// src/domain/registration-service.ts
//
// D-003 §2/§3/§5：報名核心 domain。組合 D-001 repository 原語完成
// 額滿判斷（G1 整批候補）、FIFO 遞補（G8）、soft-delete（G3）、
// 代取消授權（G4）、去重（G7 markProcessed 為交易第一步）。
//
// D-007 移植：sync→async（呼叫處加 await）＋路線 A——防超賣交易改注入 `runImmediate`
// 交易 runner（取代 SQLite 版 this.registrations.runImmediate）；交易閉包簽名 (repos)=>Promise<T>，
// 閉包**內** this.<repo> 改用注入的 repos.<repo>（同一 client，G1）；閉包**外**唯讀查詢仍用 this.<repo>。
// 商業分支/決策規則/AC 期望值零改。
//
// D-003 B1 修（T-012 sync→async 激活的 cancel 遞補超賣競態）：cancel 的 `freedConfirmed`
// 一律由**鎖內實際取消的 confirmed 列數**（`cancelByIds` 之 RETURNING）得出，取代交易外快照
// `toCancel.filter(...)`。SQLite 同步版無此窗（定位+runImmediate 單執行緒原子）；async 兩 await
// 間插讓點後，同列被兩則不同 messageId 的 cancel 鎖定時，舊快照會令第二者多遞補 → 超賣（破 G8）。詳見 D-003 §3 errata。
//
// D-008 T-014（單場名額自動釋放；D-003 errata §五）：
//   - `findOpenEvent` **拆分**為 `findOpenEventForSignup`（open ∧ 未過期，否則 event_ended/no_open_event）
//     與 `findEventForDisplay`（用 `findLatestDisplayable`，顯示集 {draft,open,closed}，回 phase）。
//   - signup/cancel 新增 `event_ended` 結果；`runImmediate` **鎖內以 getById(event.id) 重讀最新列** re-check
//     status/過期（**非** stale 快照，nit-2/AC-9）→ 過期/被 flip → event_ended、不插槽。
//   - `getListView` 帶 `phase`（live/ended/closed），供 formatter 選標題/費用列。
//
// 本層**回傳結構化 domain 結果物件（非 LINE 訊息）**，對 LINE SDK 零耦合、可純測。
// 嚴禁 any（G11）；不得出現 SQL 字串或直接存取 db（G10）——一律經 repository 原語 / 交易 runner。

import {
  DISPLAYABLE_EVENT_STATUSES,
  type EventRow,
  type RegistrationRow,
  type RegistrationStatus,
} from '../db/schema';
import type { EventReader } from '../db/repositories/event-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ProcessedEventRepository } from '../db/repositories/processed-event-repository';
import type { RegistrationReader } from '../db/repositories/registration-repository';
import type { ImmediateRunner, TxRepos } from '../db/tx';
import { nowIso } from '../db/time';
import { displayPhase, isExpired, isOpenForSignup, type ListPhase } from './event-status';
import { canManageEvent } from './authz';
import { MAX_CAPACITY } from '../commands';

export type { ListPhase } from './event-status';

/** 名單快照視圖（D-003 §1.1）。 */
export interface RegistrationView {
  event: EventRow;
  /** 有效正取列（依 seq）。 */
  confirmed: RegistrationRow[];
  /** 有效候補列（依 seq）。 */
  waitlist: RegistrationRow[];
  /** = confirmed.length（有效正取數）。 */
  confirmedCount: number;
  /** = max(0, capacity − confirmedCount)。 */
  available: number;
}

/** `+N` 報名結果（D-003 §1.1；D-008：新增 event_ended）。 */
export type SignupResult =
  | { kind: 'no_open_event' }
  | { kind: 'event_ended' }
  | { kind: 'duplicate' }
  | {
      kind: 'ok';
      outcome: 'confirmed' | 'waitlisted';
      /** 本次請求人數 N。 */
      requested: number;
      /** 回覆稱謂＝被報名者顯示名（自報名為傳訊人快照；代報名為輸入名字）。 */
      subjectDisplayName: string;
      /** 本批新插入列（候補時用於推算候補序位）。 */
      newSlots: RegistrationRow[];
      view: RegistrationView;
    };

/** `-N` 取消結果（D-003 §1.1；D-008：新增 event_ended）。 */
export type CancelResult =
  | { kind: 'no_open_event' }
  | { kind: 'event_ended' }
  | { kind: 'duplicate' }
  | { kind: 'nothing_to_cancel' }
  | {
      kind: 'ok';
      /** 實際取消列數。 */
      cancelled: number;
      /** 本次請求人數 N。 */
      requested: number;
      /** 回覆稱謂＝被取消者顯示名（自取消為傳訊人；代取消為輸入名字）。 */
      subjectDisplayName: string;
      /** 被遞補列（供 @ 通知；空陣列表示未觸發遞補）。 */
      promoted: RegistrationRow[];
      view: RegistrationView;
    };

/** `名單` 查詢結果（D-003 §1.1；`duplicate` 為 §5 唯讀去重；D-008：ok 帶 phase）。 */
export type ListResult =
  | { kind: 'no_open_event' }
  | { kind: 'duplicate' }
  | { kind: 'ok'; view: RegistrationView; phase: ListPhase };

/** `加開 N` 結果（D-010 §一）。 */
export type AddCapacityResult =
  | { kind: 'no_open_event' }
  | { kind: 'event_ended' }
  | { kind: 'not_authorized' }
  | { kind: 'over_limit' }
  | { kind: 'duplicate' }
  | {
      kind: 'ok';
      /** 本次加開的名額數（=input.count）。 */
      added: number;
      /** 加開後的新容量（fresh.capacity + added）。 */
      newCapacity: number;
      /** 因加開而立即遞補的候補列（供同一則 @ 通知；空陣列＝未遞補）。 */
      promoted: RegistrationRow[];
      view: RegistrationView;
    };

export interface SignupInput {
  groupId: string;
  /** 傳訊人 LINE userId。 */
  executorLineUserId: string;
  /** 傳訊人顯示名快照（handler 以 getGroupMemberProfile 取得；NFR-4）。 */
  executorDisplayName: string;
  messageId: string;
  count: number;
  proxyName?: string;
  /**
   * D-021 §5.1：由 handler 層消歧義解出的目標活動（`undefined` = 候選數為 0，沿用既有
   * `no_open_event` 分支，行為零改變）。跨群校驗已於 dispatch 層完成（G14），
   * 此處 `getById(eventId)` 不重複比對 `group_id`。
   */
  eventId?: number;
}

export interface CancelInput {
  groupId: string;
  executorLineUserId: string;
  executorDisplayName: string;
  messageId: string;
  count: number;
  proxyName?: string;
  /**
   * D-021 §5.1：由 handler 層消歧義解出的目標活動（`undefined` = 候選數為 0，沿用既有
   * `no_open_event` 分支，行為零改變）。跨群校驗已於 dispatch 層完成（G14），
   * 此處 `getById(eventId)` 不重複比對 `group_id`。
   */
  eventId?: number;
}

export interface ListInput {
  groupId: string;
  messageId: string;
  /**
   * D-021 §5.1／D-022 §5.4：消歧義解出的目標活動。**不可與其他 Input 統一處理**——
   * `undefined`（＝候選數 0）時才退回 `findLatestDisplayable`，見 `findEventForDisplay`（G9）。
   */
  eventId?: number;
}

export interface AddCapacityInput {
  groupId: string;
  executorLineUserId: string;
  messageId: string;
  /** 加開名額數（新增量；parser 已保證 1..MAX_COUNT）。 */
  count: number;
  /**
   * D-021 §5.1：由 handler 層消歧義解出的目標活動（`undefined` = 候選數為 0，沿用既有
   * `no_open_event` 分支，行為零改變）。跨群校驗已於 dispatch 層完成（G14），
   * 此處 `getById(eventId)` 不重複比對 `group_id`。
   */
  eventId?: number;
}

export interface RegistrationServiceDeps {
  events: EventReader;
  users: UserRepository;
  registrations: RegistrationReader;
  processed: ProcessedEventRepository;
  /** 防超賣交易 runner（路線 A）：BEGIN → SELECT event FOR UPDATE → work(repos) → COMMIT（D-007 §3）。 */
  runImmediate: ImmediateRunner;
  /**
   * super-admin 集合（來源 env ADMIN_USER_IDS，由 server.ts 注入；D-006 G3）。
   * 僅供 `加開 N` 授權（canManageEvent = host ∪ super-admin，D-010 §一.2）；未注入視為空集。
   */
  superAdminUserIds?: ReadonlyArray<string>;
  /** 不預期發生的異常記錄（如遞補守恆斷言失敗）；預設 console.error。 */
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** signup 用「可報名事件」解析（D-008：拆自 findOpenEvent）。 */
type SignupEventResolution =
  | { kind: 'ok'; event: EventRow }
  | { kind: 'event_ended' }
  | { kind: 'no_open_event' };

/** 交易內回傳型別（signup；D-008 新增 event_ended 為鎖內 re-check 結果）。 */
type TxSignup =
  | { kind: 'duplicate' }
  | { kind: 'event_ended' }
  | { kind: 'ok'; outcome: RegistrationStatus; newSlots: RegistrationRow[] };

/** 交易內回傳型別（cancel；D-008 新增 event_ended）。 */
type TxCancel =
  | { kind: 'duplicate' }
  | { kind: 'event_ended' }
  | { kind: 'ok'; cancelled: number; promoted: RegistrationRow[] };

/** 交易內回傳型別（addCapacity；D-010 §一.3 鎖內 re-check + over_limit）。 */
type TxAddCapacity =
  | { kind: 'duplicate' }
  | { kind: 'event_ended' }
  | { kind: 'over_limit' }
  | { kind: 'ok'; newCapacity: number; promoted: RegistrationRow[] };

export class RegistrationService {
  private readonly events: EventReader;
  private readonly users: UserRepository;
  private readonly registrations: RegistrationReader;
  private readonly processed: ProcessedEventRepository;
  private readonly runImmediate: ImmediateRunner;
  private readonly superAdmins: ReadonlySet<string>;
  private readonly logError: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(deps: RegistrationServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.registrations = deps.registrations;
    this.processed = deps.processed;
    this.runImmediate = deps.runImmediate;
    this.superAdmins = new Set(deps.superAdminUserIds ?? []);
    this.logError =
      deps.logError ??
      ((msg, meta): void => {
        console.error(msg, meta ?? {});
      });
  }

  /**
   * 報名用（`+N`/`-N`）：取消歧義解出的目標事件並判可報名性（open ∧ 未過期，D-008 §2）。
   * - open ∧ 未過期 → `{ ok, event }`；
   * - open ∧ 已過期 → `{ event_ended }`（活動已結束，拒報名/取消，OP-2）；
   * - `eventId === undefined`（候選數 0）／查無／draft（未物化）→ `{ no_open_event }`。
   *
   * D-021 §5.1：由 `findActiveByGroup(groupId)` 改吃 `eventId`（handler 消歧義解出）。
   */
  private async findOpenEventForSignup(
    eventId: number | undefined,
  ): Promise<SignupEventResolution> {
    const event = eventId === undefined ? undefined : await this.events.getById(eventId);
    if (event === undefined) return { kind: 'no_open_event' };
    const now = nowIso();
    if (isOpenForSignup(event, now)) return { kind: 'ok', event };
    if (event.status === 'open' && isExpired(event, now)) return { kind: 'event_ended' };
    return { kind: 'no_open_event' };
  }

  /**
   * 顯示用（`名單`）：候選數 >=1 → 用消歧義解出的那場；候選數 0 → 才退回最新一場可顯示活動
   * （{draft,open,closed} latest-by-id，D-008 §2/OP-4）+ phase。
   * 兩條路徑都只顯示 {draft,open,closed}；cancelled/done → undefined（no_open_event）。
   */
  private async findEventForDisplay(
    eventId: number | undefined,
    groupId: string,
  ): Promise<{ event: EventRow; phase: ListPhase } | undefined> {
    // D-022 §5.4 / G9：候選數 >= 1（dispatch 已跑完消歧義 ⇒ eventId !== undefined）時
    // **一律**用解出的那場。多場並行下 latest-by-id 已不安全：較晚建立但已 closed 的活動
    // 會蓋掉仍 open 的較舊活動。
    //
    // **T-033b 起 `eventId` 不再保證是 active**（architect-reviewer B-1，D-025 errata E1）：
    // quote 解出的 id 刻意不過濾「是否仍在候選集合內」（`event-disambiguation.ts` §4.3），
    // 因此這裡可能拿到 cancelled/done 的列。`displayPhase` 只認 {closed, ended, live}
    // ——cancelled 會被歸成 `live`、把已取消的活動當進行中顯示。故先過顯示集，
    // 與下方 fallback 路徑（`findLatestDisplayable` 本就只回 {draft,open,closed}）採同一條規則。
    if (eventId !== undefined) {
      const event = await this.events.getById(eventId);
      if (event === undefined) return undefined;
      if (!DISPLAYABLE_EVENT_STATUSES.includes(event.status)) return undefined;
      return { event, phase: displayPhase(event, nowIso()) };
    }
    // **只有**候選數 === 0（eventId === undefined；ambiguous/conflict/not_found/too_many 已於
    // dispatch 層短路、不會走到 service）才退回 findLatestDisplayable——此時只剩 closed/cancelled
    // 可選，不存在「蓋掉仍開放活動」的風險，既有行為零回歸。
    const event = await this.events.findLatestDisplayable(groupId);
    if (event === undefined) return undefined;
    return { event, phase: displayPhase(event, nowIso()) };
  }

  /** 交易後重查名單視圖（有效性過濾一律走 repo 原語；G6）。 */
  private async buildView(event: EventRow): Promise<RegistrationView> {
    const confirmed = await this.registrations.listConfirmed(event.id);
    const waitlist = await this.registrations.listWaitlist(event.id);
    return {
      event,
      confirmed,
      waitlist,
      confirmedCount: confirmed.length,
      available: Math.max(0, event.capacity - confirmed.length),
    };
  }

  // ── +N 報名（D-003 §2 / D-008 §6b） ────────────────────────────────
  async signup(input: SignupInput): Promise<SignupResult> {
    const resolved = await this.findOpenEventForSignup(input.eventId);
    if (resolved.kind === 'no_open_event') return { kind: 'no_open_event' };
    if (resolved.kind === 'event_ended') return { kind: 'event_ended' };
    const event = resolved.event;

    const owner = await this.users.upsert(input.executorLineUserId, input.executorDisplayName);
    const isProxy = input.proxyName !== undefined;
    const slotDisplayName = isProxy ? input.proxyName! : owner.display_name;
    const kind = isProxy ? 'proxy' : 'self';

    const tx = await this.runImmediate<TxSignup>(event.id, async (repos) => {
      // G7：去重為交易第一步，重送即中止（原子回滾）。
      if (!(await repos.processed.markProcessed(input.messageId))) {
        return { kind: 'duplicate' };
      }
      // D-008 §6b/AC-9：鎖內以 getById 重讀最新列 re-check（非 stale 快照）；
      // 若非 open 或已過期（含被並行 flip 為 done）→ event_ended、不插槽（無超賣、不雙開）。
      const fresh = await repos.events.getById(event.id);
      if (fresh === undefined || !isOpenForSignup(fresh, nowIso())) {
        return { kind: 'event_ended' };
      }
      const confirmed = await repos.registrations.countConfirmed(event.id);
      const available = event.capacity - confirmed;
      // G1：整批全進 / 整批候補，不部分接受。
      const status: RegistrationStatus = available >= input.count ? 'confirmed' : 'waitlist';
      const newSlots = await repos.registrations.insertSlots(
        {
          eventId: event.id,
          ownerUserId: owner.id,
          displayName: slotDisplayName,
          kind,
          status,
        },
        input.count,
      );
      return { kind: 'ok', outcome: status, newSlots };
    });

    if (tx.kind === 'duplicate') return { kind: 'duplicate' };
    if (tx.kind === 'event_ended') return { kind: 'event_ended' };
    return {
      kind: 'ok',
      outcome: tx.outcome === 'confirmed' ? 'confirmed' : 'waitlisted',
      requested: input.count,
      subjectDisplayName: slotDisplayName,
      newSlots: tx.newSlots,
      view: await this.buildView(event),
    };
  }

  // ── -N 取消（D-003 §3 / D-008 §6b） ────────────────────────────────
  async cancel(input: CancelInput): Promise<CancelResult> {
    const resolved = await this.findOpenEventForSignup(input.eventId);
    if (resolved.kind === 'no_open_event') return { kind: 'no_open_event' };
    if (resolved.kind === 'event_ended') return { kind: 'event_ended' };
    const event = resolved.event;

    const executor = await this.users.upsert(input.executorLineUserId, input.executorDisplayName);
    const isHost = executor.id === event.host_user_id;

    // 定位待取消列（交易外查詢；交易內再取消）。
    let candidates: RegistrationRow[];
    if (input.proxyName === undefined) {
      // 自取消：只取本人自報名列（本人代報名額需以 -N 名字 取消）。
      candidates = (await this.registrations.findActiveByOwner(event.id, executor.id)).filter(
        (r) => r.kind === 'self',
      );
    } else if (isHost) {
      // 主辦人：跨 owner 定位（G4；已涵蓋主辦人自己代報的列，不再合併 owner-scoped）。
      candidates = await this.registrations.findActiveProxyByName(event.id, input.proxyName);
    } else {
      // 非主辦人：只走 owner-scoped（G4；查無即拒，不得取消他人代報名額）。
      candidates = await this.registrations.findActiveProxy(event.id, executor.id, input.proxyName);
    }

    if (candidates.length === 0) return { kind: 'nothing_to_cancel' };

    // 取消順序：先候補後正取；各組內高 seq 先。取前 min(N, len) 列。
    const bySeqDesc = (a: RegistrationRow, b: RegistrationRow): number => b.seq - a.seq;
    const waitlistDesc = candidates.filter((r) => r.status === 'waitlist').sort(bySeqDesc);
    const confirmedDesc = candidates.filter((r) => r.status === 'confirmed').sort(bySeqDesc);
    const ordered = [...waitlistDesc, ...confirmedDesc];
    const toCancel = ordered.slice(0, Math.min(input.count, ordered.length));

    const tx = await this.runImmediate<TxCancel>(event.id, async (repos) => {
      if (!(await repos.processed.markProcessed(input.messageId))) {
        return { kind: 'duplicate' };
      }
      // D-008 §6b/AC-9：鎖內重讀最新列 re-check（非 stale 快照）；過期/被 flip → event_ended、不取消。
      const fresh = await repos.events.getById(event.id);
      if (fresh === undefined || !isOpenForSignup(fresh, nowIso())) {
        return { kind: 'event_ended' };
      }
      const { cancelled } = await repos.registrations.cancelByIds(
        toCancel.map((r) => r.id),
        executor.id,
      );
      // B2 修（D-003 errata）：遞補額度取「鎖內當下剩餘名額」，非本次釋出數 freedConfirmed。
      // G1 整批候補會留下擱置空位（capacity=10/confirmed=9 時 +2 整批候補，該 1 位無人可用），
      // freedConfirmed 只看本次釋出量 → 該空位永久無法回收。以剩餘名額為額度即一併回收。
      // 亦承接 B1：countConfirmed 為鎖內真值（已含本次 soft-delete），並發下同列被兩 cancel
      // 鎖定時第二者實取 0、正取數未變 → quota=0 不多遞補 → 有效正取數永不超過 capacity（G8）。
      const confirmedAfter = await repos.registrations.countConfirmed(event.id);
      const promotionQuota = fresh.capacity - confirmedAfter;
      // nit N2：鎖內 FIFO 遞補抽為 promoteWithinLock（與 addCapacity 共用；零行為變更）。
      const promoted = await this.promoteWithinLock(repos, event.id, promotionQuota);
      return { kind: 'ok', cancelled, promoted };
    });

    if (tx.kind === 'duplicate') return { kind: 'duplicate' };
    if (tx.kind === 'event_ended') return { kind: 'event_ended' };
    return {
      kind: 'ok',
      cancelled: tx.cancelled,
      requested: input.count,
      subjectDisplayName: input.proxyName ?? executor.display_name,
      promoted: tx.promoted,
      view: await this.buildView(event),
    };
  }

  /**
   * 鎖內 FIFO 遞補（T-015 / D-010 nit N2；供 cancel 與 addCapacity 共用，零行為變更）。
   * `quota` ≤ 0 → 不遞補、回 []；否則 `pickWaitlistForPromotion`（最小 seq）→ `promoteByIds`，
   * 遞補數 ≤ quota（上界為容量 → 有效正取數 ≤ 容量，不超賣，G5/G8）。
   * nit-5 防禦性斷言：交易內選取數應等於遞補數；不等記異常並以回讀 confirmed 為準。
   * **必於 `runImmediate`（FOR UPDATE）交易內、以 client-bound `repos` 呼叫**（同連線鎖生效，G2）。
   * 已知限制（Backlog）：以列為單位 LIMIT，quota < 候補隊首批次人數時會拆批。
   */
  private async promoteWithinLock(
    repos: TxRepos,
    eventId: number,
    quota: number,
  ): Promise<RegistrationRow[]> {
    if (quota <= 0) return [];
    const picks = await repos.registrations.pickWaitlistForPromotion(eventId, quota);
    const promotedN = await repos.registrations.promoteByIds(picks.map((r) => r.id));
    if (promotedN !== picks.length) {
      // nit-5 防禦性斷言：交易內恆相等；不等記異常並以回讀為準。
      this.logError('遞補列數與選取數不一致（不預期）', {
        eventId,
        promotedN,
        picked: picks.length,
      });
      const rechecked = await Promise.all(picks.map((r) => repos.registrations.getById(r.id)));
      return rechecked.filter(
        (r): r is RegistrationRow => r !== undefined && r.status === 'confirmed',
      );
    }
    return picks;
  }

  // ── 加開名額（`加開 N`；D-010 §一.2/§一.3） ─────────────────────────────
  async addCapacity(input: AddCapacityInput): Promise<AddCapacityResult> {
    // 交易外前置（early-return，不 mark、無 DB 變更，仿 close/cancel；G4 非授權零副作用）。
    // 1. 消歧義解出的活動且為 open（undefined=候選數 0／draft 非 open）→ no_open_event（D-021 §5.1）。
    const event =
      input.eventId === undefined ? undefined : await this.events.getById(input.eventId);
    if (event === undefined || event.status !== 'open') return { kind: 'no_open_event' };
    // 2. 過期 open → event_ended（活動已結束）。
    if (isExpired(event, nowIso())) return { kind: 'event_ended' };
    // 3. 授權：host ∪ super-admin（共享謂詞，唯讀不 upsert；G4）。
    if (!(await canManageEvent(this.users, this.superAdmins, event, input.executorLineUserId))) {
      return { kind: 'not_authorized' };
    }

    const tx = await this.runImmediate<TxAddCapacity>(event.id, async (repos) => {
      // G7：去重為交易第一步，重送即中止（原子回滾；AC-8）。
      if (!(await repos.processed.markProcessed(input.messageId))) {
        return { kind: 'duplicate' };
      }
      // G3：鎖內以 getById 權威重讀（非 stale）；非 open / 過期（含被並行 flip）→ event_ended，
      // 不改 capacity、不遞補。
      const fresh = await repos.events.getById(event.id);
      if (fresh === undefined || !isOpenForSignup(fresh, nowIso())) {
        return { kind: 'event_ended' };
      }
      // G1：只加不減（N≥1 由 parser 保證）。newCapacity 超過總上限 → over_limit，不 UPDATE。
      const newCapacity = fresh.capacity + input.count;
      if (newCapacity > MAX_CAPACITY) {
        return { kind: 'over_limit' };
      }
      // G2：capacity 於 FOR UPDATE 鎖內原子加開。
      await repos.events.updateCapacity(event.id, newCapacity);
      // G5：複用 T-015 鎖內遞補——quota = 新容量 − 鎖內有效正取數（上界為新容量 → 不超賣）。
      const confirmedAfter = await repos.registrations.countConfirmed(event.id);
      const promotionQuota = newCapacity - confirmedAfter;
      const promoted = await this.promoteWithinLock(repos, event.id, promotionQuota);
      return { kind: 'ok', newCapacity, promoted };
    });

    if (tx.kind === 'duplicate') return { kind: 'duplicate' };
    if (tx.kind === 'event_ended') return { kind: 'event_ended' };
    if (tx.kind === 'over_limit') return { kind: 'over_limit' };
    // view 以最新 capacity 重建（buildView 依 event.capacity 算 available）；重讀確保剩餘名額正確。
    const updated = (await this.events.getById(event.id)) ?? { ...event, capacity: tx.newCapacity };
    return {
      kind: 'ok',
      added: input.count,
      newCapacity: tx.newCapacity,
      promoted: tx.promoted,
      view: await this.buildView(updated),
    };
  }

  // ── 名單查詢（D-003 §5：唯讀，markProcessed 交易外；D-008：帶 phase） ──────────────────
  async getListView(input: ListInput): Promise<ListResult> {
    // 唯讀去重：重送略過回覆，避免重複貼名單（無資料副作用，不綁交易）。
    if (!(await this.processed.markProcessed(input.messageId))) {
      return { kind: 'duplicate' };
    }
    const resolved = await this.findEventForDisplay(input.eventId, input.groupId);
    if (resolved === undefined) return { kind: 'no_open_event' };
    return { kind: 'ok', view: await this.buildView(resolved.event), phase: resolved.phase };
  }
}
