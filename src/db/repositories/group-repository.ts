import type { Queryable } from '../index';
import { nowIso } from '../time';
import type { GroupDiscoverySource, GroupRow } from '../schema';

/**
 * groups 資料存取（觸及與擴散觀測，D-018）。
 *
 * **本 repository 純屬觀測，不參與任何使用者可見邏輯**（D-018 G1）：呼叫端一律以 try/catch
 * 包覆，寫入失敗只記 log、不得中斷報名／開團。故此處刻意不做重試、不進任何既有交易（G6）。
 *
 * 全部方法 pool-bound 即可：無「讀 → 決策 → 寫」流程，故無 CLAUDE.md §4 的鎖內重讀需求
 * ——併發安全完全由 `group_id` 主鍵的 `ON CONFLICT` 承擔。
 */
export class GroupRepository {
  constructor(private readonly q: Queryable) {}

  /**
   * 首見補登：該群第一次出現時建立一列，已存在則什麼都不做。
   *
   * 這是「加了機器人但從未開團」的唯一觀測來源——功能上線前既已在群的機器人**永遠不會再收到
   * join 事件**，只能靠訊息路徑補登（D-018 §1.3）。
   *
   * @returns 本次**真的新增了一列**回傳 true；已存在回傳 false。呼叫端據此決定是否花一次
   *   LINE API 取群組名稱——確保每群一生只取一次（G4）。
   */
  async recordSeen(groupId: string, via: GroupDiscoverySource): Promise<boolean> {
    const now = nowIso();
    const res = await this.q.query(
      `INSERT INTO groups (group_id, joined_at, discovered_via, created_at, updated_at)
       VALUES ($1, $2, $3, $2, $2)
       ON CONFLICT (group_id) DO NOTHING`,
      [groupId, now, via],
    );
    return res.rowCount === 1;
  }

  /**
   * 記錄「機器人被加入群組」：新群建立一列；**曾被移出又被加回**則清空 `left_at` 復活該列。
   *
   * `DO UPDATE` 刻意不碰 `joined_at` ⇒ 重新加入時保留**首次**加入時間（D-018 AC-3）：
   * 指標問的是「這個群何時開始接觸產品」，不是最近一次。
   *
   * `xmax = 0` 是 PG 判斷「本列由本次 INSERT 新增（true）或由 DO UPDATE 命中既有列（false）」
   * 的標準寫法——新插入的列其 xmax 為 0，被更新的列則帶有本交易 id。
   *
   * @returns 新增了一列回傳 true（呼叫端據此取一次群組名稱）；復活既有列回傳 false。
   */
  async recordJoin(groupId: string): Promise<boolean> {
    const now = nowIso();
    const res = await this.q.query<{ inserted: boolean }>(
      `INSERT INTO groups (group_id, joined_at, discovered_via, created_at, updated_at)
       VALUES ($1, $2, 'join', $2, $2)
       ON CONFLICT (group_id) DO UPDATE SET left_at = NULL, updated_at = $2
       RETURNING (xmax = 0) AS inserted`,
      [groupId, now],
    );
    return res.rows[0]?.inserted ?? false;
  }

  /**
   * 記錄「機器人被移出群組」。`WHERE left_at IS NULL` 使重複的移出事件**不覆蓋**首次離開時間
   * （LINE 可能重送；D-018 AC-2）。該群從未登記過則影響 0 列（不建列——沒有加入紀錄的離開
   * 無從推斷 joined_at，寧可缺一列也不寫入假時間）。
   */
  async recordLeave(groupId: string): Promise<void> {
    const now = nowIso();
    await this.q.query(
      'UPDATE groups SET left_at = $2, updated_at = $2 WHERE group_id = $1 AND left_at IS NULL',
      [groupId, now],
    );
  }

  /** 寫入群組名稱快照（best-effort，每群一生一次；取不到就維持 NULL）。 */
  async setName(groupId: string, groupName: string): Promise<void> {
    await this.q.query(
      'UPDATE groups SET group_name = $2, updated_at = $3 WHERE group_id = $1',
      [groupId, groupName, nowIso()],
    );
  }

  async get(groupId: string): Promise<GroupRow | undefined> {
    const res = await this.q.query<GroupRow>('SELECT * FROM groups WHERE group_id = $1', [groupId]);
    return res.rows[0];
  }
}
