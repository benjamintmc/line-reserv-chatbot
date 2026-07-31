// src/domain/event-formatter.ts
//
// D-004 §8 / D-005 §5–§7：把開團 domain 結果組版為繁體中文 MessageDescriptor（純文字，mentionees:[]）。
// 純函式：對 LINE SDK 零耦合、可純測（G5/G6）。嚴禁 any；不觸 DB。
//
// D-005：費用列依 price_mode 顯示（split 標「暫估」，G2；開團公告不顯示每人估額，B2/AC-19）；
// 關閉報名(split) 顯示最終攤額（formatClosed 以傳入 settledPerPerson 為唯一真相來源，architect N3）；
// 文案中性化（球聚→球敘、開球時間→時間、球場地點→場地、body 標籤 地點→場地，§7）。

import type { EventRow } from '../db/schema';
import type { CreateState, CreateEventDraft } from './create-flow';
import type { MessageDescriptor } from './list-formatter';

function text(s: string): MessageDescriptor {
  return { text: s, mentionees: [] };
}

// (A) 逐步問答提問（依 state）。首問附「取消」逃生口提示（N1）。
export function formatFlowPrompt(state: CreateState): MessageDescriptor {
  switch (state) {
    case 'awaiting_date':
      return text(
        '開始開團！請輸入活動日期（格式 YYYY/MM/DD，例：2026/08/15）\n' +
          '（過程中隨時輸入「取消」可放棄開團）',
      );
    case 'awaiting_time':
      return text('請輸入時間（格式 HH:MM，例：07:30）');
    case 'awaiting_location':
      return text('請輸入場地（例：○○球場）');
    case 'awaiting_capacity':
      return text('請輸入人數上限（正整數，例：16）');
    case 'awaiting_price_mode':
      return text(
        '請選擇計費方式：輸入「每人」固定每人費用，或「場地費」由場地費總額均攤',
      );
    case 'awaiting_price':
      return text('請輸入每人費用（元，例：2200；免費請輸入 0）');
    case 'awaiting_venue_fee':
      return text('請輸入場地費總額（元，例：3000；將依報名人數均攤）');
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
export function formatFieldError(state: CreateState): MessageDescriptor {
  switch (state) {
    case 'awaiting_date':
      return text('日期格式不正確，請輸入 YYYY/MM/DD（例：2026/08/15）');
    case 'awaiting_time':
      return text('時間格式不正確，請輸入 HH:MM（例：07:30）');
    case 'awaiting_location':
      return text('場地不可為空，請輸入場地（例：○○球場）');
    case 'awaiting_capacity':
      return text('人數需為正整數（例：16）');
    case 'awaiting_price_mode':
      // B1/AC-17：無效答案（含裸數字）重問；不猜測、不當金額。
      return text(
        '請輸入「每人」或「場地費」：「每人」設定固定每人費用，「場地費」由場地費總額均攤' +
          '（過程中可輸入「取消」放棄開團）',
      );
    case 'awaiting_price':
      return text('費用需為 0 或正整數（免費請輸入 0，例：2200）');
    case 'awaiting_venue_fee':
      return text('場地費需為正整數（元，例：3000），請重新輸入。');
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
      `日期：${event.event_date} ${event.event_time}`,
      `場地：${event.location}`,
      `人數上限：${event.capacity}`,
      eventFeeLine(event),
      '',
      '報名方式：輸入 +1（或 +N）報名，-1（或 -N）取消，名單 查看報名狀況。',
      '（主辦已自動報名為第 1 位）',
    ].join('\n'),
  );
}

// (E) 關閉報名回覆。split 追加最終結算列（settledPerPerson 為唯一真相來源，architect N3）。
export function formatClosed(
  event: EventRow,
  settledPerPerson: number | null,
  confirmedCount: number,
): MessageDescriptor {
  const base = `「${event.location}」球敘已關閉報名，不再接受新報名。`;
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

// (H) 非白名單（政策 OP-2：回一句提示）。
export function formatNotAuthorized(): MessageDescriptor {
  return text('只有主辦人可以開團／管理活動。');
}

// (I) 已有進行中活動（重複開團；附現有活動摘要）。
export function formatAlreadyActiveEntry(event: EventRow): MessageDescriptor {
  return text(
    [
      '目前已有進行中的活動，無法再開新團：',
      `日期：${event.event_date} ${event.event_time}`,
      `場地：${event.location}`,
      eventFeeLine(event),
      '（如需另開新團，請主辦人先輸入「取消活動」結束目前活動。）',
    ].join('\n'),
  );
}

// (J) 生命週期指令但狀態不符：已關閉報名。
export function formatAlreadyClosed(): MessageDescriptor {
  return text('活動已關閉報名。');
}

// (J) 生命週期指令但狀態不符：無 active 活動。
export function formatNoActiveEvent(): MessageDescriptor {
  return text('目前沒有進行中的活動。');
}

// (K′) 一行式欄位格式錯（格式提示；涵蓋兩種計費語法，D-005 §7 / AC-18）。
export function formatOnelineFormatHelp(): MessageDescriptor {
  return text(
    [
      '格式：開團 <日期> <時間> <地點> <人數> <費用>',
      '費用兩種寫法：',
      '・每人固定：直接寫金額，例 2200元（或 每人2200元）',
      '・場地費均攤：場地費+總額，例 場地費3000元',
      '範例：開團 2026/08/15 07:30 東方球場 16人 2200元',
      '　　　開團 2026/08/15 07:30 東方球場 16人 場地費3000元',
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
