# Task Board（任務看板）

> 擁有者：orchestrator。這是跨 session、跨模型的共同記憶，每次派工前後必須更新。

## 目前階段：M2 T-006 DONE + LINE 接線已對照官方驗證；T-007 真實 LINE 跨試工具已備妥，待使用者執行（runbook：docs/integration-test-m2-line.md）

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-001 | 完成 project brief（彙整 requirements） | – | R0 | orchestrator | DONE | docs/00-project-brief.md | 已彙整 + 6 項決策定案 |
| T-002 | M0 專案骨架 + echo bot | – | R0 | backend-engineer | DONE | package.json, tsconfig.json, src/ | 2026-07-22 已驗證：npm install（235 packages）、build（tsc 無錯）、test（vitest 3/3 通過）、實際啟動並確認 `/health` 回 200 |
| T-003 | 本機安裝 Node.js 20+ | – | – | 使用者 | DONE | – | 確認 Node v24.18.0 / npm 11.16.0，已解除阻塞 |
| T-004 | M1 DB schema + migration | D-001（APPROVED） | R1 | backend-engineer | DONE | src/db/ | 2026-07-23 完成：build 綠、40 tests、AC 13/13、architect-reviewer Guardrails 零違反、unit-tester 真實覆蓋覆核。收尾項見 Backlog（.sql 複製、ADR-003） |
| T-005 | M1 command parser（+N/-N/名單/開團） | D-002（APPROVED） | R1 | backend-engineer | DONE | src/commands/ | 2026-07-23 完成：build 綠、83 tests、AC 39/39、architect-reviewer 審 D-002 通過、unit-tester 獨立覆核無 bug（補 17 邊界測試） |
| T-006 | M2 報名核心（signup/cancel/list domain + webhook 接線） | D-003（APPROVED） | R1 | backend-engineer | DONE | src/domain/, src/webhook/, src/db/repositories/registration-repository.ts, src/server.ts | 2026-07-31 完成：build 綠、124 tests 全綠、AC 58/58（AC-1~AC-19）、architect-reviewer 複審零 blocker G1~G11 逐條 PASS、unit-tester 獨立覆核未揪 bug（補 11 測試）。新增 findActiveProxyByName、domain 三檔、handler 改 async+DI。D-003 §4/§1.1 errata 已同步。e2e AC-17 待整合階段（見 Backlog） |
| T-007 | M2 真實 LINE 跨試（ngrok，手動 seed open 活動） | – | R0（測試支援） | orchestrator + 使用者 | 待使用者執行 | scripts/seed-open-event.ts, docs/integration-test-m2-line.md | 2026-07-31 工具備妥：seed 腳本（`npm run db:seed`，實測建立/防呆皆綠）、DEBUG_WEBHOOK 事件 log（取 groupId）、.env.example 更新、逐步 runbook。build/lint/124 tests 全綠。待使用者備妥 LINE 憑證+ngrok 後照 runbook 跨試 +N/-N/名單/代報名/候補/@遞補 |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-001 | 資料模型（per-slot、候補、代報名） | architect | APPROVED（2026-07-22，reviewer 通過 + errata + 使用者核可） |
| D-002 | 指令解析 command parser（+N/-N/名單/開團；全形/上限/邊界） | backend-engineer | APPROVED（2026-07-23，reviewer 通過 + errata + 使用者核可） |
| D-003 | 報名核心（額滿判斷/整批轉候補/FIFO 遞補/名單訊息組版/webhook 接線） | backend-engineer | **APPROVED（2026-07-31）** — architect-reviewer 通過 + nit-2/5 採納 + 使用者最終核可（OP-1~4 已裁決；風險 R1） |

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
- **（文件小修，architect-reviewer D-002 nit-4）** D-001 §9 有處括號把 command parser 誤歸 `src/domain/`（實際依 CLAUDE.md §4 應在 `src/commands/`，D-002 已正確）；下次動 D-001 時順手修正措辭。
- **（webhook 接線，M2/T-006）** `src/webhook/handler.ts` 目前仍是 M0 echo；D-003 時換用 `parseCommand` + exhaustive switch 分派，`unknown`→不回覆。architect-reviewer nit-3：handler 需從 `buildReplies` 純函式轉 async（profile fetch）並注入 repositories/lineClient（DI 或 module import 擇一），server.ts 事件 loop 需相應改動——列 T-006 實作範圍。
- **（e2e，T-006 整合）** architect-reviewer nit-1：D-003 雖標 R1，因含授權（主辦 override）+ 刪除類（soft-delete），e2e 至少需涵蓋 AC-17（主辦跨 owner 代取消觸發 FIFO 遞補）此關鍵流程。**T-006 已 DONE，此為整合階段（M3+ 或發布前）e2e-tester 待辦，未阻擋 T-006。**
- **（測試環境 flake，2026-07-31 unit-tester 回報）** `npm test` 首次冷跑偶發整批 FAIL（`Cannot read properties of undefined (reading 'config')`，better-sqlite3 原生模組在 vitest 平行 worker 冷載入的一次性 flake）；重跑即綠，非實作/測試缺陷。緩解選項：CI 加 retry、或 vitest `pool:'forks'` / `poolOptions.singleFork`。屬環境層。
- **（T-006 reviewer nit，備查非阻擋）** ①nit-2：`cancel` 的 `freedConfirmed` 取自交易外 candidates 快照而非交易內 `cancelByIds` 回傳；MVP 單實例（better-sqlite3 同步）安全，若未來多實例共用 SQLite 需改以「實際取消的 confirmed 列數」推導。②nit-3：`no_open_event` 時 list 有先 markProcessed、signup/cancel 未 mark，重送行為不對稱（皆無副作用，符各自設計）。③nit-4：`toLineMessage` 的 `{mN}` placeholder 對 display_name 含字面 `{`/`}` 理論上可能干擾 substitution，實務極少見，暫不處理。

## LINE 平台限制（2026-07-31 對照官方文件驗證 T-006 接線後記錄）
- **T-006 LINE 接線全數與官方文件相符**：①mention 用 `textV2`+`substitution`（`{type:'mention',mentionee:{type:'user',userId}}`，placeholder `{mN}`）②reply `messages` `maxItems:5`（本專案最多 2 則，安全）③`getGroupMemberProfile` 回 `displayName` 且**涵蓋未加 bot 好友之群組成員**（印證 AC-19/NFR-4）④server.ts 驗簽（`validateSignature`）+ replyToken 正確。
- **⚠️ 帳號等級限制（影響未來功能，非 MVP 阻擋）**：「取群組成員 ID 清單」(`GET /group/{id}/members/ids`) **需 verified 或 premium 官方帳號**；但「取單一成員 profile」(`getGroupMemberProfile`) **所有帳號皆可**。本專案只用單一成員 profile（userId 一律來自 webhook 事件），故**不受此限**。若未來要做「@全員」「列出未報名者」等需列舉成員的功能 → 需 verified/premium 帳號，屆時評估（記 M4 規劃）。

## 決策待辦（需使用者裁決）
- （無）CLAUDE.md §4 版本註記已於 2026-07-23 經使用者同意加註指向 ADR-003。
