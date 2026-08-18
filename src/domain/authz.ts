// src/domain/authz.ts
//
// D-010 nit N1：抽出 `canManageEvent` 共享謂詞（原位於 event-service，D-006 §1.2），
// 供 event-service（`關閉報名`/`取消活動`）與 registration-service（`加開 N`）共用，
// 避免 R2 授權邏輯重複。**零行為變更**：語意與原 event-service 私有方法逐字一致——
//   = super-admin（注入集合、純 line_user_id 比對、不查 DB）
//     ∨ 該活動建立者（executor 經**唯讀** getByLineUserId 解析出的 user.id === event.host_user_id）。
// **唯讀不 upsert**：對非授權者不寫任何 users 列 → 滿足「非授權者無 DB 變更」（D-006 G2 / D-010 G4）。
//
// 純謂詞：不觸 LINE、不讀 env、嚴禁 any。super-admin 集合與 user reader 皆由呼叫端注入。

import type { EventRow, UserRow } from '../db/schema';

/** 授權解析所需的最小 users 唯讀介面（結構相容 UserRepository.getByLineUserId）。 */
export interface UserByLineIdReader {
  getByLineUserId(lineUserId: string): Promise<UserRow | undefined>;
}

/**
 * 生命週期/加開名額管理授權（D-006 §1.2 / D-010 §一.2）。
 * super-admin 命中即放行（不查 DB）；否則唯讀解析 executor，比對 host_user_id。
 */
export async function canManageEvent(
  users: UserByLineIdReader,
  superAdmins: ReadonlySet<string>,
  event: EventRow,
  executorLineUserId: string,
): Promise<boolean> {
  if (superAdmins.has(executorLineUserId)) return true;
  const executor = await users.getByLineUserId(executorLineUserId);
  return executor !== undefined && executor.id === event.host_user_id;
}
