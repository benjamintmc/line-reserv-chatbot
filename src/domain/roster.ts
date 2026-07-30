// src/domain/roster.ts
//
// D-003 §9：`名字(2)` 後綴生成規則（純函式，對 DB / LINE 零耦合）。
// 分組鍵＝`(owner_user_id, display_name)`：同一人多名額才加後綴；
// 兩位不同 LINE 用戶恰好同顯示名，各自不加後綴（後綴只用於消歧「同一人的多個名額」）。
// 整體序號依有效列 seq 排序後 1-based 給定，與後綴分組獨立。嚴禁 any（G11）。

import type { RegistrationRow } from '../db/schema';

export interface RosterEntry {
  /** 1-based 顯示序號（依有效列 seq 排序）。 */
  index: number;
  /** 加後綴後的顯示名（同組第 k≥2 次出現顯示 `名字(k)`）。 */
  label: string;
  /** 來源列（供 formatter / mention 取用 owner 等欄位）。 */
  row: RegistrationRow;
}

/**
 * 分組鍵：`owner_user_id`（純數字）+ ':' + `display_name`。
 * `owner_user_id` 為整數、分隔符 ':' 非數字，故「id 與名字」的邊界無歧義，名字內含任何字元皆不致碰撞。
 */
function groupKey(row: RegistrationRow): string {
  return `${row.owner_user_id}:${row.display_name}`;
}

/**
 * 把有效名單列渲染為顯示名單（純函式）。
 * 輸入不必預排序：內部一律以 `seq` 升冪處理，確保序號與後綴計數穩定。
 */
export function buildRoster(rows: readonly RegistrationRow[]): RosterEntry[] {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const seenByGroup = new Map<string, number>();
  return sorted.map((row, i) => {
    const key = groupKey(row);
    const occurrence = (seenByGroup.get(key) ?? 0) + 1;
    seenByGroup.set(key, occurrence);
    const label = occurrence === 1 ? row.display_name : `${row.display_name}(${occurrence})`;
    return { index: i + 1, label, row };
  });
}
