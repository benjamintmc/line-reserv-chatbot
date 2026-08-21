# DEFINITION OF DONE — 驗收標準

## 通用（所有任務）
- [ ] `npm run harness:check` 全綠（＝ `check_ac_coverage` + `check_doc_budget` + `check_board_sync`；
      本專案一律用此入口，勿直接呼叫 `python3`，理由見 CLAUDE.md §4）
- [ ] `check_doc_budget` 無警告（或已提出切檔計畫；既有豁免清單見 `harness/doc-budget-exempt.txt`）
- [ ] R1/R2 任務已產出審查包 `docs/reviews/RP-T-xxx.md`
- [ ] commit 符合可追溯格式（`harness/checks/check_commit_trace.sh`）
- [ ] 產出存放於任務單指定路徑
- [ ] 實作者已在自己的 worklist 提出 `PROPOSE → DONE` 並附證據
- [ ] Orchestrator 驗證後於 `docs/task-board.md` 裁定並登錄產出連結
- [ ] `check_board_sync` 通過（無未裁定提議、無幽靈任務）
- [ ] 沒有未登記的 TODO（暫緩項目已寫入 Backlog）
- [ ] 設計若新增 conversation state：三件套齊備（初始提問／無效答案重問範本／對應 AC）
- [ ] 審查包已通過 diff 範圍自檢（`harness/REVIEW-PACKET-TEMPLATE.md` §3.5）

## 架構文件（architect）
- [ ] 含模組劃分、資料模型、技術選型理由、部署方式
- [ ] 重大決策皆有 ADR
- [ ] architect-reviewer 的 blocker 清空

## API 契約（api-contract-designer）
- [ ] `docs/api/openapi.yaml` 與 02 文件同步，且以 yaml 為準
- [ ] 每個 endpoint 有 schema + 範例 + 錯誤碼
- [ ] 統一錯誤格式已定義
- [ ] architect-reviewer 通過並標記「凍結」與版本號

## 前端實作（frontend-engineer）
- [ ] 對齊契約，無自創欄位
- [ ] loading / error / empty 三態齊備
- [ ] 附 unit test 且 unit-tester 通過
- [ ] design-reviewer 的 blocker 清空

## 後端實作（backend-engineer）
- [ ] 回應與錯誤格式逐字對齊契約
- [ ] 輸入驗證與 migration 齊備
- [ ] 附 unit test 且 unit-tester 通過

## 整合（e2e-tester）
- [ ] 關鍵使用者旅程全數通過
- [ ] 無未分派的整合缺陷

## R2 高風險任務（額外）
- [ ] design-reviewer 與 architect-reviewer 雙審通過
- [ ] 至少一條 e2e AC 覆蓋
- [ ] 設計文件 Guardrails ≥ 3 條且逐條有稽核紀錄

## 發布前（orchestrator 總檢）
- [ ] 上述全部滿足
- [ ] README / .env.example 與現況一致
- [ ] LESSONS.md 中達回寫門檻的項目已向使用者提案
- [ ] 向使用者完成交付摘要
