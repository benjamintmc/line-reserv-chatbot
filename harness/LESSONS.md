# LESSONS — 經驗回寫（讓 harness 自我進化）

> 擁有者：orchestrator。reviewer / tester 發現的**重複性**問題記錄於此；
> 同類問題出現 ≥ 2 次即為「回寫候選」，由 Orchestrator 提案寫入 CLAUDE.md 慣例、
> 設計文件的 Guardrails 模板、或新增 harness/checks/ 自動檢查，經使用者同意後生效。

## 回寫流程
1. reviewer/tester 在報告中標記「疑似重複問題」→ Orchestrator 登記到下表。
2. 次數達 2 → Orchestrator 於階段回報時向使用者提案回寫（附建議措辭與落點）。
3. 使用者同意 → 更新目標文件，並在下表標記「已回寫（連結）」。

## 問題登記表
| 日期 | 發現者 | 問題描述 | 次數 | 狀態（觀察中/已回寫） | 回寫落點 |
|---|---|---|---|---|---|
| 2026-07-22 | backend(T-004) | better-sqlite3 最新版對新 Node ABI 常無 prebuilt，本機無 C++ 工具鏈時 node-gyp rebuild 失敗。Node 24（ABI 137）須 pin `better-sqlite3@^12.4.1` 才有 win32-x64 prebuilt。 | 1 | 觀察中 | 候選：CLAUDE.md §4 依賴版本註記 / 部署映像裝 build tools |
| 2026-07-22 | orchestrator(T-004 驗證) | 本機 `python`/`python3` 是 Windows Store app 別名 stub（exit 49、無輸出、非真 Python）；harness Python 檢查須用 `py` launcher（Python 3.9.13）。 | 1 | 觀察中 | 候選：harness/checks/README 或 check 腳本 shebang/包裝改用 py |
| 2026-07-22 | orchestrator(T-004 驗證) | backend 測試名用 `AC-n：…` 未帶 `D-001` 前綴，`check_ac_coverage.py` 需 `[D-001 AC-n]` 格式，導致覆蓋 0/13。 | 1 | 觀察中 | 候選：CLAUDE.md §6 或 backend/unit-tester agent 指示明列標記格式 |

## 已回寫紀錄（harness 演進史）
| 日期 | 回寫內容摘要 | 落點 | 版本 |
|---|---|---|---|
