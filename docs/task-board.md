# Task Board（任務看板）

> 擁有者：orchestrator，**唯一可寫者**（見 `harness/OWNERSHIP.md`）。跨 session、跨模型的共同記憶。
> 各角色以 `docs/worklists/<role>.md` 的「狀態提議」提出 `PROPOSE → DONE`，由 orchestrator 驗證後裁定。
> 只保留未完成 + 最近 10 筆 DONE，其餘見 `docs/task-board-archive.md`。

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

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-030 | **本機成長指標 dashboard**（`npm run metrics` → 讀 `docs/metrics.md` 的 SQL → 產生自足 HTML） | 無 D 檔（工具型，比照 T-016/T-017 harness 維運先例） | R1 | orchestrator | **DONE（2026-08-28）** | scripts/metrics-report.ts, src/metrics/{report.ts,report.test.ts}, package.json, .gitignore | 使用者要求「local HTML 即可」。**評估後建議不上雲並獲採納**：公開網址就得做登入（本專案分級屬 R2），為每週看一次的五個數字付認證維護成本不划算。**關卡全綠**：lint 0／build 綠／**477 tests**（+10）／harness 242/242 AC。**核心設計：SQL 零重複**——dashboard 與 AC-9 測試都從 `docs/metrics.md` 讀同一份 SQL，文件與畫面不可能脫節。**防呆兩處**：①未提供自己的 LINE userId 時，第五項指標顯示「算不出來」而非硬跑（`$1` 對不到人會把所有群組算成非我建立而灌水）②欄位不存在（metrics.md 改名）與查到 0 明確區分，不得靜默顯示 0。**資安**：輸出只寫 host/db 名，連線字串（含密碼）絕不落檔；`metrics-report.html` 已 gitignore。**視覺**：依 dataviz 規範選型為 KPI stat tiles + meter（非圖表），配色取藍色 sequential ramp + status good，**已跑驗證器：light/dark 兩模式六項檢查全 PASS**；達標與推估值皆帶文字標籤不單靠顏色。已對本機 DB 實跑驗證，數字經手算交叉核對 |
| T-029 | **觸及與擴散觀測**（新增 `groups` 表 + `join`/`leave` 接線 + 訊息路徑首見補登 + `docs/metrics.md` 五項指標 SQL） | `design/D-018-adoption-metrics.md` | R1 | orchestrator | **DONE（2026-08-28，已部署）** | src/db/migrations/0005_groups.sql, src/db/{schema,repositories/group-repository}.ts, src/webhook/handler.ts, src/server.ts, docs/metrics.md, +3 測試檔 | 起因：使用者五項成長指標中，第 5 項「非我建立的新群組」查不到——`group_id` 只在**成功開團**時才進 DB ⇒「加了機器人卻從未開團的群」在資料上不存在。**關卡全綠**：lint 0／build 綠／**467 tests**（基線 456，+11 零回歸）／harness **242/242** AC。**三項使用者裁決**：①接受 CLAUDE.md §4「不吞例外」的顯式偏離（觀測寫入失敗只記 log，報名照跑，G1）②**不做 `origin` 人工標記** ⇒ 第 5 項指標接受為**推估值**（以「我從未在其中開過團的群」近似，會把「開了第一團後放手的群」誤判為非我建立）③「再次使用」定義為參加過 2 場以上不同活動。**關鍵設計點**：首見補登置於指令分派**之前**——雜訊訊息同樣代表「機器人在這個群」，移到可識別指令之後則「加了不用」的群永遠觀測不到；名稱查詢以 `ON CONFLICT … RETURNING` 把關，每群一生一次，不落熱路徑（G4）。**踩到的既有測試**：兩處 migration 清單硬編碼盤點（`event-claiming-static` / `migrate.test`）本就設計為隨新案增長，已同步。**errata 已回填**：D-001（第 6 張表、刻意不建 FK）、D-003 §5（事件白名單擴為 message+join+leave）。**已部署 PROD**（2026-08-28）：image `:v7`／revision `00009-8zt`；`0005` 於部署前對直連套用，backfill 建 5 列（既有 5 群）。`0005` 純新增 ⇒ migrate 與部署間無不相容窗口。冒煙四項全過（`/health` 200、未簽章 401、**正確簽章 200**、pooled 連線可讀 `groups`）。**2026-08-28 真機實測全數通過（orchestrator 直接查 PROD 驗證，非採信回報）**：①`join` 建列且完全不回覆 ②`leave` 寫入 `left_at`（1分37秒後）③`getGroupSummary` **在本帳號可用**（取得「測試群二」）④新群開團/報名正常（events 11→12），觀測未干擾熱路徑。**⑤首見補登當場證明價值**：捕捉到一個 `discovered_via='message'` 的群（「匹克幫」）——機器人早已在該群、從未開過團，故不在 backfill 內，本功能上線前**完全不存在於資料庫**，正是本案要消滅的盲點。**遺留（不阻塞）**：5 列 backfill 群組的 `group_name` 為 NULL（由 SQL 直接建列，未走取名路徑），dashboard 上顯示為空；補名需一次性腳本，已記於 backlog |
| T-028 | **文案與驗證一致性收斂**（場地上限三路徑共用、closed 說法收斂、`formatEditOk` 不對空氣喊話、`editErrorField` exhaustive） | `design/D-017-copy-and-validation-consistency.md` | R1 | orchestrator | **DONE（2026-08-23，已部署）** | src/commands/{validators,parse,index}.ts, src/domain/{create-flow,event-formatter,list-formatter}.ts, src/webhook/handler.ts, +1 測試檔 | 使用者修復順序①。**關卡全綠**：lint 0／build 綠／**456 tests**（+10）／harness 233/233 AC。**六項中兩項判定為「刻意分工」不改**（「沒有活動」兩句對應報名類 vs 管理類指令；`使用者`/`代報者` fallback 語境不同）——結論寫進程式碼註解避免重複提報。**實作踩到一個陷阱**：`overflow` 退化時 targets 也是空陣列，若先判 `targets.length===0` 會把「人太多」誤判成「沒有人」而吞掉提示句（D-017 G4 已釘死順序）。**行為變更**：開團地點超過 40 字現在會被拒（先前可建出事後不能編輯的活動）。**PR #16 已 merge、CI 綠、PROD `:v6`／revision `00008-q52`**，冒煙走完 runbook §4.4 四項 |
| T-027 | **資安加固批次 H1／M2–M5**（TLS verify-full、Secret Manager、告警+帳單天花板、`{}` 跳脫、log 去 PII） | `design/D-016-security-hardening.md`＋`design/D-014`（H1） | R1 | orchestrator | **DONE（2026-08-23，真機實測通過）** | src/db/index.ts, src/webhook/handler.ts, src/config.ts, src/log-redact.ts, +3 測試檔, runbook §4, .env.example | 使用者裁決「資安類 1-5 先全部修好」。**關卡全綠**：lint 0／build 綠／**445 tests**（+7）／harness 223/223 AC。**PROD 最終 revision `00007-pdv`**：三憑證改 Secret Manager 參照、`DATABASE_URL` 收斂 `verify-full`、`--max-instances=3`、401 告警政策已建。**⚠️ 首次部署（00005）三個憑證取值錯誤（gcloud `value()` 對 list 加 `['…']` 包裝）⇒ 全部 LINE 訊息回 401、33 分鐘全故障，使用者實測才發現**；已修（secret 版本 2、壞版本已 disable）並補冒煙：帶正確簽章 `POST` 200、真實查詢連上 Neon。事故登記 LESSONS 2026-08-23。**M4 動工前查證推翻 T-006 nit-3 舊判斷**——未跳脫的單一 `{` 會被 LINE API 拒絕 ⇒ 整則回覆漏送（非僅「冒名」）。M6 使用者裁決不做 |
| T-025 | **M7 容器強化**（補 `.dockerignore`＋runtime 階段加 `USER node`） | 任務單內 stub（R0，見下方「T-025 設計 stub」） | R0 | backend-engineer | **DONE（2026-08-22）** | Dockerfile, .dockerignore | 依 `docs/security-review-2026-08-22.md` M7。**orchestrator 獨立複驗**（未採信回報）：`/health` 自 host 與容器內皆 200、`id -u`=1000、**以 root 全樹重掃 `.env*` 零命中**（實作者原掃描為非 root、掃不到 `/root`，已補完）、全檔無 `chmod`/`chown`。零 TS 改動 ⇒ 371 tests 不可能回歸。`.dockerignore` 另排 docs/design/harness（超出任務單「至少」要求，已確認未誤排 `scripts/`／`src/`／`tsconfig.json`）。審查包 `RP-T-025.md` |
| T-026 | **編輯活動資訊**（`編輯 日期/時間/場地/費用 <新值>`（`地點` 為隱藏別名，對外顯示一律「場地」）；host/admin 限定、僅 open 且未過期、不得改為過去時間、費用只改金額不切換計費模式、`編輯 人數` 導向既有 `加開 N`、**成功後 @ mention 正取者**） | D-015（**APPROVED 2026-08-22**） | **R2**（orchestrator 依 §4.5 自 R1 升等：動 `src/domain/event-service.ts`，屬預設高風險模組） | architect（設計）→ design-reviewer + architect-reviewer（雙審）→ backend-engineer（實作） | **DONE（2026-08-23）** | design/D-015-edit-event.md（設計階段） | 使用者裁決共 9 項：①指令兩條（日期/時間分開）**但 DB 維持單一 `event_datetime` 欄、不新增 migration** ②**人數一律不改**（增額走 `加開`；縮減入 backlog）③**改用 @ mention 通知正取者**（複用 D-003 §4 遞補通知的 reply + `TextMessageV2` 機制，零訊息成本；僅正取、同人去重、proxy 改 tag 代報者、**超過 LINE mention 上限則整則退化為不帶 @ 的提醒**）④不推播 ⑤reply 顯示「改前 → 改後」⑥費用不支援 per_person↔split_venue 切換 ⑦`closed` 維持不可編輯但**改用專屬拒絕文案**（因 `關閉報名` 本身已裁決要移除）⑧地點加 40 字上限（與開團路徑不一致已入 backlog）⑨升 R2。**設計須解**：日期/時間為同欄的 read-modify-write ⇒ 依 CLAUDE.md §4「決策輸入必須鎖內取得」，舊值須鎖內重讀　**＋2026-08-22 使用者追認**：§4「編輯成功後 @ 全體正取者」採用（與稍早「標記正取者不做」不牴觸——後者需付費 push，本案 @ 夾在既有 reply 內不計費）。**跨任務衝突已登記 backlog**：與「移除 `關閉報名`」相撞三處，該案設計須把 D-015 列入預列 errata　**＋2026-08-22 動工裁定**：板上原記「已核可、暫不動工」，使用者於同日改口指示動工，以即時指示為準；D-015 的「AC 覆蓋：待動工豁免」行**已由 orchestrator 移除**（15 條 AC 自此納入 `check_ac_coverage`，補測試前該關卡會紅＝施工中訊號，**不得再加豁免繞過**）。實作分支 `feat/t-026-edit-event`　**裁定證據**：四關全綠（lint 0／build／**430 tests**，基線 371 +59 零回歸／AC 覆蓋 **208/208，D-015 15/15**）——**orchestrator 親自重跑驗證，非採信回報**。**R2 雙審**：architect **PASS**（G1–G9 逐條附證據；凍結區 `tx.ts`／`migrations` diff **0 行**；接受兩項申報偏離：`listConfirmed().length` 取代 `countConfirmed()`〔WHERE 述詞逐字相同＋同交易同快照〕、`[D-010 AC-7]` 就地 20s 逾時）；design **PASS**（31 條釘死字串**字元級**比對零不一致、球種中性 12 則全過、12/20/21 人 mention 情境逐一驗）。**MAX_MENTIONS_PER_MESSAGE=20 有官方出處**（送訊方向 Text message v2 Mention object；已排除 SDK 收訊方向的同名限制，architect 獨立複核成立）。**實作暴露並修掉的設計缺陷**：§3 原寫 `費用：{費用列}`，但 `feeLine()` 自帶標籤 → 輸出重複標籤 `費用：每人費用：2500 元`；已出 errata 並同步實作與測試。**orchestrator 否決一項便宜行事**：實作者原將 `vitest.config.ts` 全域逾時 5s→20s 以掩蓋一條慢測試，已要求還原（diff 0 行）並改為單測作用域，避免鈍化整套測試的診斷力。**契約與 errata 全數回填**：`docs/02-api-contract.md` v0.2（api-contract-designer）＋ D-002／D-004／D-006／D-008／D-010 五份 errata（architect 撰稿；**D-004 因該 agent 無 Edit 工具、整檔重寫 594 行會截斷毀檔，改由 orchestrator 精準插入，內容未改動**）。7 條雙審 nit 已入 `docs/backlog.md` 不阻塞。**PR #15 已 merge（CI 兩 job 綠）**；**2026-08-23 已部署 PROD**（image `:v4`／revision `00004-f5l`；冒煙 `/health` 200、未簽章 webhook 401；**無 migration**）。**2026-08-23 使用者 PROD 實測正向流程通過**。**仍待真機驗證**：21 人以上的 @ 退化路徑（需大場次觸發，backlog ⑦） |
| T-024 | **D-014 實作**（移除不可達的 `ssl` 選項與 `rejectUnauthorized`、連線字串收斂 `sslmode=verify-full`、新增 pool-ssl 測試含升級金絲雀、D-007 §5 errata、runbook／`.env.example` 同步） | D-014（**APPROVED 2026-08-22**） | R1 | backend-engineer | **等待中**（排在 T-025 之後，避免兩個 agent 同時動同一個工作區） | src/db/index.ts, src/db/__tests__/pool-ssl.test.ts, 文件 | 動工前**須先重跑 D-014 §一 的實測**（pg 版本若已跨大版本，AC-3 金絲雀前提可能不成立）。真機 AC-6/AC-7 需部署後補驗 |
| T-018 / T-019 / T-020 / T-021 / T-022 | 分組／加開名額／多行批次報名／跨群根治（五筆） | D-010〜D-013 | R1–R2 | backend-engineer | **全數 DONE（2026-08-19）、PR #12 已 merge、PROD v3 已部署** | – | 明細已於 2026-08-22 移入 `docs/task-board-archive.md`（doc-budget ≤80 行）|

### T-025 設計 stub（M7 容器強化，R0）
1. 新增 `.dockerignore`：至少排除 `.env*`、`node_modules`、`dist`、`data`、`.git`。build context 不看 `.gitignore`，專案根目錄確實有 `.env`——多階段建置讓它不會進最終 image，但 `--target build`／BuildKit cache export 會帶著走。
2. runtime 階段（第二個 `FROM`）在 `CMD` 前加 `USER node`（node 官方 image 內建此使用者）。build 階段維持 root 以利 `npm ci`。
3. 不改 `CMD`、不改 base image、不動 build 階段既有指令。PORT 為 8080（>1024），非 root 綁定無礙。
- **Guardrail**：不得為了讓非 root 跑得動而放寬檔案權限（`chmod -R 777` 之類）或改以 root 執行；不得把任何 secret 寫進 image。
- **AC-1**：`docker build` 成功；`docker run` 後容器內 `id -u` **非 0**，且 `/health` 回 200。（執行：人工實跑，指令與輸出貼進審查包）
- **AC-2**：`docker build` 後檢查最終 image 內**不存在** `.env`。（執行：人工 `docker run --rm <image> ls -a /app`，輸出貼進審查包）


## M5 部署（Cloud Run + Neon PG）任務
> 6 筆（ADR-004／D-007／T-012／D-008／T-014／T-015）全數結案、PROD 已上線，**2026-08-19 移入 `docs/task-board-archive.md`**。結論見開頭「目前階段」與 `docs/deployment-runbook.md`。


## harness 維運任務
| ID | 任務 | 設計 | 風險 | 角色 | 狀態 |
|---|---|---|---|---|---|
| T-016 | **harness 1.1.0 → 1.4.0 升級 + 文件斷層修補**（框架缺件、CLAUDE.md 回填、反向文件化 01/02、checks 跨平台修正 + CI） | – | R1 | orchestrator | **DONE（2026-08-05）**。五個階段全完成：①1.2/1.3/1.4 三代缺件補齊（TOKEN-BUDGET/OWNERSHIP/審查包/worklists/2 支 check）②CLAUDE.md 補 §4 指令表、§4.5 既有專案現況、§8/§9，並校正 fastify 4→5、移除已不存在的 better-sqlite3 ③01-architecture 與 02 指令契約由 codebase 反向產生（原為空白模板）④修 3 個 checks 缺陷（cp950 假紅、Windows 路徑 no-op 假綠、粗體 APPROVED 漏檢）+ `npm run harness:check` + GitHub Actions ⑤本次歸檔。**驗證**：lint 0、build 綠、274 tests 全綠零回歸、4 項反向測試確認新檢查真的會抓 |
| T-017 | **LESSONS 回寫清償**：達門檻項目轉為具體落點（CLAUDE.md 條文 / D-000 模板欄位 / reviewer checklist / 審查包自檢），逐條交使用者核可後生效並補「已回寫紀錄」 | – | R1 | orchestrator | **DONE（2026-08-22）**。**實為 9 項非 5 項**——原盤點為 2026-08-05 當時狀態，T-018~T-022 一輪又新增 4 項達門檻（狀態表 scope 比對 ×2、釘死字串失同步 ×2、AC 未落可執行機制 ×2、審查包 diff 範圍不全 ×2）。9 項全數清償，落 6 個點：`CLAUDE.md` §4（去重政策 + 鎖內決策輸入，**使用者核可動憲法**）、`design/D-000-TEMPLATE.md`（預列 errata 欄位 / conversation state 三件套表 / AC 須註明執行方式）、兩份 reviewer 角色檔固定檢查項、`REVIEW-PACKET-TEMPLATE` §3.5、`DEFINITION-OF-DONE` 通用段兩條。**本次純文件、零碼改動**；碼面收斂另立 Backlog 兩條（皆碰 R2 模組，不夾帶） |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-018 | 觸及與擴散觀測（`groups` 表、join/leave 接線、訊息首見補登、指標 SQL） | **orchestrator 代筆** | **APPROVED（2026-08-28，使用者核可動工）**。R1。7 Guardrails / 9 AC。**未經設計階段 reviewer**（orchestrator 代筆＋R1，同 D-014 前例）——改以實作階段四關全綠 + AC 逐條實測補強，偏離明載於此。**G1 為 CLAUDE.md §4「不吞例外」的顯式申報偏離**（觀測失敗不得使產品失效），已獲使用者裁決。解鎖 T-029 |
| D-015 | 編輯活動資訊（`編輯 日期/時間/場地/費用`；host/admin、open 且未過期、單欄 read-modify-write 鎖內重讀、成功後 @ 正取者） | architect | **APPROVED（2026-08-22，使用者核可）**。**R2**。117 行／9 Guardrails／15 AC。**三輪雙審**：首輪雙 BLOCK 合計 5 blocker（architect：D-006 §2/G2 去重政策衝突未開 errata、G2 無專屬 AC；design：格式錯文案借用開團問答語氣製造新靜默死角、顯示標籤「場地」≠ 指令關鍵字「地點」致使用者迴圈、help 全文未釘死使 AC-10 不可執行）；複審雙 BLOCK 殘留 2（F1 兩位獨立指出 help 標籤與範例仍不對齊；**F2 事實錯誤——文件自列合法的 `編輯 費用 場地費 4000` 實際會被拒**，因 `validateVenueFee`/`validatePrice` 不吸收空白，orchestrator 已親自核對 `validators.ts` 確認）。末輪修訂 F1/F2 + 8 nit 全數落地，**orchestrator 逐條抽查確認封閉**（兩位 reviewer 均明示「改完即 PASS、不需第三輪」，故不再跑第三輪以節省最貴的一關）。architect 八點架構結論全 PASS。解鎖 T-026 |
| D-014 | DB 連線 TLS 驗證顯式化（移除不可達的 `rejectUnauthorized:false`、連線字串收斂為 `sslmode=verify-full`、升級金絲雀測試） | orchestrator | **APPROVED（2026-08-22，使用者核可動工）**。R1。4 Guardrails / 7 AC（含 2 條真機 AC）。**未經設計階段 reviewer**（orchestrator 代筆＋R1）——改以「實作階段單一 reviewer（R1 常規）＋實作者須先重跑 §一 實測」補強，此偏離已明載於此。解鎖 T-024 |
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
| D-012 | 多行批次報名（一則多行、每行 `+N`/`-N` 逐行執行、`message.id#行號` 去重、一次 reply≤5則合併回覆） | backend-engineer | **APPROVED（2026-08-17）** — R1；design-reviewer PASS + 使用者核可。3 決策回填、字串釘死。解鎖 T-020。＋2026-08-19 errata（§一.3）：取消行同報名行聚合 |
| D-013 | conversation_states PK 改 `(group_id, line_user_id)`（跨群流程並行；migration 0004、repo 簽名、(N2) 收斂） | **orchestrator 代筆**（architect 連 4 次 API 529） | **APPROVED（2026-08-19）** — R2 雙審通過（architect 2 輪 PASS／design 3 輪 PASS，**合計 10 條 blocker 全封閉**，其中 2 條為 orchestrator 修補時自行引入）+ 使用者核可。8 Guardrails / 10 AC。約束名 `conversation_states_pkey` 已對真 PG 實測查證。解鎖 T-022 |

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| ~~T-027 真機驗證~~ | **2026-08-23 使用者實測 `名單` 正常回覆 ⇒ 結案**。首次部署（`00005-89q`）因憑證取值錯誤全故障 33 分鐘，修復後最終 revision **`00007-pdv`** 端到端通過 | – |
| ~~（先前）~~ | **2026-08-23 全數清空**：①**跨群修復（T-021/T-022）使用者以兩個群 PROD 實測通過**——8/19 起掛著的最後一項未驗項目結案（A 群開團問答途中於 B 群發言不被攔截、不會把 A 群 draft 建成 B 群活動、`下一輪` 不外洩他群名單）。②**T-026 編輯活動資訊 PROD 正向流程實測通過**（使用者回報）。③既有 2026-08-22 已回報：分組／多行報名／加開名額三項正向流程通過。**仍未驗（不阻擋、非缺陷）**：21 人以上的 @ mention 退化路徑——需大場次才觸發，記於 `docs/backlog.md`（T-026 nit ⑦），非阻塞項故不留於本表 | – |

## Backlog（暫緩事項登記簿）
> **已於 2026-08-22 切出為 [`docs/backlog.md`](backlog.md)**（board 受 80 行上限、Backlog 長期累積，成長曲線不同）。
> 該檔含：已裁決不做的項目、待開設計文件的項目、技術債、e2e 待辦、資安 12 條的指標。

## 決策待辦（需使用者裁決）
- （無）「我的球聚」五項決策已於 2026-08-05 裁決完畢，規格見 `docs/00-project-brief.md` FR-7——已具備開 D-009 的條件。
