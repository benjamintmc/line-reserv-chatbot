// src/domain/event-formatter.ts
//
// D-004 §8 / D-005 §5–§7 / D-006 §5：把開團 domain 結果組版為繁體中文 MessageDescriptor（純文字，mentionees:[]）。
// 純函式：對 LINE SDK 零耦合、可純測（D-006 G4）。嚴禁 any；不觸 DB。
//
// D-005：費用列依 price_mode 顯示（split 標「暫估」；開團公告不顯示每人估額，B2/AC-19）；
// 關閉報名(split) 顯示最終攤額（formatClosed 以傳入 settledPerPerson 為唯一真相來源）；
// 文案中性化（球聚→球敘、開球時間→時間、球場地點→場地）。
// D-006：(H′) close/cancel 非授權文案（開團已全開，無「非授權開團」訊息）；(MyID) 我的ID。
//
// D-008 T-014（D-004/D-005 errata §五）：
//   - (D) 開團公告 / (I) 重複活動摘要之日期改由 event.event_datetime（UTC）經 utcIsoToTaipei 還原台灣本地；
//   - (E) formatClosed 即時回覆用詞由「已關閉報名」→「報名已截止」（與名單 closed 標籤收斂，B1）。
//
// T-023：開團流程文案的「範例日期」不再寫死（原 2026/08/15 已過期，等於對新使用者示範一個
//   無效日期），改為「基準時刻（台灣時區）＋7 天」動態產生。時鐘由呼叫端以 nowIso（UTC ISO-8601）
//   注入；本檔不得直接讀系統時鐘，以維持純函式與可測性（D-006 G4）。

import type { EventRow } from '../db/schema';
import { utcIsoToTaipei } from '../db/time';
import type { CreateState, CreateEventDraft } from './create-flow';
import type { MessageDescriptor } from './list-formatter';

function text(s: string): MessageDescriptor {
  return { text: s, mentionees: [] };
}

/**
 * (N2) D-004 errata（跨群，2026-08-18）→ D-013 §3 收斂：新流程覆寫掉前一段未完成流程時，
 * 於既有回覆前附一句告知，消除「舊流程被靜默吃掉、使用者回頭作答卻無回覆」的死角。
 *
 * **D-013：唯一情境是「同群的分組 session 被 `開團` 覆寫」**（conversation 以
 * `(group_id, line_user_id)` 為 PK 後，別群流程並行共存、不再被覆寫 ⇒ 原 `create` 告知句已不可達
 * 而移除）。故本函式不再需要 kind 參數。
 *
 * **刻意不透露前一段流程的任何內容**（時間/場地/人數/費用/群組名皆不出現，G7）：措辭若讓讀者
 * 能判斷來源群，等同把他群活動的存在洩漏給本群成員。
 * 用語沿用既有「分組」，不新增第二種說法（球種中性，CLAUDE.md §0）。
 */
export function withAbandonedNotice(base: MessageDescriptor): MessageDescriptor {
  const notice = '已結束你先前未完成的分組。';
  const offset = notice.length + 1; // +1 為換行
  return {
    text: `${notice}\n${base.text}`,
    // 現行 (A)/(B) 皆無 mention；仍位移以免日後 base 帶 mention 時 index 錯位。
    mentionees: base.mentionees.map((m) => ({ ...m, index: m.index + offset })),
  };
}

/** event.event_datetime（UTC）→ 台灣本地顯示字串 `YYYY-MM-DD HH:MM`（D-008 §3）。 */
function eventDateTimeDisplay(event: EventRow): string {
  const { date, time } = utcIsoToTaipei(event.event_datetime);
  return `${date} ${time}`;
}

/** 範例日期的前推天數（T-023）：示範一個尚未過期、且看得出是「近期活動」的日期。 */
const EXAMPLE_DATE_OFFSET_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 文案用範例日期（T-023）：基準時刻（UTC ISO）＋7 天，換算台灣本地後輸出既有的 `YYYY/MM/DD` 格式。
 * 時區換算沿用 `src/db/time.ts` 的 `utcIsoToTaipei`，不自行重寫時區邏輯。
 * `new Date(ms)` 是「毫秒 → Date」的確定性轉換（非讀取系統時鐘），不違反本檔的純函式約束。
 */
function exampleDate(nowIso: string): string {
  const ms = Date.parse(nowIso);
  if (Number.isNaN(ms)) {
    throw new Error(`exampleDate: 無法解析 ISO（nowIso=${nowIso}）`);
  }
  const shifted = new Date(ms + EXAMPLE_DATE_OFFSET_DAYS * DAY_MS).toISOString();
  return utcIsoToTaipei(shifted).date.replace(/-/g, '/');
}

// (A) 逐步問答提問（依 state）。首問附「取消」逃生口提示（N1）。
export function formatFlowPrompt(state: CreateState, nowIso: string): MessageDescriptor {
  switch (state) {
    case 'awaiting_date':
      return text(
        `開始開團！請輸入活動日期（格式 YYYY/MM/DD，例：${exampleDate(nowIso)}）\n` +
          '（過程中隨時輸入「取消」可放棄開團）',
      );
    case 'awaiting_time':
      return text('請輸入時間（格式 HH:MM，例：07:30）');
    case 'awaiting_location':
      return text('請輸入場地（例：○○球場）');
    case 'awaiting_capacity':
      return text('請輸入人數上限（正整數，例：16）');
    case 'awaiting_fee':
      // D-005 §6.2（修訂）：單題費用，換行分列兩種寫法 + 「取消」逃生口（design-reviewer T-010 nit-1）。
      return text(
        '請輸入費用（兩種寫法）：\n' +
          '・每人固定：直接輸入金額，例 2200（或 每人2200）\n' +
          '・場地費均攤：輸入「場地費」+總額，例 場地費3000\n' +
          '（過程中可輸入「取消」放棄開團）',
      );
    case 'awaiting_confirm':
      // 進 awaiting_confirm 時應以確認摘要 (B) 回覆，不走此提問；防禦回重新提示 (M)。
      return formatConfirmReprompt();
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** 確認摘要的費用列（依 draft 計費模式）。split 不硬算每人（建立前分母失真），標「開團後依實際報名人數均攤」。 */
function draftFeeLine(draft: CreateEventDraft): string {
  if (draft.priceMode === 'split_venue') {
    return `費用：場地費 ${draft.venueFee ?? ''} 元，開團後依實際報名人數均攤（暫估，關閉報名後結算）`;
  }
  return `每人費用：${draft.price ?? ''} 元`;
}

// (B) 確認摘要（awaiting_confirm；一行式與逐步問答共用）。
// D-008：摘要仍以 draft 台灣本地 date/time 顯示（尚未合併 UTC；create-flow 不變）。
export function formatConfirmSummary(draft: CreateEventDraft): MessageDescriptor {
  return text(
    [
      '請確認開團資訊：',
      `日期：${draft.date ?? ''} ${draft.time ?? ''}`,
      `場地：${draft.location ?? ''}`,
      `人數上限：${draft.capacity ?? ''}`,
      draftFeeLine(draft),
      '',
      '輸入「確認」建立活動，或「取消」放棄。',
    ].join('\n'),
  );
}

// (C) 欄位格式錯誤（停留重問，依 state）。
export function formatFieldError(state: CreateState, nowIso: string): MessageDescriptor {
  switch (state) {
    case 'awaiting_date':
      return text(`日期格式不正確，請輸入 YYYY/MM/DD（例：${exampleDate(nowIso)}）`);
    case 'awaiting_time':
      return text('時間格式不正確，請輸入 HH:MM（例：07:30）');
    case 'awaiting_location':
      return text('場地不可為空，請輸入場地（例：○○球場）');
    case 'awaiting_capacity':
      return text('人數需為正整數（例：16）');
    case 'awaiting_fee':
      // D-005 §6.2（修訂）：單題費用無效重問（單則，涵蓋兩種寫法 + 取消提示）；AC-17、nit-2/3。
      return text(
        '費用格式不正確。每人固定：直接輸入金額（例：2200 或 每人2200）；' +
          '場地費均攤：場地費+總額（例：場地費3000）。請重新輸入（或輸入「取消」放棄）。',
      );
    case 'awaiting_confirm':
      return formatConfirmReprompt();
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** 開團公告/重複活動摘要的費用列（依 price_mode）。split 只顯示場地費總額，**不顯示每人估額**（B2/AC-19）。 */
function eventFeeLine(event: EventRow): string {
  if (event.price_mode === 'split_venue') {
    return `費用：場地費 ${event.venue_fee ?? 0} 元，將依報名人數均攤（暫估，關閉報名後結算）`;
  }
  return `每人費用：${event.price_per_person} 元`;
}

// (D) 開團成功公告（確認後 reply 群組）。split 明示主辦已佔第 1 正取（architect N4）。
export function formatOpenAnnouncement(event: EventRow): MessageDescriptor {
  return text(
    [
      `[${event.location} 球敘] 開團成功！`,
      `日期：${eventDateTimeDisplay(event)}`,
      `場地：${event.location}`,
      `人數上限：${event.capacity}`,
      eventFeeLine(event),
      '',
      '報名方式：輸入 +1（或 +N）報名，-1（或 -N）取消，名單 查看報名狀況。',
      '（主辦已自動報名為第 1 位）',
    ].join('\n'),
  );
}

// (E) 關閉報名回覆（D-008 B1：用詞「報名已截止」，與名單 closed 標籤一致）。
// split 追加最終結算列（settledPerPerson 為唯一真相來源，architect N3）。
export function formatClosed(
  event: EventRow,
  settledPerPerson: number | null,
  confirmedCount: number,
): MessageDescriptor {
  const base = `「${event.location}」球敘報名已截止，不再接受新報名。`;
  if (event.price_mode === 'split_venue' && settledPerPerson !== null) {
    return text(
      base +
        '\n' +
        `本場最終每人費用：${settledPerPerson} 元（場地費 ${event.venue_fee ?? 0} 元 ÷ 正取 ${confirmedCount} 人，` +
        '除不盡無條件進位；多收部分不另找零）',
    );
  }
  // per_person：不附最終攤額列（金額本即固定，AC-8）。
  return text(base);
}

// (F) 取消活動回覆。
export function formatCancelled(event: EventRow): MessageDescriptor {
  return text(`「${event.location}」球敘已取消。`);
}

// (G) 已取消開團（abort / awaiting_confirm 下取消）。
export function formatAborted(): MessageDescriptor {
  return text('已取消開團。');
}

// (H′) 非建立者、非 super-admin 試 `關閉報名`/`取消活動`（D-006 §5；取代 D-004 (H)）。
// 開團已全開 → 無「非授權開團」訊息；此 formatter 僅剩 close/cancel 使用。
export function formatNotAuthorized(): MessageDescriptor {
  return text('只有開團的人（或系統管理員）可以關閉報名／取消活動。');
}

// (MyID) 我的ID（D-006 §5 / §3）：回傳傳訊人自身 LINE userId，供設 super-admin 或告知系統管理員。
export function formatMyId(userId: string): MessageDescriptor {
  return text(
    [
      '你的 LINE 使用者 ID：',
      userId,
      '（可提供給系統管理員，加入管理權限設定。）',
    ].join('\n'),
  );
}

// (I) 已有進行中活動（重複開團；附現有活動摘要）。
// D-006 §五-1（D-004 errata B3）：「主辦人」→「開團的人」，與 (H′) 用詞一致。
export function formatAlreadyActiveEntry(event: EventRow): MessageDescriptor {
  return text(
    [
      '目前已有進行中的活動，無法再開新團：',
      `日期：${eventDateTimeDisplay(event)}`,
      `場地：${event.location}`,
      eventFeeLine(event),
      '（如需另開新團，請開團的人先輸入「取消活動」結束目前活動。）',
    ].join('\n'),
  );
}

// (J) 生命週期指令但狀態不符：已關閉報名（D-008：closed 釋放後 close 路徑不可達，保留供防禦）。
export function formatAlreadyClosed(): MessageDescriptor {
  return text('活動已關閉報名。');
}

// (J) 生命週期指令但狀態不符：無 active 活動。
export function formatNoActiveEvent(): MessageDescriptor {
  return text('目前沒有進行中的活動。');
}

// (K′) 一行式欄位格式錯（格式提示；涵蓋兩種計費語法，D-005 §7 / AC-18）。
export function formatOnelineFormatHelp(nowIso: string): MessageDescriptor {
  const d = exampleDate(nowIso);
  return text(
    [
      '格式：開團 <日期> <時間> <地點> <人數> <費用>',
      '費用兩種寫法：',
      '・每人固定：直接寫金額，例 2200元（或 每人2200元）',
      '・場地費均攤：場地費+總額，例 場地費3000元',
      `範例：開團 ${d} 07:30 東方球場 16人 2200元`,
      `　　　開團 ${d} 07:30 東方球場 16人 場地費3000元`,
    ].join('\n'),
  );
}

// (L) 確認時撞唯一約束（race 落敗；不依賴對方活動欄位）。
export function formatRaceLost(): MessageDescriptor {
  return text(
    '手腳慢了一步！剛剛已有另一場活動成立，目前無法再開新團。你這次的開團未建立。',
  );
}

// (M) 等待確認時輸入無法辨識（停留 awaiting_confirm，不建立）。
export function formatConfirmReprompt(): MessageDescriptor {
  return text('請輸入「確認」建立活動，或「取消」放棄。');
}
