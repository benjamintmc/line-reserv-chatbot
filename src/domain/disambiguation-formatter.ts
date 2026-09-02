// src/domain/disambiguation-formatter.ts
//
// D-026 §5.2 / D-024 §4.3（顯示截斷）：多場並行消歧義的四個拒絕文案 + 顯示截斷純函式。
//
// 檔案位置為使用者裁決（2026-09-02）：四個 formatter 與 `truncateForDisplay` 同置於本新檔，
// 與 `event-disambiguation.ts`（語意解析）對稱——解析回 `TargetResolution`，本檔只負責組版。
//
// 純函式：對 LINE SDK 零耦合、不觸 DB、不讀時鐘（比照 event-formatter / list-formatter）。
// 四段文案皆為 2026-08-31／2026-09-01 使用者裁決的**釘死字串**，不得改寫。

import type { MessageDescriptor } from './list-formatter';

function text(s: string): MessageDescriptor {
  return { text: s, mentionees: [] };
}

/**
 * `selectorRaw` 回顯截斷（D-024「顯示截斷」，NIT-2）。
 *
 * 超長輸入（例如整段貼上一大串文字後接 `@`）逐字回顯會使訊息過長。**僅在 formatter 層**截斷——
 * `TargetResolution.selectorRaw` 仍保存原始未截斷值，供測試／除錯用。
 * 上限取 20（比照既有 `MAX_PROXY_NAME_LEN=20`／`MAX_LOCATION_LEN=40` 量級中較嚴格者）：
 * 超過 `max` 字元 → 取前 `max` 字元 + `…`；`<= max` 原樣顯示、不加 `…`（邊界零截斷）。
 */
export function truncateForDisplay(s: string, max = 20): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * `ambiguous`：>1 候選、既無 `@selector` 也無引言（AC-7）。
 *
 * **相位註記（D-026）**：機制 A（`message_event_map` 寫入）屬 T-033b，故 T-033a~b 期間「回覆」
 * （引言）恆無效，唯一可用的指定方式是 `@selector`。此為釘死字串，**不因相位改寫**
 * （改了會製造第二種說法，且 T-033b 落地後須改回）。
 */
export function formatAmbiguousEvent(): MessageDescriptor {
  return text('群組內有多場球敘進行中，請回覆或標註 @場地/@時間 以指定要操作的球敘');
}

/** `conflict`：引言與 `@selector` 同時給了，卻指向不同活動（D-025 釘死字串）。 */
export function formatEventConflict(): MessageDescriptor {
  return text('回覆與內文球敘資訊不符，請修正再試');
}

/** `not_found`：`@selector` 命中 0 場（AC-9；`{xxx}` 為 selectorRaw，超長截斷）。 */
export function formatEventNotFound(selectorRaw: string): MessageDescriptor {
  return text(`找不到符合 ${truncateForDisplay(selectorRaw)} 的球敘，請確認後再試`);
}

/** `too_many`：`@selector` 命中 >1 場（AC-10；`{xxx}` 為 selectorRaw，超長截斷）。 */
export function formatEventTooMany(selectorRaw: string): MessageDescriptor {
  return text(`有超過一場 ${truncateForDisplay(selectorRaw)} 的球敘，請修正再試`);
}
