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

> 2026-08-19 歸檔：登記 T-021（跨群修復）/D-013（conversation PK 變更）前，board 達上限。
> 移出整個「M5 部署（Cloud Run + Neon PG）」段落——該段 6 筆全數結案且 PROD 已於
> 2026-08-02 上線，結論已由 board 開頭的「目前階段」摘要涵蓋，細節見設計文件與 runbook。

## M5 部署（Cloud Run + Neon PG）——2026-08-19 自 board 移出
| ID | 任務 | 設計 | 風險 | 角色 | 狀態 |
|---|---|---|---|---|---|
| ADR-004 | SQLite→Postgres + serverless(Cloud Run) 決策 | – | R2 | architect | DRAFT 完成 |
| D-007 | PG 移植 + serverless 部署設計（repository 換 PG、FOR UPDATE 併發、pooler、先處理再回200、migration PG 方言、Dockerfile、config） | – | R2 | architect | **APPROVED（2026-08-01）** — R2 雙審通過（design + architect 零 blocker）、B1 路線 A / B2 int4 IDENTITY 兩 blocker 封閉、OP-1~7 定案、使用者最終核可。解鎖 T-012 |
| T-012 | PG 移植實作（driver/repositories/migrations/serverless/Dockerfile/config） | D-007（APPROVED） | R2 | backend-engineer | **DONE（2026-08-02）**。PG-only 移植：pg 驅動、路線A 交易 runner（client-bound TxRepos）、5 repo async、serverless 先處理再回200、migration PG 方言、Dockerfile、docker-compose 測試。R2 全通過（unit-tester PASS、architect-reviewer PASS 含 B1 超賣競態修復複審、design-reviewer N/A）。256 tests 綠、AC 129/129。B1 修法：cancelByIds RETURNING 鎖內真值（`6f18e73`）。**2026-08-02 上線**；座標見 `docs/deployment-runbook.md` |
| D-008 | 單場名額自動釋放：合併 event_datetime、closed/過期自動釋放、ux_events_active_group active 集合移除 closed、惰性 on-read 過期判定、過期顯示 done | – | R2 | architect | **APPROVED（2026-08-02）** — R2 雙審通過、使用者核可。5 Guardrails / 13 AC。解鎖 T-014 |
| T-014 | 單場自動釋放實作（migration 0003 + event-service 過期判定/開團 flip、三讀取點、phase 名單 formatter、UTC 轉換、鎖內 getById 重讀）＋套用預列 errata | D-008（APPROVED） | R2 | backend-engineer | **DONE（2026-08-02）**。R2 三關全通過（architect 零 blocker、design PASS、unit-tester 37 檔 271 tests 綠補 4 案）。AC 142/142。行為變更（依設計）：closed 不再能取消活動→no_active |
| T-015 | **bug 修復（使用者回報）**：遞補額度算錯致擱置空位無法回收 | D-003 errata B2 | R1 | orchestrator | **DONE（2026-08-02）**。根因＝D-003 G8 以 `freedConfirmed`（本次釋出數）為遞補額度，看不到 G1 整批候補留下的擱置空位（設計缺口非實作偏離）。修法：`cancel` 於鎖內重算 `promotionQuota = fresh.capacity − countConfirmed()`，觸發條件放寬為 `promotionQuota > 0`。274 tests 綠、AC 143/143。已知限制：quota < 候補隊首批次人數時會拆批（見 board Backlog） |
