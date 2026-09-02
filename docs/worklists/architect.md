# Worklist — architect

> 擁有者：architect（唯一可寫者）。Orchestrator 可讀不可寫，透過派工單指派任務。
> 這裡是你的工作區：佇列、筆記、疑問、提議。**狀態真相在 `docs/task-board.md`，以那裡為準。**

## 我的佇列（由 Orchestrator 指派）
| 任務 ID | 目標 | 風險 | 我的狀態 | 備註 |
|---|---|---|---|---|

## 狀態提議（等待 Orchestrator 裁定）
| 任務 ID | 提議轉換 | 證據（審查包/測試結果/產出路徑） |
|---|---|---|
| D-021 複驗修訂落檔 | `PROPOSE → DONE` | 產出：`design/D-021-schema-unlock-and-event-reader.md`（134 → 145 行）。7 條已定案修訂全數逐字套用，落檔行號：**修訂 1**（blocker，§2 釘死 SQL 升冪）L56 新增段；**修訂 2**（AC-2 補升冪斷言＋驗證層級 repository 層）L142-145；**修訂 3**（clause 4「現況」指涉消歧義，輕改）L110-112；**修訂 4**（clause 4 恢復手段就地內聯 `@selector` + `關閉報名`／`取消活動`）L112-114；**修訂 5**（clause 3 移除條件改為可 grep 機械化檢查）L106-109；**修訂 6**（G1 carve-out 三處內聯例外）L120-122；**修訂 7**（AC checkbox 標籤 `[D-020 AC-x]` → `[D-021 AC-x]`）L138、L142。未動 AC 編號本身；L4「AC 覆蓋：待動工豁免」保留未移除；clause 4「與現況邏輯一致」等價性論證逐字保留。 |

## 工作筆記（自由書寫，不進他人 context）
- 2026-09-02 D-021 落檔：修訂 3／4 依定案採「輕改」，只置換兩個片語，clause 4 其餘文字（含「與現況邏輯一致」等價性論證）逐字保留，未做整段替換、未引入跨檔引用（D-021 須可被 backend-engineer 直接照做）。
- 修訂 6 選擇修 G1 本體加 carve-out，而非在 §1 另立例外，避免下一位 reviewer 讀到 guardrail 被架空。
- 行數 145 > 120，`check_doc_budget` 對本檔仍會印 ℹ；依 TOKEN-BUDGET 規則四 R2 不設上限，已定案雙審通過，不再拆檔。

## 我要回報給 Orchestrator 的事項
| 類型（阻塞/契約疑義/重複問題/建議） | 內容 |
|---|---|
