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

> 歸檔於 2026-08-05（harness 1.4.0 導入）：task-board 原有 15 筆 DONE，超過
> TOKEN-BUDGET 規則九的「未完成 + 最近 10 筆 DONE」上限。移出最早完成的 7 筆，
> 保留與現行程式碼直接相關的近期任務於 board 上。
