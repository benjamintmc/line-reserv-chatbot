// src/domain/list-formatter.ts
//
// D-003 §8：把 domain 結果物件組版為繁體中文文字 + LINE-agnostic mention 描述子。
// 純函式：對 LINE SDK 零耦合、可純測（AC-8/AC-14）。嚴禁 any（G11）；不觸 DB（G10）。
//
// 輸出型別 MessageDescriptor 由 webhook handler 轉為實際 LINE 訊息
// （純文字 → TextMessage；含 mention → TextMessageV2 + substitution）。

import type { EventRow, RegistrationRow } from '../db/schema';
import { buildRoster } from './roster';
import type { RegistrationView, SignupResult, CancelResult } from './registration-service';

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

function eventHeader(event: EventRow, forSignup: boolean): string {
  const title = forSignup ? `[${event.location} 球聚報名]` : `[${event.location} 球聚]`;
  return [
    title,
    `日期：${event.event_date} ${event.event_time}`,
    `地點：${event.location}`,
    `每人費用：${event.price_per_person} 元`,
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

function bodyRoster(view: RegistrationView): string[] {
  const parts: string[] = [];
  parts.push(...confirmedSection(view.event.capacity, view.confirmed));
  if (view.waitlist.length > 0) {
    parts.push('');
    parts.push(...waitlistSection(view.waitlist));
  }
  parts.push('');
  parts.push(`剩餘名額：${view.available}`);
  return parts;
}

// ── 各指令組版 ───────────────────────────────────────────────────────

/** 無 open 活動定型句（§8(F)、§7）。 */
export function formatNoOpenEvent(): MessageDescriptor {
  return { text: '目前沒有開放報名的活動', mentionees: [] };
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
  const parts: string[] = [eventHeader(view.event, true), ''];
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
  const parts: string[] = [eventHeader(view.event, true), ''];
  parts.push(`已為「${result.subjectDisplayName}」取消 ${result.cancelled} 位。`);
  parts.push('');
  parts.push(...bodyRoster(view));
  return { text: parts.join('\n'), mentionees: [] };
}

/** 名單查詢（§8(E)）：名單 + 剩餘名額 + 預估總金額。 */
export function formatList(view: RegistrationView): MessageDescriptor {
  const parts: string[] = [eventHeader(view.event, false), ''];
  parts.push(...bodyRoster(view));
  const total = view.confirmedCount * view.event.price_per_person;
  parts.push(
    `預估總金額：${view.confirmedCount} × ${view.event.price_per_person} = ${total} 元`,
  );
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
