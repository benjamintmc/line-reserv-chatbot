# Task Board（任務看板）

> 擁有者：orchestrator，**唯一可寫者**（見 `harness/OWNERSHIP.md`）。跨 session、跨模型的共同記憶。
> 各角色以 `docs/worklists/<role>.md` 的「狀態提議」提出 `PROPOSE → DONE`，由 orchestrator 驗證後裁定。
> 只保留未完成 + 最近 10 筆 DONE，其餘見 `docs/task-board-archive.md`。

## 目前階段：**已上線（PROD LIVE，2026-08-02）**。T-012（PG 移植）DONE + T-014（單場自動釋放，D-008）DONE，R2 全通過、271 tests 綠、AC 142/142。**部署完成**：依 `docs/deployment-runbook.md` 走完 Neon 建DB→直連 migrate(0001/0002/0003)→build/push image→Cloud Run deploy→LINE webhook Verify→真機冒煙，全數通過。線上座標見 runbook 附錄「上線座標」。Service：`https://golf-reserv-chatbot-1006751446489.asia-east1.run.app`（GCP `group-chatbot-504305` / `asia-east1` / min-instances=0 / Neon 免費層 = $0/月）。後續選項：`--min-instances=1` 消除冷啟遺失窗口（犧牲 $0）、Secret Manager 收斂 secret（post-MVP）
>
> **2026-08-05 harness 1.4.0 升級完成（T-016）**：補齊三代框架缺件、回填 CLAUDE.md、
> 反向文件化 01-architecture 與 02 指令契約（原為空白模板）、修好 3 個會產生錯誤訊號的 checks
> 缺陷並加上 GitHub Actions。下一步建議：**T-017 LESSONS 回寫清償**（5 項已達門檻卻從未回寫）。

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-018 | 分組實作（策略A 均分／策略B 逐輪 `nextRound`＋單打、`分組`/`下一輪` parser、handler + `conversation_states` session、中性組版） | D-011（APPROVED） | R1 | backend-engineer | CODE_DONE／待機器驗證 | src/domain/grouping*.ts, src/commands/, src/webhook/, src/server.ts | 2026-08-17 已 commit 於分支 `feat/D-011-grouping`（4 測試檔、24 AC 標記、無 any）。**靜態審查雙 PASS**（architect：service 分層/session 互斥 OK；design：文案中性 OK）。**待家中機器跑 lint/build/test（docker PG:5433）綠 → 標 DONE**。偏差 grouping-service.ts 審查 PASS。＋2026-08-17 errata：場地名天干→A-Z、`分組`/`下一輪` 改 host-only（排除 super-admin）、新增 `formatGroupNotHost` |
| T-019 | 加開名額實作（`加開 N` 新增量、鎖內改 capacity + 立即遞補、host∪super-admin 授權、單則公告+遞補、新原語 `updateCapacity`） | D-010（APPROVED） | R2 | backend-engineer | IN_PROGRESS | src/domain/registration-service.ts, src/commands/, src/webhook/, src/db/ | 2026-08-17 派工。複用 T-015 promotionQuota 鎖內重算；實作後待家測 + R2 雙審 |
| T-020 | 多行批次報名實作（handler 拆行、逐行 +N/-N、複合去重鍵 `message.id#行號`、一次 reply≤5則合併、上限20整則拒絕） | D-012（APPROVED） | R1 | backend-engineer | IN_PROGRESS | src/webhook/handler.ts, src/domain/ | 2026-08-17 派工。不動 registration-service 核心；實作後待家測 + design-reviewer |

## M5 部署（Cloud Run + Neon PG）任務
| ID | 任務 | 設計 | 風險 | 角色 | 狀態 |
|---|---|---|---|---|---|
| ADR-004 | SQLite→Postgres + serverless(Cloud Run) 決策 | – | R2 | architect | DRAFT 完成 |
| D-007 | PG 移植 + serverless 部署設計（repository 換 PG、FOR UPDATE 併發、pooler、先處理再回200、migration PG 方言、Dockerfile、config） | – | R2 | architect | **APPROVED（2026-08-01）** — R2 雙審通過（design + architect 零 blocker）、B1 路線 A / B2 int4 IDENTITY 兩 blocker 封閉、OP-1~7 定案、使用者最終核可。解鎖 T-012 |
| T-012 | PG 移植實作（driver/repositories/migrations/serverless/Dockerfile/config） | D-007（APPROVED） | R2 | backend-engineer | **DONE（2026-08-02）**。PG-only 移植完成：pg 驅動、路線A 交易 runner（client-bound TxRepos）、5 repo async、serverless 先處理再回200、migration PG 方言、Dockerfile、docker-compose 測試。**R2 全通過**：unit-tester PASS（AC-2/3/12 真驗+反例、補連線洩漏/多事件測試）、architect-reviewer PASS（G1~G7、B1 超賣競態修復後複審封閉）、design-reviewer N/A（零 user-facing 變更）。**256 tests 綠、build/lint 0、AC 129/129**（對真 PG）。B1 修法：cancelByIds RETURNING 鎖內真值（`6f18e73`）。部署 runbook：`docs/deployment-runbook.md`。**已於 2026-08-02 上線**：Cloud Run（`group-chatbot-504305`/`asia-east1`）+ Neon pooled，health 200、LINE webhook Verify + 真機冒煙通過。座標見 runbook 附錄「上線座標」 |
| D-008 | 單場名額自動釋放（決策 #8）：合併 event_datetime、closed/過期自動釋放、ux_events_active_group active 集合移除 closed、惰性 on-read 過期判定、過期顯示 done | – | R2 | architect | **APPROVED（2026-08-02）** — R2 雙審通過（architect 零 blocker + design B1/B2 修訂後封閉）、使用者最終核可、剩餘名額列微選＝移除。5 Guardrails / 13 AC。解鎖 T-014 |
| T-014 | 單場自動釋放實作（migration 0003 合併 event_datetime + 改 ux active 集合、event-service 過期判定/開團 flip、findOpenEventForSignup/findEventForDisplay 三讀取點、phase 名單 formatter、create-flow 存 UTC datetime、鎖內 getById 重讀）＋套用預列 errata（D-001/D-003/D-004/D-005/D-007） | D-008（APPROVED） | R2 | backend-engineer | **DONE（2026-08-02）**。單場自動釋放完整實作：0003 合併 event_datetime + 索引去 closed、開團惰性 flip 過期 open→done、三讀取點、phase 名單（已結束/已截止去暫估、移除剩餘名額列）、UTC+8 轉換、鎖內 getById 重讀防超賣。**R2 三關全通過**：architect-reviewer 零 blocker（G1~G5、errata 追認正確）、design-reviewer PASS（文案逐字符 §8）、unit-tester PASS（**37 檔 271 tests 綠**、補 4 案、零 bug）。build/lint 0、AC 142/142。errata 套 D-003/D-004/D-005 + D-001/D-007 追認。行為變更（依設計）：closed 不再能取消活動→no_active。部署 runbook 已含 0003 |
| T-015 | **bug 修復（使用者回報）**：遞補額度算錯致擱置空位無法回收 | D-003 errata B2 | R1 | orchestrator（直接實作） | **DONE（2026-08-02）**。現象：capacity=10、正取 9、`+2 陳先生` 整批候補後某人 `-1`，只遞補 1 位、仍空 1 位。根因＝D-003 G8 以 `freedConfirmed`（本次釋出數）為遞補額度，看不到 G1 整批候補留下的**擱置空位**（實作與舊設計一致 ⇒ 設計缺口非實作偏離）。修法：`registration-service.cancel` 改於鎖內重算 `promotionQuota = fresh.capacity − countConfirmed()`，觸發條件由 `freedConfirmed > 0` 放寬為 `promotionQuota > 0`（取消候補列亦可能讓擱置空位重新可用）；額度上界為容量 ⇒ 不超賣，並承接 B1 併發語意。先寫 D-003 errata（§3 step 4 / G8 / AC-21 / 討論紀錄）再實作。**274 tests 綠、AC 143/143、lint 0**。已知限制（使用者裁決先允許）：quota < 候補隊首批次人數時會拆批，見 Backlog |

## harness 維運任務
| ID | 任務 | 設計 | 風險 | 角色 | 狀態 |
|---|---|---|---|---|---|
| T-016 | **harness 1.1.0 → 1.4.0 升級 + 文件斷層修補**（框架缺件、CLAUDE.md 回填、反向文件化 01/02、checks 跨平台修正 + CI） | – | R1 | orchestrator | **DONE（2026-08-05）**。五個階段全完成：①1.2/1.3/1.4 三代缺件補齊（TOKEN-BUDGET/OWNERSHIP/審查包/worklists/2 支 check）②CLAUDE.md 補 §4 指令表、§4.5 既有專案現況、§8/§9，並校正 fastify 4→5、移除已不存在的 better-sqlite3 ③01-architecture 與 02 指令契約由 codebase 反向產生（原為空白模板）④修 3 個 checks 缺陷（cp950 假紅、Windows 路徑 no-op 假綠、粗體 APPROVED 漏檢）+ `npm run harness:check` + GitHub Actions ⑤本次歸檔。**驗證**：lint 0、build 綠、274 tests 全綠零回歸、4 項反向測試確認新檢查真的會抓 |
| T-017 | **LESSONS 回寫清償**：5 項達門檻項目轉為具體落點（CLAUDE.md 條文 / D-000 模板欄位 / reviewer checklist / 自動檢查），逐條交使用者核可後生效並補「已回寫紀錄」 | – | R1 | orchestrator | **BACKLOG**。門檻項目：①拒絕回覆去重政策不對稱（×3）②errata 治理成本（×3）③conversation state 三件套（×2）④鎖內決策輸入通則（×2）⑤user-facing 詞彙全域掃描（×2）。另 orchestrator `git add -A` 誤掃 agent WIP（×1）已直接落入 orchestrator 角色檔。**回寫機制自建立以來從未實際運轉過，「已回寫紀錄」表是空的** |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-001 | 資料模型（per-slot、候補、代報名） | architect | APPROVED（2026-07-22，reviewer 通過 + errata + 使用者核可） |
| D-002 | 指令解析 command parser（+N/-N/名單/開團；全形/上限/邊界） | backend-engineer | APPROVED（2026-07-23，reviewer 通過 + errata + 使用者核可） |
| D-003 | 報名核心（額滿判斷/整批轉候補/FIFO 遞補/名單訊息組版/webhook 接線） | backend-engineer | **APPROVED（2026-07-31）** — architect-reviewer 通過 + nit-2/5 採納 + 使用者最終核可（OP-1~4 已裁決；風險 R1） |
| D-004 | 開團流程（開團一行式/逐步問答、event 狀態機、host 白名單授權、確認/關閉/取消活動、conversation_states） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 零 blocker + design 2 blocker 已修）、OP-1~9 定案、使用者核可 |
| D-005 | 計費模式擴充（每人固定 vs 場地費均攤：估算/關閉結算/無條件進位/主辦自動登記為第一人）+ 文案中性化（忽略球種） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 條件式零 blocker + design 3 blocker 已修）、OP-1~4 定案、使用者核可。D-001 errata 已補 |
| D-006 | 授權簡化（開團全開 + 關閉/取消限建立者 host_user_id 或 super-admin；作廢管理人認領方案） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 零 blocker + design 3 blocker 已修）、OP 採建議、使用者核可 |
| D-007 | PG 移植 + serverless 部署（repository 換 PG、FOR UPDATE、pooler、先處理再回200、migration PG 方言、Dockerfile） | architect | **APPROVED（2026-08-01）** — R2 雙審通過（design + architect 零 blocker）、B1 路線 A / B2 int4 IDENTITY 兩 blocker 封閉、OP-1~7 定案、使用者最終核可 |
| D-008 | 單場名額自動釋放（合併 event_datetime、closed/過期自動釋放、惰性 on-read 過期判定、過期顯示 done） | architect | **APPROVED（2026-08-02）** — R2 雙審通過（architect 零 blocker + design B1/B2 修訂後封閉）、使用者最終核可。三讀取點語意 + 索引拆兩半 + UTC+8；5 Guardrails / 13 AC |
| D-011 | 分組（策略A 均分 3–4／策略B 多輪輪替 2v2＋單打、逐輪 `下一輪`、中性文案、conversation_states session） | backend-engineer | **APPROVED（2026-08-17）** — 使用者最終核可；4 項裁決 + 單打模式 + 逐輪揭示回填。6 Guardrails / 24 AC。解鎖 T-018 |
| D-010 | 開團後加開名額（只加不減、鎖內改 capacity + 立即遞補候補、`加開 N`、單則公告+遞補通知） | backend-engineer | **APPROVED（2026-08-17）** — R2 雙審 PASS + 使用者核可。nits 待 T-019：抽共享 authz helper、`promoteWithinLock` 共用。解鎖 T-019 |
| D-012 | 多行批次報名（一則多行、每行 `+N`/`-N` 逐行執行、`message.id#行號` 去重、一次 reply≤5則合併回覆） | backend-engineer | **APPROVED（2026-08-17）** — R1；design-reviewer PASS + 使用者核可。3 決策回填、字串釘死。解鎖 T-020 |

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| （無）| T-012 已於 2026-08-01 解阻塞（Docker Desktop 就緒，T-013 DONE） | – |

## Backlog（含暫緩的 TODO）
- **（新功能，使用者提出 2026-08-05）「我的球聚」個人待辦查詢**：使用者加官方帳號好友後，於**一對一聊天**輸入 `球聚`（裁決：**不在群組內生效**），回覆他**跨所有群組**、**已正取**且**尚未結束**的球聚清單。**功能意圖（使用者定調）：列出所有「已經確定的」球敘，讓他知道自己該去哪幾場即可**——候補不算確定，故不列出。**風險：R1**，但若需為 `registrations.owner_user_id` 建索引則升 **R2**（migration，CLAUDE.md §4.5）。**動工前必須先有 D-009 設計文件**（規格已定，可直接派 architect）。已盤點的實作前提：
  - **① 兩個必改的既有守門**：`handler.ts:342` 把所有非群組訊息直接丟棄（1:1 訊息目前**完全不會被解析**）；`:341` 只收 `message` 型別，`follow`（加好友）未接線——若要在加好友當下主動推說明訊息需一併處理。
  - **② 需要本專案第一條跨群組讀取路徑**：現行 `registration-repository` 全部以 `eventId` 為界、`event-repository` 以 `groupId` 為界，無任何以人為軸的查詢。新增 `registrations JOIN events WHERE owner_user_id=? AND cancelled_at IS NULL AND status='confirmed'`（候補不列出），reviewer 須逐條確認**使用者只看得到自己的列**。**刻意取捨（符合功能意圖）**：只候補、無正取的活動不出現在清單中——查候補狀態請於該群組用 `名單`。過期語意**必須沿用 D-008 惰性 on-read 判定**，否則會列出 status 仍為 open 的殭屍球聚；「尚未完成」建議為 `event_datetime > now() AND status ∈ {open, closed}`（closed＝已截止但活動未到，仍應顯示）。
  - **③【已裁決 2026-08-05】不顯示群組名**：使用者裁定清單只需時間、場地等活動本身資訊，毋須辨識來自哪個群組。⇒ 不呼叫 `getGroupSummary`、**不需為此開 migration**，`events` 現有欄位已足夠，本項維持 R1。（`group_id` 仍作為查詢與去重的內部鍵，只是不出現在回覆中。）
  - **④【已裁決 2026-08-05】代報名一併呈現，逐列條列**。每列格式：`YYYY-MM-DD HH:MM {{場地}} {{代報名|自己}} {{人數}}人`——以（活動 × `kind`）分組、同組合併計數；日期分隔符**對齊既有 formatter 的 `-`**（`event-formatter.ts:24`／`utcIsoToTaipei`），不另創格式。查詢條件為 `owner_user_id`（代報者即 owner，取消責任在他身上）。

- **（P1 前期研究，2026-08-05 完成）開球前提醒的 push 費用**：**結論——技術上可行、免費層夠用，但有兩個前提未定**。①`replyMessage` 不計費（本專案至今零訊息成本之因）；`push`/`multicast` 計費且**按收訊人數計，推播到群組＝按群組總人數計**。②台灣輕用量方案 200 則/月且**不可加購**、超出直接 API 錯誤＋訊息不送出。③試算：推播給正取者本人 12 則/場 ⇒ 免費層約 **16 場/月**；推播到群組（30 人）30 則/場且吵到沒報名者 ⇒ 應走個別 multicast。④**待實測**：個別推播是否要求對方已加好友（決定能否覆蓋全部報名者）。完整計費規則與方案表見 `docs/01-architecture.md`「訊息費用結構」。**尚未決定是否實作**；若要做，另需排程器（Cloud Run min-instances=0 無排程能力）與一條非 LINE 驗簽的 cron 入口 ⇒ 建議開 ADR 而非當普通 feature。
- **（H1，使用者提出 2026-08-05）開團後加開名額**：開團者對已開放報名的活動**只加開、不縮減**（裁決：本項不含縮減與改時間/地點）。**風險 R2**——直接改 `events.capacity` 即觸碰超賣防護；須於 `FOR UPDATE` 鎖內改值。**動工前需 D-010**。要點：①加開後**必須立刻遞補候補者**，可直接複用 T-015 的 `promotionQuota = fresh.capacity − countConfirmed()` 鎖內重算路徑（額度上界為容量 ⇒ 不超賣）②授權沿用 `canManageEvent`（host_user_id ∪ super-admin，同 `關閉報名`）③需新指令與 D-002 dispatch 增列，並定義加開後的公告文案與遞補通知的關係（同一則或兩則）④**動機**：現況無任何編輯指令，唯一 workaround 是 `取消活動` 再 `開團`——那會產生全新一場、報名全數歸零、候補 FIFO 順序全毀。
- **（H2，使用者提出 2026-08-05）關閉報名時 @ 正取者**：`關閉報名` 的回覆**在同一則訊息內** mention 所有正取者（裁決：單則，不拆多則）。代報名列**只 tag 報名者本人（代報者）**，被代報的人頭無 userId、不 tag。**風險 R1**（無 schema 變更；mention 機制已於候補遞補通知驗證）。要點：①同一人有多列（本人＋代報）時只 tag 一次，避免重複 @ ②需確認 mention 數量上限與單則訊息長度上限，**若正取人數超過上限需先裁決降級行為**（截斷並附「等 N 人」或改列名不 mention）③沿用 `textV2` + `substitution`（`{mN}` placeholder）④文案需與既有 `formatClosed` 整合，勿新增第二種「已截止」措辭（LESSONS ×2 詞彙一致性）。
- **（後續優化，使用者裁決 2026-08-02／T-015 衍生）整批原子遞補**：`pickWaitlistForPromotion` 以**列**為單位 `LIMIT`，當剩餘名額 < 候補隊首批次人數時會**拆散整批**（剩 1 位、隊首 `+2 陳先生` → 1 列轉正取、1 列留候補），與 G1 進場「整批不部分接受」的原子性不對稱。使用者已裁決**本次先允許拆批**。實作需求：`registrations` 新增 `batch_id` 欄位（同批共用；`0001_init.sql` 現無此欄，`seq` 無法可靠推斷批次）→ 屬 **migration ⇒ R2**（需 D-003 或新設計文件 + 雙 reviewer）。另需決策：額度塞不下隊首批次時採「跳過該批、遞補得下的後批」（不留空位但可能插隊）或「整批卡住等待」（嚴格 FIFO 但留空位）。回歸測試已釘住現行拆批行為：`[D-003 AC-21]` 第 2 案。
- 代報名（`+1 名字`）與候補遞補的 e2e 案例補入 e2e-tester 清單。
- ~~**（M5 部署前必處理，architect-reviewer T-004 審查點 10）** `build: tsc` 不複製 `src/db/migrations/*.sql` 到 `dist/`~~ **已解決（T-012）**：採「build 後加 copy script」，見 `scripts/copy-migrations.mjs` + package.json `postbuild`。已隨 2026-08-02 上線驗證。
- ~~補 ADR-003 記錄 better-sqlite3 版本 pin~~ **已完成（2026-07-23）**：`docs/adr/ADR-003-better-sqlite3-version-pin.md`。附帶待辦：architect 建議 CLAUDE.md §4「最新穩定版」加註「DB 驅動版本以 ADR-003 為準」——**需使用者同意才改 CLAUDE.md**（見決策待辦）。
- ~~**（D-003 落實）** 報名/取消/遞補交易一律經 `runImmediate` 封裝；`DATABASE_PATH` vs `DATABASE_URL` 併容~~ **已完成（T-012）**：`runImmediate` 於 PG 改為 `SELECT … FOR UPDATE`（`src/db/tx.ts`）；`DATABASE_PATH` 已隨 SQLite 一併移除，config 只剩 `databaseUrl`。
- ~~**（文件小修，architect-reviewer D-002 nit-4）** D-001 §9 command parser 誤歸 `src/domain/`~~ **已修正（2026-07-31，architect 回寫 D-001 時一併處理，指向 `src/commands/`）**。同批補入 D-001 §2/§4/§7「draft 不物化」澄清註記（D-004 OP-5 + architect-reviewer 裁定 3）。
- ~~**（webhook 接線，M2/T-006）** `src/webhook/handler.ts` 仍是 M0 echo，需換 `parseCommand` + exhaustive switch、轉 async + DI~~ **已完成（T-006）**：handler 現為完整 dispatch，`createWebhookHandler` 注入 repositories/services/lineClient。
- **（e2e，T-006 整合）** architect-reviewer nit-1：D-003 雖標 R1，因含授權（主辦 override）+ 刪除類（soft-delete），e2e 至少需涵蓋 AC-17（主辦跨 owner 代取消觸發 FIFO 遞補）此關鍵流程。**T-006 已 DONE，此為整合階段（M3+ 或發布前）e2e-tester 待辦，未阻擋 T-006。**
- ~~**（測試環境 flake）** `npm test` 冷跑偶發整批 FAIL（better-sqlite3 在 vitest 平行 worker 冷載入）~~ **已解決（2026-07-31，T-011）**：`vitest.config.ts` 設 `fileParallelism: false`（測試量小約 2s，序執行穩定、避免 CI 假紅）。
- **（T-014 reviewer nit，非阻擋）** ~~①不可達的防禦死碼（`formatAlreadyClosed`、`cancelEvent` 的 `status!=='closed'`、`closeEvent already_closed`）應加註或收斂用詞~~ **已完成（T-014 當時即採「加註保留」）**：三處皆已標「D-008 不可達，保留供防禦」，見 `event-formatter.ts:197`、`event-service.ts:83/421/460`。②nit-6：`確認` 未驗 `event_datetime > NOW()`，主辦可建「即刻過期死團」——**仍未解**。看似小修，但新增拒絕分支需同時交付文案 + 無效答案重問範本 + AC（＝LESSONS ×2 的「conversation state 三件套」），**建議排在 T-017 立起該 checklist 之後**，避免再犯同型漏。
- ~~**（部署，M5）** MVP 走 Fly.io+SQLite，未來真免費走 Cloud Run+Neon(PG)，落實時開 ADR-004~~ **已完成（2026-08-02 上線）**：直接走 Cloud Run + Neon，ADR-004 已立、D-007/T-012 已交付。座標見 `docs/deployment-runbook.md`。（保留備查：**訊息量非瓶頸**——bot 只用 reply，不吃 LINE 200 則 push 額度。）
- **（T-006 reviewer nit，備查非阻擋）** ~~①nit-2：`cancel` 的 `freedConfirmed` 取自交易外快照~~ **已解決（T-012 B1）**：改由 `cancelByIds` 的 RETURNING 於鎖內取真值——**此 nit 當年預言的「未來多實例/async」條件在 T-012 成真並確實造成超賣**，見 LESSONS 2026-08-01。②nit-3：`no_open_event` 時 list 有先 markProcessed、signup/cancel 未 mark，重送行為不對稱——**仍未解**，已升級為 T-017 的第①項（同型問題累計 3 次），現況記於 `docs/02-api-contract.md`。③nit-4：`toLineMessage` 的 `{mN}` placeholder 對 display_name 含字面 `{`/`}` 理論上可干擾 substitution，實務極少見，暫不處理。

## 決策待辦（需使用者裁決）
- （無）「我的球聚」的五項決策已於 2026-08-05 全數裁決完畢（群組名、代報名、顯示格式、日期分隔符、候補、群組內是否生效），見 Backlog 該條——已具備開 D-009 設計文件的條件。
