// src/domain/registration-service.ts
//
// D-003 §2/§3/§5：報名核心 domain。組合 D-001 repository 原語完成
// 額滿判斷（G1 整批候補）、FIFO 遞補（G8）、soft-delete（G3）、
// 代取消授權（G4）、去重（G7 markProcessed 為 runImmediate 第一步）。
//
// 本層**回傳結構化 domain 結果物件（非 LINE 訊息）**，對 LINE SDK 零耦合、可純測。
// 嚴禁 any（G11）；不得出現 SQL 字串或直接存取 db（G10）——一律經 repository 原語。

import type { EventRow, RegistrationRow, RegistrationStatus } from '../db/schema';
import type { EventRepository } from '../db/repositories/event-repository';
import type { UserRepository } from '../db/repositories/user-repository';
import type { ProcessedEventRepository } from '../db/repositories/processed-event-repository';
import type { RegistrationRepository } from '../db/repositories/registration-repository';

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

/** `+N` 報名結果（D-003 §1.1）。 */
export type SignupResult =
  | { kind: 'no_open_event' }
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

/** `-N` 取消結果（D-003 §1.1）。 */
export type CancelResult =
  | { kind: 'no_open_event' }
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

/** `名單` 查詢結果（D-003 §1.1；`duplicate` 為 §5 唯讀去重）。 */
export type ListResult =
  | { kind: 'no_open_event' }
  | { kind: 'duplicate' }
  | { kind: 'ok'; view: RegistrationView };

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
  events: EventRepository;
  users: UserRepository;
  registrations: RegistrationRepository;
  processed: ProcessedEventRepository;
  /** 不預期發生的異常記錄（如遞補守恆斷言失敗）；預設 console.error。 */
  logError?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** 交易內回傳型別（signup）。 */
type TxSignup =
  | { kind: 'duplicate' }
  | { kind: 'ok'; outcome: RegistrationStatus; newSlots: RegistrationRow[] };

/** 交易內回傳型別（cancel）。 */
type TxCancel =
  | { kind: 'duplicate' }
  | { kind: 'ok'; cancelled: number; promoted: RegistrationRow[] };

export class RegistrationService {
  private readonly events: EventRepository;
  private readonly users: UserRepository;
  private readonly registrations: RegistrationRepository;
  private readonly processed: ProcessedEventRepository;
  private readonly logError: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(deps: RegistrationServiceDeps) {
    this.events = deps.events;
    this.users = deps.users;
    this.registrations = deps.registrations;
    this.processed = deps.processed;
    this.logError =
      deps.logError ??
      ((msg, meta): void => {
        console.error(msg, meta ?? {});
      });
  }

  /** 取當前 group 的 open 活動；非 open（無 / draft / closed / cancelled）→ undefined。 */
  private findOpenEvent(groupId: string): EventRow | undefined {
    const event = this.events.findActiveByGroup(groupId);
    return event !== undefined && event.status === 'open' ? event : undefined;
  }

  /** 交易後重查名單視圖（有效性過濾一律走 repo 原語；G6）。 */
  private buildView(event: EventRow): RegistrationView {
    const confirmed = this.registrations.listConfirmed(event.id);
    const waitlist = this.registrations.listWaitlist(event.id);
    return {
      event,
      confirmed,
      waitlist,
      confirmedCount: confirmed.length,
      available: Math.max(0, event.capacity - confirmed.length),
    };
  }

  // ── +N 報名（D-003 §2） ─────────────────────────────────────────────
  signup(input: SignupInput): SignupResult {
    const event = this.findOpenEvent(input.groupId);
    if (event === undefined) return { kind: 'no_open_event' };

    const owner = this.users.upsert(input.executorLineUserId, input.executorDisplayName);
    const isProxy = input.proxyName !== undefined;
    const slotDisplayName = isProxy ? input.proxyName! : owner.display_name;
    const kind = isProxy ? 'proxy' : 'self';

    const tx = this.registrations.runImmediate<TxSignup>(() => {
      // G7：去重為交易第一步，重送即中止（原子回滾）。
      if (!this.processed.markProcessed(input.messageId)) {
        return { kind: 'duplicate' };
      }
      const confirmed = this.registrations.countConfirmed(event.id);
      const available = event.capacity - confirmed;
      // G1：整批全進 / 整批候補，不部分接受。
      const status: RegistrationStatus = available >= input.count ? 'confirmed' : 'waitlist';
      const newSlots = this.registrations.insertSlots(
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
    return {
      kind: 'ok',
      outcome: tx.outcome === 'confirmed' ? 'confirmed' : 'waitlisted',
      requested: input.count,
      subjectDisplayName: slotDisplayName,
      newSlots: tx.newSlots,
      view: this.buildView(event),
    };
  }

  // ── -N 取消（D-003 §3） ─────────────────────────────────────────────
  cancel(input: CancelInput): CancelResult {
    const event = this.findOpenEvent(input.groupId);
    if (event === undefined) return { kind: 'no_open_event' };

    const executor = this.users.upsert(input.executorLineUserId, input.executorDisplayName);
    const isHost = executor.id === event.host_user_id;

    // 定位待取消列（交易外查詢；交易內再取消）。
    let candidates: RegistrationRow[];
    if (input.proxyName === undefined) {
      // 自取消：只取本人自報名列（本人代報名額需以 -N 名字 取消）。
      candidates = this.registrations
        .findActiveByOwner(event.id, executor.id)
        .filter((r) => r.kind === 'self');
    } else if (isHost) {
      // 主辦人：跨 owner 定位（G4；已涵蓋主辦人自己代報的列，不再合併 owner-scoped）。
      candidates = this.registrations.findActiveProxyByName(event.id, input.proxyName);
    } else {
      // 非主辦人：只走 owner-scoped（G4；查無即拒，不得取消他人代報名額）。
      candidates = this.registrations.findActiveProxy(event.id, executor.id, input.proxyName);
    }

    if (candidates.length === 0) return { kind: 'nothing_to_cancel' };

    // 取消順序：先候補後正取；各組內高 seq 先。取前 min(N, len) 列。
    const bySeqDesc = (a: RegistrationRow, b: RegistrationRow): number => b.seq - a.seq;
    const waitlistDesc = candidates.filter((r) => r.status === 'waitlist').sort(bySeqDesc);
    const confirmedDesc = candidates.filter((r) => r.status === 'confirmed').sort(bySeqDesc);
    const ordered = [...waitlistDesc, ...confirmedDesc];
    const toCancel = ordered.slice(0, Math.min(input.count, ordered.length));

    const tx = this.registrations.runImmediate<TxCancel>(() => {
      if (!this.processed.markProcessed(input.messageId)) {
        return { kind: 'duplicate' };
      }
      const cancelled = this.registrations.cancelByIds(
        toCancel.map((r) => r.id),
        executor.id,
      );
      const freedConfirmed = toCancel.filter((r) => r.status === 'confirmed').length;
      let promoted: RegistrationRow[] = [];
      if (freedConfirmed > 0) {
        // G8：FIFO 遞補，數量 ≤ 本次釋出正取數。
        const picks = this.registrations.pickWaitlistForPromotion(event.id, freedConfirmed);
        const promotedN = this.registrations.promoteByIds(picks.map((r) => r.id));
        if (promotedN !== picks.length) {
          // nit-5 防禦性斷言：同步交易內恆相等；不等記異常並以回讀為準。
          this.logError('遞補列數與選取數不一致（不預期）', {
            eventId: event.id,
            promotedN,
            picked: picks.length,
          });
          promoted = picks
            .map((r) => this.registrations.getById(r.id))
            .filter((r): r is RegistrationRow => r !== undefined && r.status === 'confirmed');
        } else {
          promoted = picks;
        }
      }
      return { kind: 'ok', cancelled, promoted };
    });

    if (tx.kind === 'duplicate') return { kind: 'duplicate' };
    return {
      kind: 'ok',
      cancelled: tx.cancelled,
      requested: input.count,
      subjectDisplayName: input.proxyName ?? executor.display_name,
      promoted: tx.promoted,
      view: this.buildView(event),
    };
  }

  // ── 名單查詢（D-003 §5：唯讀，markProcessed 交易外） ──────────────────
  getListView(input: ListInput): ListResult {
    // 唯讀去重：重送略過回覆，避免重複貼名單（無資料副作用，不綁交易）。
    if (!this.processed.markProcessed(input.messageId)) {
      return { kind: 'duplicate' };
    }
    const event = this.findOpenEvent(input.groupId);
    if (event === undefined) return { kind: 'no_open_event' };
    return { kind: 'ok', view: this.buildView(event) };
  }
}
