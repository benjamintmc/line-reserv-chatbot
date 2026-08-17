# Task Board Archive（已完成任務歸檔）

> 由 orchestrator 定期從 task-board 移入。**此文件不進入任何 agent 的 context**，
> 僅供人工回查與稽核。

| ID | 任務 | 設計文件 | 風險 | 負責角色 | 完成日 | 產出路徑 |
|---|---|---|---|---|---|---|
| T-001 | 完成 project brief（彙整 requirements） | – | R0 | orchestrator | 2026-07-22 | docs/00-project-brief.md |
| T-002 | M0 專案骨架 + echo bot | – | R0 | backend-engineer | 2026-07-22 | package.json, tsconfig.json, src/ |
| T-003 | 本機安裝 Node.js 20+ | – | – | 使用者 | 2026-07-22 | –（Node v24.18.0 / npm 11.16.0） |
| T-004 | M1 DB schema + migration | D-001 | R1 | backend-engineer | 2026-07-23 | src/db/（40 tests、AC 13/13） |
| T-005 | M1 command parser（+N/-N/名單/開團） | D-002 | R1 | backend-engineer | 2026-07-23 | src/commands/（83 tests、AC 39/39） |
| T-007 | M2 真實 LINE 跨試（cloudflared，手動 seed） | – | R0 | orchestrator + 使用者 | 2026-07-31 | scripts/seed-open-event.ts, docs/integration-test-m2-line.md |
| T-013 | 使用者安裝 Docker Desktop（PG-only 測試前置） | – | – | 使用者 | 2026-08-01 | –（per-user 安裝於 %LOCALAPPDATA%） |
| T-006 | M2 報名核心（signup/cancel/list domain + webhook 接線） | D-003 | R1 | backend-engineer | 2026-07-31 | src/domain/, src/webhook/（124 tests、AC 58/58、R1 兩關通過） |
| T-008 | M3 開團流程（開團/確認/關閉報名/取消活動 + event 狀態機 + host 白名單 + conversation_states） | D-004 | R2 | backend-engineer | 2026-07-31 | src/domain/, src/webhook/, src/commands/, src/db/tx.ts（165 tests、AC 80/80、R2 三關全通過） |
| T-009 | 計費模式擴充實作（price_mode/venue_fee/settled_per_person + migration 0002） | D-005 | R2 | backend-engineer | 2026-07-31 | src/db/, src/commands/, src/domain/, src/webhook/（211 tests、AC 99/99、R2 三關） |
| T-010 | 逐步問答計費併為單題 awaiting_fee | D-005 §6.2 | R1 | backend-engineer | 2026-07-31 | src/domain/create-flow.ts 等（214 tests、AC 99/99、R1 兩關） |
| T-011 | 授權簡化實作（開團移除授權、關閉/取消認 host∪super-admin） | D-006 | R2 | backend-engineer | 2026-07-31 | src/domain/, src/webhook/, src/server.ts, src/index.ts（234 tests、AC 114/114、R2 三關） |

> 歸檔於 2026-08-05（harness 1.4.0 導入）：task-board 原有 15 筆 DONE，超過
> TOKEN-BUDGET 規則九的「未完成 + 最近 10 筆 DONE」上限。移出最早完成的 7 筆，
> 保留與現行程式碼直接相關的近期任務於 board 上。
>
> 同日第二次歸檔：新增「我的球聚」backlog 後 board 達 84 行（上限 80），
> `check_doc_budget` 擋下。再移出 T-006、T-008 兩筆行文最長的已結案任務——
> 實際的約束是**行數**而非 DONE 筆數，board 的定位是精簡索引，細節留在設計文件與 commit。
>
> 2026-08-17 歸檔：登記 D-011（分組）/T-018 與 D-010（加開名額）前，board 達上限。
> 移出 T-009/T-010/T-011 三筆已結案任務，並清掉數筆 ~~刪除線~~ 已解決 Backlog。
