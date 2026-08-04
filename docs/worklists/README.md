# docs/worklists/ — 各角色專屬工作區

> 制度說明見 `harness/OWNERSHIP.md`：**工作區分散、狀態真相集中**。
> 每個角色只能寫自己那份；任務狀態的真相只有 `docs/task-board.md` 一份，唯一可寫者是 Orchestrator。

## 本專案的裁剪（刻意偏離 kit v1.4.0）

kit 預設建 8 份角色 worklist。本專案只建 **4 份**：

| 已建檔 | 理由 |
|---|---|
| `backend-engineer.md` | 唯一的實作角色，T-002~T-015 幾乎全由它交付 |
| `architect.md` | D-007 / D-008 與 ADR-001~004 的擁有者 |
| `architect-reviewer.md` | R2 任務雙審之一，逐條稽核 Guardrails |
| `design-reviewer.md` | R2 任務雙審之一；**在本專案的實際職能是「LINE 對話文案／UX 審查」**（無前端 UI） |

未建檔者：`api-contract-designer`、`unit-tester`、`e2e-tester`、`frontend-engineer`。
理由：分散工作區解決的是「多角色互搶 context」，本專案 15 個任務裡實質只有一個實作角色，
先建空表是為不存在的問題付管理成本。

**補建方式**：首次派工給該角色時，複製 `_TEMPLATE.md` 為 `<role>.md`、把 `{{role}}` 換成角色名即可，
不需另行決策。`frontend-engineer` 於本專案無前端，除非範圍變更否則不會用到。

## 給 Orchestrator 的提醒

- 派工時同步在對方 worklist 的「我的佇列」登錄任務。
- 該角色完成後在「狀態提議」寫 `PROPOSE → DONE` 附證據；**由你驗證關卡後才在 task-board 裁定**。
- `npm run harness:check` 中的 `check_board_sync` 會抓兩件事：未裁定的提議、worklist 裡不存在於
  task-board 的幽靈任務 ID。
