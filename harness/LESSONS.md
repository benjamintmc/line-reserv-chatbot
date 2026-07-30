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
| 2026-07-31 | orchestrator(T-007 跨試) | `npm run dev`（tsx watch）**只監看 .ts 變更，不因 .env 改動而重載**；改 env var（如 DEBUG_WEBHOOK）後必須 Ctrl+C 重啟才生效。debug 期易誤判「沒反應」。 | 1 | 觀察中 | 候選：runbook 已註記；可加開發提示 |
| 2026-07-31 | orchestrator(T-007 跨試) | LINE **Verify 成功 ≠ 使用者訊息會送 webhook**：官方帳號 Response mode 須為 **Bot**（非 Chat）、且 OA Manager Webhook 開啟、自動回應關閉，訊息事件才會進 webhook。 | 1 | 觀察中 | 候選：runbook 疑難排解（已列） |
| 2026-07-31 | orchestrator(T-007 跨試) | Windows 終端 console codepage 非 UTF-8 → Pino log 中文顯示亂碼（僅顯示層，JS 字串/DB/回覆正常）；`chcp 65001` 可解。 | 1 | 觀察中 | 候選：runbook 註記 |
| 2026-07-31 | orchestrator(T-006 驗證) | LINE `getGroupMemberProfile`（單一成員 profile）所有帳號可用；但「取成員 ID 清單」需 verified/premium。設計只用單一 profile（userId 來自 webhook）故不受限——未來若做「@全員/列未報名者」需列舉成員則需 verified 帳號。 | 1 | 觀察中 | 候選：M4 規劃 / project-brief non-goals |
| 2026-07-31 | architect+design reviewer(D-004) | **「拒絕回覆」的去重 mark 政策不對稱**：純拒絕回覆（no_open_event / 非白名單 / 無 active / 重複開團）不 markProcessed → 重送同一拒絕會重覆回一次；有副作用步驟才 mark。D-003 T-006 nit-3（list 有 mark、signup/cancel 無）與 D-004 §9 同型。 | **2（回寫候選）** | 觀察中→**達 2 次，提案回寫** | 建議：立一則通則「拒絕回覆是否消費 messageId」的統一去重政策（落 CLAUDE.md §4 或 handler 設計指引），供後續 handler 沿用，免每設計各自處理。**下次階段回報向使用者提案。** |

## 已回寫紀錄（harness 演進史）
| 日期 | 回寫內容摘要 | 落點 | 版本 |
|---|---|---|---|
