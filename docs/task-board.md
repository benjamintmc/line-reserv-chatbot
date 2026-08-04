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
| T-011 | 授權簡化實作（開團移除授權、關閉/取消改認 host_user_id∪super-admin、我的ID 接線、super-admin 空警告）+ D-004 授權 errata | D-006（APPROVED） | R2 | backend-engineer | DONE | src/domain/, src/webhook/, src/server.ts, src/index.ts, design/D-004 | 2026-07-31 完成：build 綠、**234 tests 全綠**、AC 114/114、lint 0。**R2 三關全通過**（architect+design 零 blocker、unit-tester 無 bug 補 canManageEvent false 分支+稽核欄）。D-004 errata 回寫+inline 指標。順帶修 vitest flake（fileParallelism:false）。e2e 待整合階段 |
| T-010 | 逐步問答計費併為單題 awaiting_fee（真機跨試回饋；複用 validateFee、容忍空白） | D-005 §6.2 修訂 | R1 | backend-engineer | DONE | src/domain/create-flow.ts, event-formatter.ts, src/commands/validators.ts | 2026-07-31 完成：計費兩題併一題、validateFee 容忍空白、一行式零回歸。build 綠、214 tests、AC 99/99、lint 0 error。R1 兩關通過（unit-tester 無 bug 補 arity 守護、design-reviewer APPROVED）。採納 nit：提問換行分列 + 重問補「取消」 |
| T-009 | 計費模式擴充實作（price_mode/venue_fee/settled_per_person + migration 0002、均攤估算/結算、主辦自動登記、文案中性化、開團計費語法） | D-005（APPROVED） | R2 | backend-engineer | DONE | src/db/, src/commands/, src/domain/, src/webhook/ | 2026-07-31 完成：build 綠、**211 tests 全綠**、AC 99/99、lint 0 error。**R2 三關全通過**（architect+design APPROVED 零 blocker、unit-tester 無 bug 補 3 測試）。文件校正：D-005 §5.1/D-004 AC-18 errata。e2e/真機跨試待整合階段 |

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

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| （無）| T-012 已於 2026-08-01 解阻塞（Docker Desktop 就緒，T-013 DONE） | – |

## Backlog（含暫緩的 TODO）
- **（新功能，使用者提出 2026-08-05）「我的球聚」個人待辦查詢**：使用者加官方帳號好友後，於**一對一聊天**輸入 `球聚`，回覆他**跨所有群組**已報名（含候補）且**尚未結束**的球聚清單。**風險：R1**，但若需為 `registrations.owner_user_id` 建索引則升 **R2**（migration，CLAUDE.md §4.5）。**動工前必須先有 D-009 設計文件**。已盤點的實作前提與待決策：
  - **① 兩個必改的既有守門**：`handler.ts:342` 把所有非群組訊息直接丟棄（1:1 訊息目前**完全不會被解析**）；`:341` 只收 `message` 型別，`follow`（加好友）未接線——若要在加好友當下主動推說明訊息需一併處理。
  - **② 需要本專案第一條跨群組讀取路徑**：現行 `registration-repository` 全部以 `eventId` 為界、`event-repository` 以 `groupId` 為界，無任何以人為軸的查詢。新增 `registrations JOIN events WHERE owner_user_id=? AND cancelled_at IS NULL`，reviewer 須逐條確認**使用者只看得到自己的列**。過期語意**必須沿用 D-008 惰性 on-read 判定**，否則會列出 status 仍為 open 的殭屍球聚；「尚未完成」建議為 `event_datetime > now() AND status ∈ {open, closed}`（closed＝已截止但活動未到，仍應顯示）。
  - **③【缺資料，需使用者裁決】`events` 沒存群組名稱**，只有 `group_id`，跨群清單無法告訴使用者「這是哪一團」。選項：(a) 只用日期＋地點辨識（零成本，可能不夠）(b) 呼叫 `getGroupSummary`（每群一次 API，需確認帳號等級限制，參照「LINE 平台限制」段的前例）(c) 開團時快照群組名入 events（⇒ migration ⇒ R2）。
  - **④ 待決策**：代報名列（`kind='proxy'`）是否一併顯示（建議顯示並標示「代 XXX 報名」，取消責任在代報者）；`球聚` 是否同時在群組內生效（若是，D-002 dispatch 表需增列，並與 `名單` 的語意明確區隔）。

- **（後續優化，使用者裁決 2026-08-02／T-015 衍生）整批原子遞補**：`pickWaitlistForPromotion` 以**列**為單位 `LIMIT`，當剩餘名額 < 候補隊首批次人數時會**拆散整批**（剩 1 位、隊首 `+2 陳先生` → 1 列轉正取、1 列留候補），與 G1 進場「整批不部分接受」的原子性不對稱。使用者已裁決**本次先允許拆批**。實作需求：`registrations` 新增 `batch_id` 欄位（同批共用；`0001_init.sql` 現無此欄，`seq` 無法可靠推斷批次）→ 屬 **migration ⇒ R2**（需 D-003 或新設計文件 + 雙 reviewer）。另需決策：額度塞不下隊首批次時採「跳過該批、遞補得下的後批」（不留空位但可能插隊）或「整批卡住等待」（嚴格 FIFO 但留空位）。回歸測試已釘住現行拆批行為：`[D-003 AC-21]` 第 2 案。
- M1 起導入 better-sqlite3（M0 暫不加，避免 native build 影響骨架驗證）。
- 代報名（`+1 名字`）與候補遞補的 e2e 案例補入 e2e-tester 清單。
- ~~`npm install` 回報 10 項 audit 漏洞~~ **已解決（2026-07-23）**：升 fastify ^4→^5、vitest ^2→^4，`npm audit` 0 vulnerabilities；build/40 tests/echo server 全綠。副帶修正：tsconfig 排除測試檔（dist 不再含 .test.js）、新增 vitest.config.ts 明確只掃 src。
- **（M5 部署前必處理，architect-reviewer T-004 審查點 10）** `build: tsc` 不會複製 `src/db/migrations/*.sql` 到 `dist/`，故生產跑編譯版（`node dist`）時 migrate 會找不到 SQL 檔而失敗。開發路徑（tsx / vitest）不受影響。處置擇一：build 後加 copy script 複製 migrations、生產改以 tsx 跑 migrate、或將 .sql 內嵌為字串 import。
- ~~補 ADR-003 記錄 better-sqlite3 版本 pin~~ **已完成（2026-07-23）**：`docs/adr/ADR-003-better-sqlite3-version-pin.md`。附帶待辦：architect 建議 CLAUDE.md §4「最新穩定版」加註「DB 驅動版本以 ADR-003 為準」——**需使用者同意才改 CLAUDE.md**（見決策待辦）。
- **（D-003 落實）** 報名/取消/遞補交易一律經 `runImmediate` 封裝（G2 守門對 DEFERRED 交易為盡力非強制）；`DATABASE_PATH` vs `DATABASE_URL` 於切 PG 時於 config 併容。
- ~~**（文件小修，architect-reviewer D-002 nit-4）** D-001 §9 command parser 誤歸 `src/domain/`~~ **已修正（2026-07-31，architect 回寫 D-001 時一併處理，指向 `src/commands/`）**。同批補入 D-001 §2/§4/§7「draft 不物化」澄清註記（D-004 OP-5 + architect-reviewer 裁定 3）。
- **（webhook 接線，M2/T-006）** `src/webhook/handler.ts` 目前仍是 M0 echo；D-003 時換用 `parseCommand` + exhaustive switch 分派，`unknown`→不回覆。architect-reviewer nit-3：handler 需從 `buildReplies` 純函式轉 async（profile fetch）並注入 repositories/lineClient（DI 或 module import 擇一），server.ts 事件 loop 需相應改動——列 T-006 實作範圍。
- **（e2e，T-006 整合）** architect-reviewer nit-1：D-003 雖標 R1，因含授權（主辦 override）+ 刪除類（soft-delete），e2e 至少需涵蓋 AC-17（主辦跨 owner 代取消觸發 FIFO 遞補）此關鍵流程。**T-006 已 DONE，此為整合階段（M3+ 或發布前）e2e-tester 待辦，未阻擋 T-006。**
- ~~**（測試環境 flake）** `npm test` 冷跑偶發整批 FAIL（better-sqlite3 在 vitest 平行 worker 冷載入）~~ **已解決（2026-07-31，T-011）**：`vitest.config.ts` 設 `fileParallelism: false`（測試量小約 2s，序執行穩定、避免 CI 假紅）。
- **（T-014 reviewer nit，非阻擋）** ①design/architect 一致指出：`event-formatter.ts formatAlreadyClosed`（(J)「活動已關閉報名。」）+ `event-service.ts cancelEvent` 的 `status!=='closed'` 防禦分支 + `closeEvent already_closed` 皆因 D-008「closed 不再由 findActiveByGroup 返回」而**不可達的防禦死碼**；可留（無害）或加註「僅防禦、實務不可達」，或把 formatAlreadyClosed 用詞收斂為「報名已截止」語系。②nit-6（D-008 §六 backlog）：`確認` 未驗 `event_datetime > NOW()`，主辦可建「即刻過期死團」——後續加 create-flow/確認 時的未來時間驗證。
- **（部署，M5）** 部署方案與免費額度分析已寫入 `docs/deployment.md`：MVP 走 Fly.io+SQLite（最省力）；未來真免費走 **Cloud Run+Neon(PG)**（已定義移植計畫：repository 換 PG、`runImmediate`→`SELECT … FOR UPDATE`、serverless「先處理再回 200」、pooler 連線）。**訊息量非瓶頸**（bot 只用 reply，不吃 LINE 200 則 push 額度）。真正落實 PG 切換時開 **ADR-004**（architect）。
- **（T-006 reviewer nit，備查非阻擋）** ①nit-2：`cancel` 的 `freedConfirmed` 取自交易外 candidates 快照而非交易內 `cancelByIds` 回傳；MVP 單實例（better-sqlite3 同步）安全，若未來多實例共用 SQLite 需改以「實際取消的 confirmed 列數」推導。②nit-3：`no_open_event` 時 list 有先 markProcessed、signup/cancel 未 mark，重送行為不對稱（皆無副作用，符各自設計）。③nit-4：`toLineMessage` 的 `{mN}` placeholder 對 display_name 含字面 `{`/`}` 理論上可能干擾 substitution，實務極少見，暫不處理。

## LINE 平台限制（2026-07-31 對照官方文件驗證 T-006 接線後記錄）
- **T-006 LINE 接線全數與官方文件相符**：①mention 用 `textV2`+`substitution`（`{type:'mention',mentionee:{type:'user',userId}}`，placeholder `{mN}`）②reply `messages` `maxItems:5`（本專案最多 2 則，安全）③`getGroupMemberProfile` 回 `displayName` 且**涵蓋未加 bot 好友之群組成員**（印證 AC-19/NFR-4）④server.ts 驗簽（`validateSignature`）+ replyToken 正確。
- **⚠️ 帳號等級限制（影響未來功能，非 MVP 阻擋）**：「取群組成員 ID 清單」(`GET /group/{id}/members/ids`) **需 verified 或 premium 官方帳號**；但「取單一成員 profile」(`getGroupMemberProfile`) **所有帳號皆可**。本專案只用單一成員 profile（userId 一律來自 webhook 事件），故**不受此限**。若未來要做「@全員」「列出未報名者」等需列舉成員的功能 → 需 verified/premium 帳號，屆時評估（記 M4 規劃）。

## 決策待辦（需使用者裁決）
- （無）CLAUDE.md §4 版本註記已於 2026-07-23 經使用者同意加註指向 ADR-003。
