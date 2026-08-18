// src/commands/types.ts
//
// D-002 §1：`ParsedCommand` discriminated union、相關常數與原因碼。
// 嚴禁 any（G1）：每種指令的 payload 皆具體定型，以 `type` 為判別鍵。

import type { PriceMode } from '../db/schema';

/** 單次 +N/-N 的人數上限（防濫用；O-1 裁決）。 */
export const MAX_COUNT = 20;

/** 代報名 display_name 長度上限（JS string length / UTF-16 code unit 計）；超長截斷取前 20（O-4 裁決）。 */
export const MAX_PROXY_NAME_LEN = 20;

/** 一行式開團 capacity 上限（sanity 保護；events.capacity CHECK>0，D-001 §2）。 */
export const MAX_CAPACITY = 1000;

/** 分組 場數/輪數 上限（sanity；沿用 MAX_COUNT 量級，D-011 §1）。 */
export const MAX_GROUP_PARAM = 20;

/** 畸形但可辨識為某指令嘗試時，標記是哪個指令家族。 */
export type InvalidCommandKind = 'signup' | 'cancel' | 'create_event' | 'group' | 'add_capacity';

/**
 * 畸形原因（供 D-003/webhook 決定是否回提示；D-002 不決定要不要回覆）。
 * 注意：`proxy_name_too_long` 已於 O-4 裁決移除（超長改為截斷，非 invalid）。
 */
export type InvalidReason =
  | 'count_out_of_range' // +N 超過 MAX_COUNT（如 +21/+99/超大數字）；注意 +0/-0 歸 unknown 非此
  | 'create_wrong_arity' // 開團 參數數量不是 5
  | 'create_bad_date' // 日期格式/範圍錯
  | 'create_bad_time' // 時間格式/範圍錯
  | 'create_bad_capacity' // 人數非正整數
  | 'create_bad_price' // 價格非非負整數（per_person）
  | 'create_bad_venue_fee' // 場地費非正整數（split_venue；D-005 §6.1 / OP-2）
  | 'group_bad_args'; // 分組參數畸形（D-011 §1；非 {M}場/{R}輪/單打 或超界）

export type ParsedCommand =
  // 報名（含代報名）：count>=1；proxyName 存在即代報名（kind='proxy'）
  | { type: 'signup'; count: number; proxyName?: string }
  // 取消（含代報名取消）
  | { type: 'cancel'; count: number; proxyName?: string }
  // 名單 / list / LIST
  | { type: 'list' }
  // 一行式開團（欄位已正規化：date=YYYY-MM-DD、time=HH:MM、capacity/price 為整數）
  | {
      type: 'create_event_oneline';
      date: string; // 'YYYY-MM-DD'
      time: string; // 'HH:MM'（24h，零填充）
      location: string; // 原樣（僅 trim；白名單字元類已於全串正規化，見 §5）
      capacity: number; // 正整數
      /** per_person 金額（新台幣元，非負整數）；split_venue 時為 0（D-005 §6.1）。 */
      price: number;
      /** 計費模式（D-005 §6.1）。 */
      priceMode: PriceMode;
      /** 場地費總額（元）；僅 split_venue 帶值（>0），per_person 為 undefined。 */
      venueFee?: number;
    }
  // 開團（無參數）→ 進入逐步問答（流程屬 D-003）
  | { type: 'create_event_start' }
  // 開團流程：確認
  | { type: 'confirm' }
  // 開團流程：放棄（`取消`）。語意由 D-003 依 conversation_states 解讀
  | { type: 'abort' }
  // 關閉報名
  | { type: 'close_event' }
  // 取消活動
  | { type: 'cancel_event' }
  // 我的ID（私訊回 userId）
  | { type: 'my_id' }
  // 分組（D-011）：strategy='balanced'（`分組` 均分）/ 'rounds'（`分組 {M}場…` 多輪輪替）
  | {
      type: 'group';
      strategy: 'balanced' | 'rounds';
      mode: 'singles' | 'doubles';
      courts?: number; // 僅 rounds；未帶 → service 以 floor(N/courtSize) 預設
      rounds?: number; // 僅 rounds；未帶 → 不設上限
    }
  // 分組：`下一輪`（讀進行中 grouping session 產下一輪）
  | { type: 'group_next' }
  // 加開名額（D-010）：`加開 N` 對 open 活動加開 N 個名額（新增量；1..MAX_COUNT）
  | { type: 'add_capacity'; count: number }
  // 可辨識為某指令嘗試，但參數畸形；帶原因供上層決定是否回提示
  | { type: 'invalid'; command: InvalidCommandKind; reason: InvalidReason; raw: string }
  // 完全無法辨識（群組閒聊、+0/-0、sign 後非數字等）→ webhook 一律不回覆（FR-5）
  | { type: 'unknown' };
