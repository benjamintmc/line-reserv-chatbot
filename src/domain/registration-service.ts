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

import type { EventRow, RegistrationRow, RegistrationStatus } from '../db/schema';
import type { EventReader } from '../db/repositories/event-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ProcessedEventRepository } from '../db/repositories/processed-event-repository';
import type { RegistrationReader } from '../db/repositories/registration-repository';
import type { ImmediateRunner } from '../db/tx';
import { nowIso } from '../db/time';
import { displayPhase, isExpired, isOpenForSignup, type ListPhase } from './event-status';

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

export interface SignupInput {
  groupId: string;
  /** 傳訊人 LINE userId。 */
  executorLineUserId: string;
  /** 傳訊人顯示名快照（handler 以 getGroupMemberProfile 取得；NFR-4）。 */
  executorDisplayName: string;
  messageId: string;
  count: number;
  proxyName?: string;
}

export interface CancelInput {
  groupId: string;
  executorLineUserId: string;
  executorDisplayName: string;
  messageId: string;
  count: number;
  proxyName?: string;
}

export interface ListInput {
  groupId: string;
  messageId: string;
}

export interface RegistrationServiceDeps {
  events: EventReader;
  users: UserRepository;
  registrations: RegistrationReader;
  processed: ProcessedEventRepository;
  /** 防超賣交易 runner（路線 A）：BEGIN → SELECT event FOR UPDATE → work(repos) → COMMIT（D-007 §3）。 */
  runImmediate: ImmediateRunner;
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

export class RegistrationService {
  private readonly events: EventReader;
  private readonly users: UserRepository;
  private readonly registrations: RegistrationReader;
  private readonly processed: ProcessedEventRepository;
  private readonly runImmediate: ImmediateRunner;
  private readonly logError: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(deps: RegistrationServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.registrations = deps.registrations;
    this.processed = deps.processed;
    this.runImmediate = deps.runImmediate;
    this.logError =
      deps.logError ??
      ((msg, meta): void => {
        console.error(msg, meta ?? {});
      });
  }

  /**
   * 報名用（`+N`/`-N`）：取當前 group 可報名事件（open ∧ 未過期，D-008 §2）。
   * - open ∧ 未過期 → `{ ok, event }`；
   * - open ∧ 已過期 → `{ event_ended }`（活動已結束，拒報名/取消，OP-2）；
   * - 無 / draft（未物化）→ `{ no_open_event }`（closed 不在 findActiveByGroup 集合）。
   */
  private async findOpenEventForSignup(groupId: string): Promise<SignupEventResolution> {
    const event = await this.events.findActiveByGroup(groupId);
    if (event === undefined) return { kind: 'no_open_event' };
    const now = nowIso();
    if (isOpenForSignup(event, now)) return { kind: 'ok', event };
    if (event.status === 'open' && isExpired(event, now)) return { kind: 'event_ended' };
    return { kind: 'no_open_event' };
  }

  /**
   * 顯示用（`名單`）：取最新一場可顯示活動（{draft,open,closed} latest-by-id，D-008 §2/OP-4）+ phase。
   * latest 為 cancelled/無 → undefined（no_open_event）；done 不入顯示集（必被更新 open 取代）。
   */
  private async findEventForDisplay(
    groupId: string,
  ): Promise<{ event: EventRow; phase: ListPhase } | undefined> {
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
    const resolved = await this.findOpenEventForSignup(input.groupId);
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
    const resolved = await this.findOpenEventForSignup(input.groupId);
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
      // B1 修：freedConfirmed 取「鎖內實際取消的 confirmed 列數」（cancelByIds 之 RETURNING），
      // 非交易外快照 toCancel.filter(...)。並發下同列被兩 cancel 鎖定時，第二者實取 0、freedConfirmed=0，
      // 不多遞補 → 有效正取數永不超過 capacity（G8）。SQLite 同步版無此窗；async 讓點激活之。
      const { cancelled, freedConfirmed } = await repos.registrations.cancelByIds(
        toCancel.map((r) => r.id),
        executor.id,
      );
      let promoted: RegistrationRow[] = [];
      if (freedConfirmed > 0) {
        // G8：FIFO 遞補，數量 ≤ 本次實際釋出正取數。
        const picks = await repos.registrations.pickWaitlistForPromotion(event.id, freedConfirmed);
        const promotedN = await repos.registrations.promoteByIds(picks.map((r) => r.id));
        if (promotedN !== picks.length) {
          // nit-5 防禦性斷言：交易內恆相等；不等記異常並以回讀為準。
          this.logError('遞補列數與選取數不一致（不預期）', {
            eventId: event.id,
            promotedN,
            picked: picks.length,
          });
          const rechecked = await Promise.all(picks.map((r) => repos.registrations.getById(r.id)));
          promoted = rechecked.filter(
            (r): r is RegistrationRow => r !== undefined && r.status === 'confirmed',
          );
        } else {
          promoted = picks;
        }
      }
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

  // ── 名單查詢（D-003 §5：唯讀，markProcessed 交易外；D-008：帶 phase） ──────────────────
  async getListView(input: ListInput): Promise<ListResult> {
    // 唯讀去重：重送略過回覆，避免重複貼名單（無資料副作用，不綁交易）。
    if (!(await this.processed.markProcessed(input.messageId))) {
      return { kind: 'duplicate' };
    }
    const resolved = await this.findEventForDisplay(input.groupId);
    if (resolved === undefined) return { kind: 'no_open_event' };
    return { kind: 'ok', view: await this.buildView(resolved.event), phase: resolved.phase };
  }
}
