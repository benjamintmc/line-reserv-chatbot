# ADR-001: registrations 採「一名額一列（per-slot）」而非 count 欄位

- 狀態：已採納
- 日期：2026-07-22
- 決策者：architect（審查：architect-reviewer）

## 背景
報名核心需支援三項需求：候補 FIFO 遞補（定案 #2）、代報名 `+1 名字`（定案 #4）、
名單逐位編號顯示（`名字`、`名字(2)`…，成功條件 #1）。若以「每位報名者一列 + `count` 數量」
表示，會遇到：
- 候補與正取混在同一 count 內無法表達個別名額的 FIFO 次序，遞補時無法定位「最前一位候補」。
- 代報名與本人報名混算，無法逐名額記錄 `display_name` 快照與 `kind`。
- 併發下對 count 做 `read-modify-write` 需額外邏輯，且難以逐列稽核。

## 決策
`registrations` 採 **per-slot** 設計：**一個名額一列**。每列帶
`owner_user_id`、`display_name`（快照）、`kind(self/proxy)`、`status(confirmed/waitlist)`、
`seq`（event 內單調遞增序號）、`created_at`。報名 N 位即插入 N 列；取消 N 位即標記 N 列。
有效正取數量 = `COUNT(*) WHERE status='confirmed' AND cancelled_at IS NULL`，不另存 count。

### 增訂（2026-07-22，Q3 裁決）：取消採 soft-delete
使用者取消**不刪列**，改以 soft-delete 保留稽核軌跡：新增 `cancelled_at`（NULL=有效、
非 NULL=已取消）與 `cancelled_by_user_id`（記錄執行取消者，供「原代報者/主辦人取消」稽核）。
`status` 維持僅 `confirmed`/`waitlist`（表達佇列位置），**不新增 `cancelled` 值**；有效性一律以
`cancelled_at IS NULL` 判定，避免 status 與 cancelled_at 兩處語意重疊。被取消列保留其 `seq`
（不回填、不重用）。詳見 D-001 §3。

## 理由與被放棄的替代方案
| 方案 | 優點 | 缺點 | 結果 |
|---|---|---|---|
| per-slot 一列一名額 | FIFO 遞補、代報名快照、逐位編號皆自然可表達；逐列可稽核；併發以插入 + 條件計數處理 | 列數較多（單場數十列，可忽略） | **採納** |
| 每人一列 + count 欄位 | 列數少 | 無法表達候補次序、代報名逐名額快照；count 需 read-modify-write | 放棄 |
| events 上放 `reserved_count` 快取 | 查剩餘名額快 | 與 registrations 事實來源雙寫易不一致 | 放棄（如需可 v2 加只讀快取） |
| 取消用硬 DELETE | 名單即時、查詢無需過濾 | 無取消稽核軌跡（誰/何時取消不可追） | 放棄（改 soft-delete，Q3 裁決） |
| 取消以 status 加 `cancelled` 值 | 單欄表達狀態 | 佇列位置與有效性混在同欄；遞補/計數需同時判斷多值，語意重疊 | 放棄（改正交 `cancelled_at`） |

## 影響
- `docs/01-architecture.md` 資料模型章節須以此為準。
- 有效正取數、剩餘名額一律由 `registrations` 即時聚合（且過濾 `cancelled_at IS NULL`），events 不存冗餘計數。
- 影響 D-002（報名核心）遞補、取消（soft-delete）與稽核邏輯；D-001 定義其 schema 支撐欄位與（partial）索引。
