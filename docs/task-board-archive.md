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

## Backlog 已結案項目——2026-08-22 自 board 移出（T-017 整理）
> 以下皆已解決或已裁決不做，保留供追溯；board 只留未完成項目（doc-budget ≤ 80 行）。

- ~~**（M5 部署前必處理，architect-reviewer T-004 審查點 10）** `build: tsc` 不複製 `src/db/migrations/*.sql` 到 `dist/`~~ **已解決（T-012）**：採「build 後加 copy script」，見 `scripts/copy-migrations.mjs` + package.json `postbuild`。已隨 2026-08-02 上線驗證。
- ~~補 ADR-003 記錄 better-sqlite3 版本 pin~~ **已完成（2026-07-23）**：`docs/adr/ADR-003-better-sqlite3-version-pin.md`。（附帶待辦「CLAUDE.md §4 加註 DB 驅動版本以 ADR-003 為準」已隨 T-012 移除 better-sqlite3 而失效。）
- ~~**（D-003 落實）** 報名/取消/遞補交易一律經 `runImmediate` 封裝；`DATABASE_PATH` vs `DATABASE_URL` 併容~~ **已完成（T-012）**：`runImmediate` 於 PG 改為 `SELECT … FOR UPDATE`（`src/db/tx.ts`）；`DATABASE_PATH` 已隨 SQLite 一併移除，config 只剩 `databaseUrl`。
- ~~**（文件小修，architect-reviewer D-002 nit-4）** D-001 §9 command parser 誤歸 `src/domain/`~~ **已修正（2026-07-31）**：指向 `src/commands/`。同批補入 D-001 §2/§4/§7「draft 不物化」澄清註記（D-004 OP-5 + architect-reviewer 裁定 3）。
- ~~**（webhook 接線，M2/T-006）** `src/webhook/handler.ts` 仍是 M0 echo~~ **已完成（T-006）**：handler 現為完整 dispatch，`createWebhookHandler` 注入 repositories/services/lineClient。
- ~~**（測試環境 flake）** `npm test` 冷跑偶發整批 FAIL（better-sqlite3 在 vitest 平行 worker 冷載入）~~ **已解決（2026-07-31，T-011）**：`vitest.config.ts` 設 `fileParallelism: false`。
- ~~**（部署，M5）** MVP 走 Fly.io+SQLite，未來真免費走 Cloud Run+Neon(PG)~~ **已完成（2026-08-02 上線）**：ADR-004 已立、D-007/T-012 已交付。座標見 `docs/deployment-runbook.md`。（備查：**訊息量非瓶頸**——bot 只用 reply，不吃 LINE 200 則 push 額度。）
- **（T-014 reviewer nit）** ~~①不可達的防禦死碼（`formatAlreadyClosed`、`cancelEvent` 的 `status!=='closed'`、`closeEvent already_closed`）~~ **已完成（T-014 採「加註保留」）**：見 `event-formatter.ts:197`、`event-service.ts:83/421/460`。~~②nit-6：`確認` 未驗 `event_datetime > NOW()`，主辦可建「即刻過期死團」~~ **已裁決刪除不做（使用者，2026-08-22）**：觸發需手動輸入過去日期（機率低），後果僅「該群多打一次 `取消活動` 才能開新團」（不壞資料、不影響他人），但修它要動 `event-service.ts`（CLAUDE.md §4.5 高風險模組 ⇒ 強制 R2 雙審 + 設計文件 + conversation state 三件套）。成本效益不成立。**若日後真有使用者踩到再重開**。
- **（T-006 reviewer nit）** ~~①nit-2：`cancel` 的 `freedConfirmed` 取自交易外快照~~ **已解決（T-012 B1）**：改由 `cancelByIds` 的 RETURNING 於鎖內取真值——**此 nit 預言的「未來多實例/async」條件在 T-012 成真並確實造成超賣**，見 LESSONS 2026-08-01。~~②nit-3：`no_open_event` 時 list 有先 markProcessed、signup/cancel 未 mark~~ **規則已於 T-017 定案**（CLAUDE.md §4 去重政策），碼面收斂見 board Backlog。③nit-4：`toLineMessage` 的 `{mN}` placeholder 對 display_name 含字面 `{`/`}` 理論上可干擾 substitution，實務極少見，暫不處理（仍為備查小項）。

## 看板已結案任務——2026-08-22 自 board 移出（doc-budget ≤ 80 行）
> T-018〜T-022 五筆皆 DONE 且已隨 PR #12 merge、PROD v3 部署完成。欄位同 board。

| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-018 | 分組實作（策略A 均分／策略B 逐輪 `nextRound`＋單打、`分組`/`下一輪` parser、handler + `conversation_states` session、中性組版） | D-011（APPROVED） | R1 | backend-engineer | **DONE（2026-08-19）** | src/domain/grouping*.ts, src/commands/, src/webhook/, src/server.ts | **2026-08-19 家測全綠**（lint 0、build、**358 tests**、harness --strict、AC 184/184）。design 複審 **PASS**：B1 跨群外洩、B2 策略A 未去重 兩 blocker 皆封閉。分組測試連跑 3 次無 flaky（seed 42 確定性）。＋2026-08-17 errata（場名 A-Z、host-only）。審查包 `docs/reviews/RP-T-018.md`。**依使用者裁決與 T-022 一併 merge** |
| T-019 | 加開名額實作（`加開 N`、鎖內改 capacity + 立即遞補、authz 抽取、`updateCapacity`） | D-010（APPROVED） | R2 | backend-engineer | **DONE（2026-08-19）** | src/domain/{registration-service,authz,event-service,list-formatter}.ts, src/commands/, src/webhook/, src/db/, src/server.ts | **2026-08-19 R2 雙審全 PASS 零 blocker**：architect 確認 `promoteWithinLock` 抽取逐行等價、凍結區 `tx.ts` 逐行未變、超賣不變式論證完整；design 文案 8 項逐字符（「球敘」未重演 blocker）。AC-1..8。審查包 `RP-T-019.md`。nit 已入 Backlog（signup 的 `available` 用交易外快照，僅因 G1 單調不減而安全）|
| T-020 | 多行批次報名實作（handler 拆 dispatchSingle/handleBatch、複合去重鍵、合併回覆、上限整則拒絕） | D-012（APPROVED） | R1 | backend-engineer | **DONE（2026-08-19）** | src/webhook/handler.ts, src/domain/list-formatter.ts | **2026-08-19 PASS**。G1–G6 無違反。blocker B1（摘要未依釘死字串聚合）已修：報名/取消各聚合為「已報名：A、B」/「已取消：A、B」，落候補者各自標（候補）。取消側聚合經使用者裁決補 D-012 §一.3 errata 背書。AC-1..9。審查包 `RP-T-020.md` |
| T-022 | **D-013 實作（根治跨群）**：migration 0004（`lock_timeout`＋清 NULL＋複合 PK）、repo 簽名改 `(groupId, lineUserId)`（約 50 處測試呼叫點）、移除 `abandoned:'create'` 死碼並保留 `'grouping'`、補 D-004／D-011 errata、runbook 0004 段落 | D-013（APPROVED） | R2 | backend-engineer | **DONE（2026-08-19）** | src/db/migrations/0004_*.sql, src/db/repositories/conversation-repository.ts, src/domain/, src/webhook/, docs/deployment-runbook.md | **R2 雙審全 PASS 零 blocker**（architect：migration 逐行對設計、G1–G8 全過、`schema.ts` row 型別收斂判定「優於替代方案」、AC-3b 隔離 schema 可靠；design：AC-9 兩份 errata 品質合格、AC-7 兩處改寫照設計、AC-4 走 handler 真實路徑）。**368 tests 全綠**、AC 193/193。已採納 6 條 nit（含 2 處測試假綠通道修補與 `abandoned === 'grouping'` 明確比對） |
| T-021 | **bug 修復（使用者回報）**：`conversation_states` 跨群——A 群開團中於 B 群發言被誤判為流程答案 | D-004 errata 1–6 / D-011 errata | R2 | backend-engineer + orchestrator | **DONE（2026-08-19）** | src/webhook/handler.ts, src/domain/{event-service,grouping-service,event-formatter}.ts | 根因：PK 為 `line_user_id`（跨群唯一）、5 個讀取點皆未比對 `group_id`。三個出口：①開團問答跨群誤攔截 ②漏下去的 `確認` 把 A 群 draft 建成 **B 群**活動（更嚴重，實作者發現）③`下一輪` 外洩他群凍結名單。修法：5 讀取點全補守衛（守衛擺在 `JSON.parse` 前、回既有 `no_session` 以免用錯誤訊息反洩漏）。**architect 複審 PASS**（讀取點窮舉無遺漏、`group_id` NULL 為 fail-closed 且實務不可達、呼叫端無漏改）。**審查缺口已於 T-022 封閉**：(N2) 的 `create` 分支已隨 D-013 移除為死碼，殘留的 `grouping` 句經 T-022 design 複審逐條判定（G7 通過、AC-4 可達性實測） |

## T-023（2026-08-22 自 board 移出）

| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-023 | **開團範例日期動態產生**（4 處寫死 `2026/08/15` 已過期 → 改「今日+7 天」，時鐘以參數注入保持純函式可測） | 任務單內 stub（R0，見下方「T-023 設計 stub」） | R0 | backend-engineer | **DONE（2026-08-22）** | src/domain/event-formatter.ts, src/webhook/handler.ts, src/domain/event-formatter.billing.test.ts | **四關全綠**（lint 0、build、**371 tests**（+3）、harness --strict）。AC-1 通過且超出要求：另測時區邊界（UTC 08-21T16:30Z＝台灣 08-22 仍得 2026/08/29）與「其餘文案一字不改」回歸鎖。Guardrail 無違反——`exampleDate(nowIso)` 由 handler 注入時鐘，formatter 內無 `new Date()`。R0 依 §5 跳過 reviewer。commit `84b0a13` |

### T-023 設計 stub（R0，依 CLAUDE.md §5「R0 不建 D 檔」）
1. `event-formatter.ts` 目前 4 處把範例日期寫死為已過期的 `2026/08/15`，對新使用者是錯誤示範。
2. 改為由呼叫端注入「今日」（台灣時區），範例日期取 **今日 +7 天**，格式沿用既有 `YYYY/MM/DD`。
3. 為保持純函式（D-006 G4：formatter 對 LINE 零耦合、可純測），時鐘**以參數注入**，不得在 formatter 內呼叫 `new Date()`。
4. 僅動範例字串，其餘文案一字不改；日期格式沿用既有 `utcIsoToTaipei` 的呈現慣例，不另創格式。
- **Guardrail**：不得在 `event-formatter.ts` 內直接取系統時間（破壞純函式與可測性）。
- **AC-1**：注入 `2026-08-22` 時，`formatFlowPrompt('awaiting_date')`、`formatFieldError('awaiting_date')` 與一行式格式提示皆顯示 `2026/08/29`；注入不同日期時範例隨之改變。（執行：`npm test`）

## 2026-08-28 自 board 移出（session 結束整理；board 受 80 行上限）

### 舊「目前階段」段落（保留歷史敘述：T-012／T-014／T-016／T-017／T-023）

## 目前階段：**已上線（PROD LIVE，2026-08-02）**。T-012（PG 移植）DONE + T-014（單場自動釋放，D-008）DONE，R2 全通過、271 tests 綠、AC 142/142。**部署完成**：依 `docs/deployment-runbook.md` 走完 Neon 建DB→直連 migrate(0001/0002/0003)→build/push image→Cloud Run deploy→LINE webhook Verify→真機冒煙，全數通過。線上座標見 runbook 附錄「上線座標」。Service：`https://golf-reserv-chatbot-1006751446489.asia-east1.run.app`（GCP `group-chatbot-504305` / `asia-east1` / min-instances=0 / Neon 免費層 = $0/月）。後續選項：`--min-instances=1` 消除冷啟遺失窗口（犧牲 $0）、Secret Manager 收斂 secret（post-MVP）
>
> **2026-08-05 harness 1.4.0 升級完成（T-016）**：補齊三代框架缺件、回填 CLAUDE.md、
> 反向文件化 01-architecture 與 02 指令契約（原為空白模板）、修好 3 個會產生錯誤訊號的 checks
> 缺陷並加上 GitHub Actions。
>
> **2026-08-22 T-017 LESSONS 回寫清償完成**：9 項達門檻教訓落到 6 個點（CLAUDE.md §4 兩條通則、
> D-000 模板三處、兩份 reviewer 角色檔、審查包 §3.5、DoD 兩條），回寫機制首次成規模運轉。
> 同日裁決：nit-6（過期死團）刪除不做；範例日期改動態產生（T-023 DONE）。**PR #13 已 merge、main CI 綠**
> ——併修掉一個自 2026-08-19 起無人察覺的 **CI 永久紅**（`check_commit_trace` 誤判 squash merge；見 LESSONS）。

### 看板已結案列

| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-025 | **M7 容器強化**（補 `.dockerignore`＋runtime 階段加 `USER node`） | 任務單內 stub（R0，見下方「T-025 設計 stub」） | R0 | backend-engineer | **DONE（2026-08-22）** | Dockerfile, .dockerignore | 依 `docs/security-review-2026-08-22.md` M7。**orchestrator 獨立複驗**（未採信回報）：`/health` 自 host 與容器內皆 200、`id -u`=1000、**以 root 全樹重掃 `.env*` 零命中**（實作者原掃描為非 root、掃不到 `/root`，已補完）、全檔無 `chmod`/`chown`。零 TS 改動 ⇒ 371 tests 不可能回歸。`.dockerignore` 另排 docs/design/harness（超出任務單「至少」要求，已確認未誤排 `scripts/`／`src/`／`tsconfig.json`）。審查包 `RP-T-025.md` |
| T-018 / T-019 / T-020 / T-021 / T-022 | 分組／加開名額／多行批次報名／跨群根治（五筆） | D-010〜D-013 | R1–R2 | backend-engineer | **全數 DONE（2026-08-19）、PR #12 已 merge、PROD v3 已部署** | – | 明細已於 2026-08-22 移入 `docs/task-board-archive.md`（doc-budget ≤80 行）|

### T-025 設計 stub（M7 容器強化，R0）
1. 新增 `.dockerignore`：至少排除 `.env*`、`node_modules`、`dist`、`data`、`.git`。build context 不看 `.gitignore`，專案根目錄確實有 `.env`——多階段建置讓它不會進最終 image，但 `--target build`／BuildKit cache export 會帶著走。
2. runtime 階段（第二個 `FROM`）在 `CMD` 前加 `USER node`（node 官方 image 內建此使用者）。build 階段維持 root 以利 `npm ci`。
3. 不改 `CMD`、不改 base image、不動 build 階段既有指令。PORT 為 8080（>1024），非 root 綁定無礙。
- **Guardrail**：不得為了讓非 root 跑得動而放寬檔案權限（`chmod -R 777` 之類）或改以 root 執行；不得把任何 secret 寫進 image。
- **AC-1**：`docker build` 成功；`docker run` 後容器內 `id -u` **非 0**，且 `/health` 回 200。（執行：人工實跑，指令與輸出貼進審查包）
- **AC-2**：`docker build` 後檢查最終 image 內**不存在** `.env`。（執行：人工 `docker run --rm <image> ls -a /app`，輸出貼進審查包）


### M5 部署任務（指標性段落）

## M5 部署（Cloud Run + Neon PG）任務
> 6 筆（ADR-004／D-007／T-012／D-008／T-014／T-015）全數結案、PROD 已上線，**2026-08-19 移入 `docs/task-board-archive.md`**。結論見開頭「目前階段」與 `docs/deployment-runbook.md`。

### harness 維運任務（T-016／T-017，皆 DONE）

## harness 維運任務
| ID | 任務 | 設計 | 風險 | 角色 | 狀態 |
|---|---|---|---|---|---|
| T-016 | **harness 1.1.0 → 1.4.0 升級 + 文件斷層修補**（框架缺件、CLAUDE.md 回填、反向文件化 01/02、checks 跨平台修正 + CI） | – | R1 | orchestrator | **DONE（2026-08-05）**。五個階段全完成：①1.2/1.3/1.4 三代缺件補齊（TOKEN-BUDGET/OWNERSHIP/審查包/worklists/2 支 check）②CLAUDE.md 補 §4 指令表、§4.5 既有專案現況、§8/§9，並校正 fastify 4→5、移除已不存在的 better-sqlite3 ③01-architecture 與 02 指令契約由 codebase 反向產生（原為空白模板）④修 3 個 checks 缺陷（cp950 假紅、Windows 路徑 no-op 假綠、粗體 APPROVED 漏檢）+ `npm run harness:check` + GitHub Actions ⑤本次歸檔。**驗證**：lint 0、build 綠、274 tests 全綠零回歸、4 項反向測試確認新檢查真的會抓 |
| T-017 | **LESSONS 回寫清償**：達門檻項目轉為具體落點（CLAUDE.md 條文 / D-000 模板欄位 / reviewer checklist / 審查包自檢），逐條交使用者核可後生效並補「已回寫紀錄」 | – | R1 | orchestrator | **DONE（2026-08-22）**。**實為 9 項非 5 項**——原盤點為 2026-08-05 當時狀態，T-018~T-022 一輪又新增 4 項達門檻（狀態表 scope 比對 ×2、釘死字串失同步 ×2、AC 未落可執行機制 ×2、審查包 diff 範圍不全 ×2）。9 項全數清償，落 6 個點：`CLAUDE.md` §4（去重政策 + 鎖內決策輸入，**使用者核可動憲法**）、`design/D-000-TEMPLATE.md`（預列 errata 欄位 / conversation state 三件套表 / AC 須註明執行方式）、兩份 reviewer 角色檔固定檢查項、`REVIEW-PACKET-TEMPLATE` §3.5、`DEFINITION-OF-DONE` 通用段兩條。**本次純文件、零碼改動**；碼面收斂另立 Backlog 兩條（皆碰 R2 模組，不夾帶） |

| T-024 | **D-014 實作**（移除不可達的 `ssl` 選項與 `rejectUnauthorized`、連線字串收斂 `sslmode=verify-full`、新增 pool-ssl 測試含升級金絲雀、D-007 §5 errata、runbook／`.env.example` 同步） | D-014（**APPROVED 2026-08-22**） | R1 | orchestrator | **DONE（2026-08-23，併入 T-027 交付）** | src/db/index.ts, src/db/__tests__/pool-ssl.test.ts, 文件 | **2026-08-28 board 整理時發現本列狀態過期**：D-014 的內容即資安批次的 H1，已隨 T-027 一併實作並部署，board 卻仍掛「等待中」——會誤導後續 session 重做已完成的工作。**裁定證據（orchestrator 當場查證）**：`design/D-014` 自述「APPROVED → 已實作（T-027，2026-08-23）」；`src/db/index.ts` 已無 `rejectUnauthorized`；`pool-ssl.test.ts` 存在且 AC-1~AC-7 七條標記齊全；真機 AC-6/AC-7 已於 revision `00005-89q` 通過（見 runbook 附錄）。**教訓**：任務被另一個批次吸收時，原列必須當場改狀態並註明併入何處，否則看板會留下假的待辦 |

### 阻塞清單歷史（2026-08-28 自 board 移出；皆已結案）

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| ~~T-027 真機驗證~~ | **2026-08-23 使用者實測 `名單` 正常回覆 ⇒ 結案**。首次部署（`00005-89q`）因憑證取值錯誤全故障 33 分鐘，修復後最終 revision **`00007-pdv`** 端到端通過 | – |
| ~~（先前）~~ | **2026-08-23 全數清空**：①**跨群修復（T-021/T-022）使用者以兩個群 PROD 實測通過**——8/19 起掛著的最後一項未驗項目結案（A 群開團問答途中於 B 群發言不被攔截、不會把 A 群 draft 建成 B 群活動、`下一輪` 不外洩他群名單）。②**T-026 編輯活動資訊 PROD 正向流程實測通過**（使用者回報）。③既有 2026-08-22 已回報：分組／多行報名／加開名額三項正向流程通過。**仍未驗（不阻擋、非缺陷）**：21 人以上的 @ mention 退化路徑——需大場次才觸發，記於 `docs/backlog.md`（T-026 nit ⑦），非阻塞項故不留於本表 | – |

