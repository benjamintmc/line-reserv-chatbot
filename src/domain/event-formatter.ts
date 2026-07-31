// src/domain/event-formatter.ts
//
// D-004 §8：把開團 domain 結果組版為繁體中文 MessageDescriptor（純文字，mentionees:[]）。
// 純函式：對 LINE SDK 零耦合、可純測（G5）。嚴禁 any（G6）；不觸 DB（G5）。
// 範本 (A)–(M) 逐字對齊 §8。

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
      return text('請輸入開球時間（格式 HH:MM，例：07:30）');
    case 'awaiting_location':
      return text('請輸入球場地點（例：東方球場）');
    case 'awaiting_capacity':
      return text('請輸入人數上限（正整數，例：16）');
    case 'awaiting_price':
      return text('請輸入每人費用（元，例：2200；免費請輸入 0）');
    case 'awaiting_confirm':
      // 進 awaiting_confirm 時應以確認摘要 (B) 回覆，不走此提問；防禦回重新提示 (M)。
      return formatConfirmReprompt();
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// (B) 確認摘要（awaiting_confirm；一行式與逐步問答共用）。
export function formatConfirmSummary(draft: CreateEventDraft): MessageDescriptor {
  return text(
    [
      '請確認開團資訊：',
      `日期：${draft.date ?? ''} ${draft.time ?? ''}`,
      `地點：${draft.location ?? ''}`,
      `人數上限：${draft.capacity ?? ''}`,
      `每人費用：${draft.price ?? ''} 元`,
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
      return text('地點不可為空，請輸入球場地點（例：東方球場）');
    case 'awaiting_capacity':
      return text('人數需為正整數（例：16）');
    case 'awaiting_price':
      return text('費用需為 0 或正整數（免費請輸入 0，例：2200）');
    case 'awaiting_confirm':
      return formatConfirmReprompt();
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// (D) 開團成功公告（確認後 reply 群組）。
export function formatOpenAnnouncement(event: EventRow): MessageDescriptor {
  return text(
    [
      `[${event.location} 球聚] 開團成功！`,
      `日期：${event.event_date} ${event.event_time}`,
      `地點：${event.location}`,
      `人數上限：${event.capacity}`,
      `每人費用：${event.price_per_person} 元`,
      '',
      '報名方式：輸入 +1（或 +N）報名，-1（或 -N）取消，名單 查看報名狀況。',
    ].join('\n'),
  );
}

// (E) 關閉報名回覆。
export function formatClosed(event: EventRow): MessageDescriptor {
  return text(`「${event.location}」球聚已關閉報名，不再接受新報名。`);
}

// (F) 取消活動回覆。
export function formatCancelled(event: EventRow): MessageDescriptor {
  return text(`「${event.location}」球聚已取消。`);
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
      `地點：${event.location}`,
      `每人費用：${event.price_per_person} 元`,
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

// (K) 一行式欄位格式錯（格式提示）。
export function formatOnelineFormatHelp(): MessageDescriptor {
  return text(
    ['格式：開團 <日期> <時間> <地點> <人數> <價格>', '例：開團 2026/08/15 07:30 東方球場 16人 2200元'].join(
      '\n',
    ),
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
