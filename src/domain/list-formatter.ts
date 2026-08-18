// src/domain/list-formatter.ts
//
// D-003 §8 / D-005 §5：把 domain 結果物件組版為繁體中文文字 + LINE-agnostic mention 描述子。
// 純函式：對 LINE SDK 零耦合（AC-8/AC-14）。嚴禁 any（G11/G6）；不觸 DB（G10）。
//
// D-005：費用列依 price_mode 顯示（split_venue live 標「暫估，關閉報名後結算」，G2）；
// 文案中性化（球聚→球敘、body 標籤 地點→場地，§7）；均攤金額走 billing.perPersonAmount（G1）。
//
// D-008 T-014（D-003 errata §五）：名單依 phase（live/ended/closed）分列組成——
//   - 標題：ended「（活動已結束）」、closed「（報名已截止）」；
//   - 費用列 phase 化：live 暫估／ended 取 perPersonAmount 去暫估／closed 取 settled_per_person 標「最終結算」；
//   - ended/closed **移除「剩餘名額」列**、總金額列去「預估/暫估」；
//   - 日期一律 utcIsoToTaipei(event.event_datetime) 還原台灣本地（顯示字面與輸入一致，AC-10）。
//
// 輸出型別 MessageDescriptor 由 webhook handler 轉為實際 LINE 訊息
// （純文字 → TextMessage；含 mention → TextMessageV2 + substitution）。

import type { EventRow, RegistrationRow } from '../db/schema';
import { utcIsoToTaipei } from '../db/time';
import { buildRoster } from './roster';
import { estimatedTotal, perPersonAmount } from './billing';
import type { ListPhase } from './event-status';
import { MAX_CAPACITY } from '../commands';
import type {
  RegistrationView,
  SignupResult,
  CancelResult,
  AddCapacityResult,
} from './registration-service';

/** LINE-agnostic mention 描述子（AC-14）：mention 顯示文字在 text 中的位置與被 @ 者 line_user_id。 */
export interface MentionDescriptor {
  /** mention 顯示文字（含 `@`）在 text 中的起始位置（UTF-16 code unit）。 */
  index: number;
  /** mention 顯示文字長度（UTF-16 code unit）。 */
  length: number;
  /** 被 @ 者的 LINE userId。 */
  lineUserId: string;
}

/** 組版輸出：純文字 + mention 描述子（handler 轉為實際 LINE 訊息）。 */
export interface MessageDescriptor {
  text: string;
  mentionees: MentionDescriptor[];
}

/** 遞補通知的單筆（handler 以 userRepo 解析 owner 後傳入；formatter 不觸 DB）。 */
export interface PromotionNotice {
  /** 是否為代報名列。 */
  isProxy: boolean;
  /** 被遞補者顯示名（自報名為報名者名；代報名為代報名字，如「陳大哥」）。 */
  displayName: string;
  /** 代報名列時：代報者稱謂（users.display_name）。 */
  proxyAgentName?: string;
  /** mention 目標 userId（owner 的 line_user_id）；取不到→null→退化純文字（§4 fallback）。 */
  ownerLineUserId: string | null;
}

type SignupOk = Extract<SignupResult, { kind: 'ok' }>;
type CancelOk = Extract<CancelResult, { kind: 'ok' }>;

// ── 共用區塊 ─────────────────────────────────────────────────────────

/**
 * 費用列（D-005 §5.1 / D-008 §8；供 header 複用）。依 price_mode + phase：
 * - per_person（所有 phase）：`每人費用：N 元`
 * - split_venue live：`場地費：N 元，平均每人約 M 元（暫估，關閉報名後結算）`
 * - split_venue ended：`場地費：N 元，每人 M 元（正取 K 人）`（M=perPersonAmount 動態終值，去「暫估」）
 * - split_venue closed：`場地費：N 元，每人 M 元（正取 K 人，最終結算）`（M=settled_per_person 凍結快照）
 */
export function feeLine(
  event: EventRow,
  confirmedCount: number,
  phase: ListPhase = 'live',
): string {
  if (event.price_mode !== 'split_venue') {
    return `每人費用：${event.price_per_person} 元`;
  }
  const fee = event.venue_fee ?? 0;
  if (phase === 'live') {
    const per = perPersonAmount(event, confirmedCount);
    return `場地費：${fee} 元，平均每人約 ${per} 元（暫估，關閉報名後結算）`;
  }
  if (phase === 'closed') {
    // closed 取凍結快照 settled_per_person；意外為 NULL（D-005 後不應發生）→ fallback 動態算。
    const settled = event.settled_per_person ?? perPersonAmount(event, confirmedCount);
    return `場地費：${fee} 元，每人 ${settled} 元（正取 ${confirmedCount} 人，最終結算）`;
  }
  // ended（過期 open，settled_per_person 恆為 NULL 因從未關閉）：取 perPersonAmount 動態終值。
  const per = perPersonAmount(event, confirmedCount);
  return `場地費：${fee} 元，每人 ${per} 元（正取 ${confirmedCount} 人）`;
}

function eventHeader(
  event: EventRow,
  forSignup: boolean,
  confirmedCount: number,
  phase: ListPhase = 'live',
): string {
  const { date, time } = utcIsoToTaipei(event.event_datetime);
  let title: string;
  if (forSignup) {
    title = `[${event.location} 球敘報名]`;
  } else {
    const suffix = phase === 'ended' ? '（活動已結束）' : phase === 'closed' ? '（報名已截止）' : '';
    title = `[${event.location} 球敘]${suffix}`;
  }
  return [
    title,
    `日期：${date} ${time}`,
    `場地：${event.location}`,
    feeLine(event, confirmedCount, phase),
  ].join('\n');
}

function confirmedSection(capacity: number, confirmed: RegistrationRow[]): string[] {
  const lines = [`報名名單（${confirmed.length}/${capacity}）：`];
  for (const e of buildRoster(confirmed)) lines.push(`${e.index}. ${e.label}`);
  return lines;
}

function waitlistSection(waitlist: RegistrationRow[]): string[] {
  const lines = ['候補名單：'];
  for (const e of buildRoster(waitlist)) lines.push(`${e.index}. ${e.label}`);
  return lines;
}

/** 新候補列在有效候補中的 1-based 序位（依 seq）。 */
function waitlistPositions(waitlist: RegistrationRow[], newSlots: RegistrationRow[]): number[] {
  const ids = new Set(newSlots.map((r) => r.id));
  const positions: number[] = [];
  [...waitlist]
    .sort((a, b) => a.seq - b.seq)
    .forEach((r, i) => {
      if (ids.has(r.id)) positions.push(i + 1);
    });
  return positions;
}

/**
 * 名單主體（正取 + 候補 + 剩餘名額列）。
 * D-008：ended/closed **略去「剩餘名額」列**（`報名名單（K/上限）` 已含人數，不暗示可加入）。
 */
function bodyRoster(view: RegistrationView, phase: ListPhase = 'live'): string[] {
  const parts: string[] = [];
  parts.push(...confirmedSection(view.event.capacity, view.confirmed));
  if (view.waitlist.length > 0) {
    parts.push('');
    parts.push(...waitlistSection(view.waitlist));
  }
  if (phase === 'live') {
    parts.push('');
    parts.push(`剩餘名額：${view.available}`);
  }
  return parts;
}

// ── 各指令組版 ───────────────────────────────────────────────────────

/** 無 open 活動定型句（§8(F)、§7）。 */
export function formatNoOpenEvent(): MessageDescriptor {
  return { text: '目前沒有開放報名的活動', mentionees: [] };
}

/** 過期 open 的 +N/-N 拒絕（D-008 §8(1)/OP-2/AC-4）。 */
export function formatEventEnded(): MessageDescriptor {
  return { text: '這場活動已結束，無法再報名／取消。', mentionees: [] };
}

/** -N 查無可取消名額（§7）。 */
export function formatNothingToCancel(proxyName?: string): MessageDescriptor {
  const text =
    proxyName !== undefined
      ? `查無您代報的「${proxyName}」名額可取消`
      : '您目前沒有可取消的名額';
  return { text, mentionees: [] };
}

/** +N 報名成功（正取 / 整批候補）（§8 (A)/(B)）。 */
export function formatSignup(result: SignupOk): MessageDescriptor {
  const { view } = result;
  const parts: string[] = [eventHeader(view.event, true, view.confirmedCount), ''];
  if (result.outcome === 'confirmed') {
    parts.push(`已為「${result.subjectDisplayName}」報名 ${result.requested} 位（正取）。`);
  } else {
    const positions = waitlistPositions(view.waitlist, result.newSlots);
    parts.push(
      `正取名額已滿，已將「${result.subjectDisplayName}」的 ${result.requested} 位整批排入候補。`,
    );
    parts.push(`候補序位：第 ${positions.join('、')} 位`);
  }
  parts.push('');
  parts.push(...bodyRoster(view));
  return { text: parts.join('\n'), mentionees: [] };
}

/** -N 取消成功（更新名單）（§8(C)）。 */
export function formatCancel(result: CancelOk): MessageDescriptor {
  const { view } = result;
  const parts: string[] = [eventHeader(view.event, true, view.confirmedCount), ''];
  parts.push(`已為「${result.subjectDisplayName}」取消 ${result.cancelled} 位。`);
  parts.push('');
  parts.push(...bodyRoster(view));
  return { text: parts.join('\n'), mentionees: [] };
}

/**
 * 名單查詢（§8(E) / D-005 §5.1 / D-008 §8(3)）：名單 + （live 才有）剩餘名額 + 總金額（mode/phase-aware）。
 * ended/closed：標題標「活動已結束/報名已截止」、費用列去暫估、無剩餘名額、總金額去「預估/暫估」。
 */
export function formatList(view: RegistrationView, phase: ListPhase = 'live'): MessageDescriptor {
  const parts: string[] = [eventHeader(view.event, false, view.confirmedCount, phase), ''];
  parts.push(...bodyRoster(view, phase));
  const total = estimatedTotal(view.event, view.confirmedCount);
  if (view.event.price_mode === 'split_venue') {
    // split：總額固定 = venue_fee，與正取數無關（AC-2/AC-14）。
    parts.push(
      phase === 'live'
        ? `預估總金額：場地費 ${total} 元（固定，暫估）`
        : `總金額：場地費 ${total} 元`,
    );
  } else {
    const line = `${view.confirmedCount} × ${view.event.price_per_person} = ${total} 元`;
    parts.push(phase === 'live' ? `預估總金額：${line}` : `總金額：${line}`);
  }
  return { text: parts.join('\n'), mentionees: [] };
}

/** 遞補通知（§8(D)）：含 @ mention 描述子；ownerLineUserId 取不到者退化純文字。 */
export function formatPromotionNotice(notices: PromotionNotice[]): MessageDescriptor {
  const header = '名額釋出，恭喜由候補遞補為正取：';
  let text = header;
  const mentionees: MentionDescriptor[] = [];
  for (const n of notices) {
    text += '\n';
    if (n.isProxy) {
      const prefix = `${n.displayName}（由 `;
      const mentionText = `@${n.proxyAgentName ?? '代報者'}`;
      const suffix = ' 代報）';
      const index = text.length + prefix.length;
      text += prefix + mentionText + suffix;
      if (n.ownerLineUserId !== null) {
        mentionees.push({ index, length: mentionText.length, lineUserId: n.ownerLineUserId });
      }
    } else {
      const mentionText = `@${n.displayName}`;
      const index = text.length;
      text += mentionText;
      if (n.ownerLineUserId !== null) {
        mentionees.push({ index, length: mentionText.length, lineUserId: n.ownerLineUserId });
      }
    }
  }
  return { text, mentionees };
}

// ── D-010 加開名額組版 ────────────────────────────────────────────────

type AddCapacityOk = Extract<AddCapacityResult, { kind: 'ok' }>;

/** `加開 N` 拒絕：非授權（D-010 §3）。 */
export function formatAddCapacityNotAuthorized(): MessageDescriptor {
  return { text: '只有開團的人（或系統管理員）可以加開名額。', mentionees: [] };
}

/** `加開 N` 拒絕：活動已結束（D-010 §3）。 */
export function formatAddCapacityEnded(): MessageDescriptor {
  return { text: '活動已結束，無法加開名額', mentionees: [] };
}

/** `加開 N` 拒絕：加開後超過人數上限（D-010 §3）。 */
export function formatAddCapacityOverLimit(): MessageDescriptor {
  return { text: `加開後將超過人數上限（${MAX_CAPACITY}），無法加開`, mentionees: [] };
}

/**
 * `加開 N` 成功（D-010 §3，**單一則**）：加開公告 + 更新後名單 + 剩餘名額；
 * `notices` 非空時**同一則內**追加遞補 @ 通知（複用 §4 formatPromotionNotice，
 * mention 位移平移對齊到合併文字，維持單一 mention source of truth）。
 */
export function formatAddCapacity(
  result: AddCapacityOk,
  notices: PromotionNotice[],
): MessageDescriptor {
  const { view } = result;
  const parts: string[] = [
    `「${view.event.location}」球敘已加開 ${result.added} 個名額（上限 ${result.newCapacity}）。`,
    '',
  ];
  parts.push(...bodyRoster(view));
  const base = parts.join('\n');
  if (notices.length === 0) {
    return { text: base, mentionees: [] };
  }
  const sub = formatPromotionNotice(notices);
  const sep = '\n';
  const offset = base.length + sep.length;
  const text = base + sep + sub.text;
  const mentionees = sub.mentionees.map((m) => ({ ...m, index: m.index + offset }));
  return { text, mentionees };
}

// ── D-012 多行批次報名組版 ────────────────────────────────────────────────
//
// 逐行摘要（釘死字串；用語沿用既有「正取/候補」，不新增第二種措辭）：
//   報名行 →「已報名：{名字}」，落候補者於名字後標「（候補）」；取消行 →「已取消：{名字}」。
// 批次末尾另附一次更新後名單（handler 複用 formatList(view)）與遞補 @（formatPromotionNotice）。

/** 批次單行摘要項（handler 於逐行執行後彙整，交 formatBatchSummary 組版）。 */
export type BatchSummaryItem =
  | { kind: 'signup'; subjectDisplayName: string; waitlisted: boolean }
  | { kind: 'cancel'; subjectDisplayName: string };

/**
 * D-012 §3：批次逐行摘要（**同一則訊息內多文字行**，非多則）。
 * 報名落候補 → 名字後標「（候補）」；取消 →「已取消：{名字}」。無 mention。
 */
export function formatBatchSummary(items: readonly BatchSummaryItem[]): MessageDescriptor {
  const lines = items.map((it) =>
    it.kind === 'signup'
      ? it.waitlisted
        ? `已報名：${it.subjectDisplayName}（候補）`
        : `已報名：${it.subjectDisplayName}`
      : `已取消：${it.subjectDisplayName}`,
  );
  return { text: lines.join('\n'), mentionees: [] };
}

/** D-012 §3：可執行行數超過上限的整則拒絕（釘死字串；不執行任何行）。 */
export function formatBatchOverLimit(max: number): MessageDescriptor {
  return { text: `一次最多報名 ${max} 筆，請分次輸入。`, mentionees: [] };
}
