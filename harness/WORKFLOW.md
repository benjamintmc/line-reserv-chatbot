# WORKFLOW — 派工流程與任務狀態機

## 專案階段（Phases）

```
Phase 0  啟動      Orchestrator 與使用者完成 00-project-brief.md
Phase 1  架構      architect 產出 01-architecture.md → architect-reviewer 審查
Phase 2  契約      api-contract-designer 產出 02-api-contract.md → architect-reviewer 審查 → 凍結
Phase 3  設計      對應職能 agent 撰寫 design/D-xxx（三段式）→ Orchestrator 與使用者
                   討論規格 → 使用者確認 → 標記 APPROVED
Phase 4  實作      frontend-engineer ∥ backend-engineer 依 APPROVED 設計平行開發
Phase 5  單元驗證  unit-tester 以 Acceptance Checks 為基準驗證（隨 Phase 4 滾動）
Phase 6  審查      design-reviewer / architect-reviewer 逐條檢查 Guardrails
Phase 7  整合驗證  e2e-tester 驗證關鍵旅程 + 跨功能的 Acceptance Checks
Phase 8  收尾      Orchestrator 彙整、更新文件、向使用者交付
```

迭代開發時，每個 feature 走 Phase 3→8 的迷你循環：
**設計（含使用者確認）→ 契約增量 → 實作 → 驗證**。

## 任務狀態機

```
BACKLOG → READY → IN_PROGRESS → IN_REVIEW → TESTING → DONE
                       ↓              ↓          ↓
                    BLOCKED ←────────┴──────────┘
```

- **READY**：相依任務完成、必讀文件就緒，才可派工。
- **BLOCKED**：必須註明阻塞原因與等待對象；Orchestrator 優先解阻塞。
- **DONE**：必須滿足 DEFINITION-OF-DONE 對應條款、`harness/checks/` 相關腳本通過，
  且 task-board 已更新。

## 風險分級（詳見 CLAUDE.md §5）

派工時每個任務必標 R0/R1/R2；R0 簡化流程、R2 加嚴（雙 reviewer + e2e 必測）。

## 上下文成本規則

派工單必須含**閱讀清單**（檔案#章節），不得只寫「請參考文件」；
預設閱讀範圍與其餘成本規則見 `harness/TOKEN-BUDGET.md`。
機器關卡（lint/test/checks）全綠前不得送模型審查。

## 派工規則

1. 每個 feature 的實作任務，必須同時滿足：對應設計文件 APPROVED + 相關契約凍結。
2. 設計文件由對應職能 agent 撰寫（分派規則見 `design/README.md`）；
   Orchestrator 只主持討論與記錄裁決，不代寫設計。
3. 一個任務只派給一個 subagent；需要協作就拆成兩個任務。
4. Reviewer 與 Tester 不得審/測自己寫的東西（單模型環境下，以獨立 session/獨立 context 執行對應角色來模擬）。
5. 契約、架構或 APPROVED 設計變更 → 凍結相依任務 → 走變更流程（提案 → architect-reviewer → 更新文件 → 解凍）。

## Session 收尾協定

每個工作 session 結束（或即將換模型）時，Orchestrator 依 `harness/HANDOFF-TEMPLATE.md`
產出交接快照存入 `docs/handoffs/`。未產出快照即中斷，視為流程違規。

## 溝通協定

- Subagent 之間不直接對話，一切經 Orchestrator 轉發，並在 task-board 留痕。
- Subagent 回報格式：`任務 ID / 狀態 / 產出路徑 / 發現的問題 / 建議下一步`。
- Orchestrator 對使用者的階段回報格式：`已完成 / 進行中 / 阻塞 / 下一步（含需要使用者決策的事項）`。
