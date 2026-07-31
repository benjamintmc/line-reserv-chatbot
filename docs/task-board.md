# Task Board（任務看板）

> 擁有者：orchestrator。這是跨 session、跨模型的共同記憶，每次派工前後必須更新。

## 目前階段：M4 群內管理人認領（D-006）設計中——授權改雙軌（env super-admin + 群內自助認領最多3位）。brief 決策 #7 已取代 #6。R2；APPROVED 後 T-011 實作

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-001 | 完成 project brief（彙整 requirements） | – | R0 | orchestrator | DONE | docs/00-project-brief.md | 已彙整 + 6 項決策定案 |
| T-002 | M0 專案骨架 + echo bot | – | R0 | backend-engineer | DONE | package.json, tsconfig.json, src/ | 2026-07-22 已驗證：npm install（235 packages）、build（tsc 無錯）、test（vitest 3/3 通過）、實際啟動並確認 `/health` 回 200 |
| T-003 | 本機安裝 Node.js 20+ | – | – | 使用者 | DONE | – | 確認 Node v24.18.0 / npm 11.16.0，已解除阻塞 |
| T-004 | M1 DB schema + migration | D-001（APPROVED） | R1 | backend-engineer | DONE | src/db/ | 2026-07-23 完成：build 綠、40 tests、AC 13/13、architect-reviewer Guardrails 零違反、unit-tester 真實覆蓋覆核。收尾項見 Backlog（.sql 複製、ADR-003） |
| T-005 | M1 command parser（+N/-N/名單/開團） | D-002（APPROVED） | R1 | backend-engineer | DONE | src/commands/ | 2026-07-23 完成：build 綠、83 tests、AC 39/39、architect-reviewer 審 D-002 通過、unit-tester 獨立覆核無 bug（補 17 邊界測試） |
| T-006 | M2 報名核心（signup/cancel/list domain + webhook 接線） | D-003（APPROVED） | R1 | backend-engineer | DONE | src/domain/, src/webhook/, src/db/repositories/registration-repository.ts, src/server.ts | 2026-07-31 完成：build 綠、124 tests 全綠、AC 58/58（AC-1~AC-19）、architect-reviewer 複審零 blocker G1~G11 逐條 PASS、unit-tester 獨立覆核未揪 bug（補 11 測試）。新增 findActiveProxyByName、domain 三檔、handler 改 async+DI。D-003 §4/§1.1 errata 已同步。e2e AC-17 待整合階段（見 Backlog） |
| T-007 | M2 真實 LINE 跨試（cloudflared，手動 seed open 活動） | – | R0（測試支援） | orchestrator + 使用者 | DONE | scripts/seed-open-event.ts, docs/integration-test-m2-line.md | 2026-07-31 使用者於真實 LINE 群組跨試**全數通過**：名單/+N/整批候補/取消觸發 @遞補（textV2 mention 藍字可點）/代報名 +N名字/-N名字/+99 靜默/閒聊不回覆 皆符預期。通道用 cloudflared quick tunnel（免帳號）。踩雷紀錄見 LESSONS |
| T-011 | 群內管理人認領實作（group_admins schema+migration 0003、管理人設定/我是管理人 指令、雙軌授權接入 D-004 生命週期、我的ID） | D-006（撰寫中） | R2 | backend-engineer | BLOCKED | src/db/, src/commands/, src/domain/, src/webhook/ | 等 D-006 APPROVED（R2 雙審）|
| T-010 | 逐步問答計費併為單題 awaiting_fee（真機跨試回饋；複用 validateFee、容忍空白） | D-005 §6.2 修訂 | R1 | backend-engineer | DONE | src/domain/create-flow.ts, event-formatter.ts, src/commands/validators.ts | 2026-07-31 完成：計費兩題併一題、validateFee 容忍空白、一行式零回歸。build 綠、214 tests、AC 99/99、lint 0 error。R1 兩關通過（unit-tester 無 bug 補 arity 守護、design-reviewer APPROVED）。採納 nit：提問換行分列 + 重問補「取消」 |
| T-009 | 計費模式擴充實作（price_mode/venue_fee/settled_per_person + migration 0002、均攤估算/結算、主辦自動登記、文案中性化、開團計費語法） | D-005（APPROVED） | R2 | backend-engineer | DONE | src/db/, src/commands/, src/domain/, src/webhook/ | 2026-07-31 完成：build 綠、**211 tests 全綠**、AC 99/99、lint 0 error。**R2 三關全通過**（architect+design APPROVED 零 blocker、unit-tester 無 bug 補 3 測試）。文件校正：D-005 §5.1/D-004 AC-18 errata。e2e/真機跨試待整合階段 |
| T-008 | M3 開團流程（開團/確認/關閉報名/取消活動 + event 狀態機 + host 白名單 + 逐步問答 conversation_states） | D-004（APPROVED） | R2 | backend-engineer | DONE | src/domain/, src/webhook/, src/commands/, src/db/tx.ts, src/server.ts | 2026-07-31 完成：build 綠、165 tests 全綠、AC 80/80（含 D-004 AC-1~22）、lint 0 error。**R2 三關全通過**：architect-reviewer 零 blocker（窄捕捉追認 PASS）、design-reviewer 零 blocker、unit-tester 無 bug（補 3 強化測試）。文件校正已套用（§4/§9）。e2e 留整合階段（AC-18 開團→報名銜接 + AC-17 主辦override） |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-001 | 資料模型（per-slot、候補、代報名） | architect | APPROVED（2026-07-22，reviewer 通過 + errata + 使用者核可） |
| D-002 | 指令解析 command parser（+N/-N/名單/開團；全形/上限/邊界） | backend-engineer | APPROVED（2026-07-23，reviewer 通過 + errata + 使用者核可） |
| D-003 | 報名核心（額滿判斷/整批轉候補/FIFO 遞補/名單訊息組版/webhook 接線） | backend-engineer | **APPROVED（2026-07-31）** — architect-reviewer 通過 + nit-2/5 採納 + 使用者最終核可（OP-1~4 已裁決；風險 R1） |
| D-004 | 開團流程（開團一行式/逐步問答、event 狀態機、host 白名單授權、確認/關閉/取消活動、conversation_states） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 零 blocker + design 2 blocker 已修）、OP-1~9 定案、使用者核可 |
| D-005 | 計費模式擴充（每人固定 vs 場地費均攤：估算/關閉結算/無條件進位/主辦自動登記為第一人）+ 文案中性化（忽略球種） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 條件式零 blocker + design 3 blocker 已修）、OP-1~4 定案、使用者核可。D-001 errata 已補 |
| D-006 | 群內管理人認領（管理人設定/我是管理人、每群上限3、env super-admin 併存、生命週期授權雙軌） | backend-engineer | 撰寫中（2026-07-31 派工；R2，授權模型 + 新 schema group_admins + parser 新指令；決策 #7 為輸入） |

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| （無）| T-003 已於 2026-07-22 解阻塞（Node.js 環境就緒） | – |

## Backlog（含暫緩的 TODO）
- M1 起導入 better-sqlite3（M0 暫不加，避免 native build 影響骨架驗證）。
- 代報名（`+1 名字`）與候補遞補的 e2e 案例補入 e2e-tester 清單。
- ~~`npm install` 回報 10 項 audit 漏洞~~ **已解決（2026-07-23）**：升 fastify ^4→^5、vitest ^2→^4，`npm audit` 0 vulnerabilities；build/40 tests/echo server 全綠。副帶修正：tsconfig 排除測試檔（dist 不再含 .test.js）、新增 vitest.config.ts 明確只掃 src。
- **（M5 部署前必處理，architect-reviewer T-004 審查點 10）** `build: tsc` 不會複製 `src/db/migrations/*.sql` 到 `dist/`，故生產跑編譯版（`node dist`）時 migrate 會找不到 SQL 檔而失敗。開發路徑（tsx / vitest）不受影響。處置擇一：build 後加 copy script 複製 migrations、生產改以 tsx 跑 migrate、或將 .sql 內嵌為字串 import。
- ~~補 ADR-003 記錄 better-sqlite3 版本 pin~~ **已完成（2026-07-23）**：`docs/adr/ADR-003-better-sqlite3-version-pin.md`。附帶待辦：architect 建議 CLAUDE.md §4「最新穩定版」加註「DB 驅動版本以 ADR-003 為準」——**需使用者同意才改 CLAUDE.md**（見決策待辦）。
- **（D-003 落實）** 報名/取消/遞補交易一律經 `runImmediate` 封裝（G2 守門對 DEFERRED 交易為盡力非強制）；`DATABASE_PATH` vs `DATABASE_URL` 於切 PG 時於 config 併容。
- ~~**（文件小修，architect-reviewer D-002 nit-4）** D-001 §9 command parser 誤歸 `src/domain/`~~ **已修正（2026-07-31，architect 回寫 D-001 時一併處理，指向 `src/commands/`）**。同批補入 D-001 §2/§4/§7「draft 不物化」澄清註記（D-004 OP-5 + architect-reviewer 裁定 3）。
- **（webhook 接線，M2/T-006）** `src/webhook/handler.ts` 目前仍是 M0 echo；D-003 時換用 `parseCommand` + exhaustive switch 分派，`unknown`→不回覆。architect-reviewer nit-3：handler 需從 `buildReplies` 純函式轉 async（profile fetch）並注入 repositories/lineClient（DI 或 module import 擇一），server.ts 事件 loop 需相應改動——列 T-006 實作範圍。
- **（e2e，T-006 整合）** architect-reviewer nit-1：D-003 雖標 R1，因含授權（主辦 override）+ 刪除類（soft-delete），e2e 至少需涵蓋 AC-17（主辦跨 owner 代取消觸發 FIFO 遞補）此關鍵流程。**T-006 已 DONE，此為整合階段（M3+ 或發布前）e2e-tester 待辦，未阻擋 T-006。**
- **（測試環境 flake，2026-07-31 unit-tester 回報）** `npm test` 首次冷跑偶發整批 FAIL（`Cannot read properties of undefined (reading 'config')`，better-sqlite3 原生模組在 vitest 平行 worker 冷載入的一次性 flake）；重跑即綠，非實作/測試缺陷。緩解選項：CI 加 retry、或 vitest `pool:'forks'` / `poolOptions.singleFork`。屬環境層。
- **（部署，M5）** 部署方案與免費額度分析已寫入 `docs/deployment.md`：MVP 走 Fly.io+SQLite（最省力）；未來真免費走 **Cloud Run+Neon(PG)**（已定義移植計畫：repository 換 PG、`runImmediate`→`SELECT … FOR UPDATE`、serverless「先處理再回 200」、pooler 連線）。**訊息量非瓶頸**（bot 只用 reply，不吃 LINE 200 則 push 額度）。真正落實 PG 切換時開 **ADR-004**（architect）。
- **（T-006 reviewer nit，備查非阻擋）** ①nit-2：`cancel` 的 `freedConfirmed` 取自交易外 candidates 快照而非交易內 `cancelByIds` 回傳；MVP 單實例（better-sqlite3 同步）安全，若未來多實例共用 SQLite 需改以「實際取消的 confirmed 列數」推導。②nit-3：`no_open_event` 時 list 有先 markProcessed、signup/cancel 未 mark，重送行為不對稱（皆無副作用，符各自設計）。③nit-4：`toLineMessage` 的 `{mN}` placeholder 對 display_name 含字面 `{`/`}` 理論上可能干擾 substitution，實務極少見，暫不處理。

## LINE 平台限制（2026-07-31 對照官方文件驗證 T-006 接線後記錄）
- **T-006 LINE 接線全數與官方文件相符**：①mention 用 `textV2`+`substitution`（`{type:'mention',mentionee:{type:'user',userId}}`，placeholder `{mN}`）②reply `messages` `maxItems:5`（本專案最多 2 則，安全）③`getGroupMemberProfile` 回 `displayName` 且**涵蓋未加 bot 好友之群組成員**（印證 AC-19/NFR-4）④server.ts 驗簽（`validateSignature`）+ replyToken 正確。
- **⚠️ 帳號等級限制（影響未來功能，非 MVP 阻擋）**：「取群組成員 ID 清單」(`GET /group/{id}/members/ids`) **需 verified 或 premium 官方帳號**；但「取單一成員 profile」(`getGroupMemberProfile`) **所有帳號皆可**。本專案只用單一成員 profile（userId 一律來自 webhook 事件），故**不受此限**。若未來要做「@全員」「列出未報名者」等需列舉成員的功能 → 需 verified/premium 帳號，屆時評估（記 M4 規劃）。

## 決策待辦（需使用者裁決）
- （無）CLAUDE.md §4 版本註記已於 2026-07-23 經使用者同意加註指向 ADR-003。
