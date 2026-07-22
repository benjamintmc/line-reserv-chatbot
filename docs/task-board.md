# Task Board（任務看板）

> 擁有者：orchestrator。這是跨 session、跨模型的共同記憶，每次派工前後必須更新。

## 目前階段：M1（資料層與指令解析）— T-004 資料層 DONE，接續 D-002/T-005 指令解析

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-001 | 完成 project brief（彙整 requirements） | – | R0 | orchestrator | DONE | docs/00-project-brief.md | 已彙整 + 6 項決策定案 |
| T-002 | M0 專案骨架 + echo bot | – | R0 | backend-engineer | DONE | package.json, tsconfig.json, src/ | 2026-07-22 已驗證：npm install（235 packages）、build（tsc 無錯）、test（vitest 3/3 通過）、實際啟動並確認 `/health` 回 200 |
| T-003 | 本機安裝 Node.js 20+ | – | – | 使用者 | DONE | – | 確認 Node v24.18.0 / npm 11.16.0，已解除阻塞 |
| T-004 | M1 DB schema + migration | D-001（APPROVED） | R1 | backend-engineer | DONE | src/db/ | 2026-07-23 完成：build 綠、40 tests、AC 13/13、architect-reviewer Guardrails 零違反、unit-tester 真實覆蓋覆核。收尾項見 Backlog（.sql 複製、ADR-003） |
| T-005 | M1 command parser（+N/-N/名單/開團） | 待開 D-002 | R1 | backend-engineer | READY | src/commands/ | D-001 已定案，欄位可對齊；下一步派 backend 撰寫 D-002 設計草稿（含全形/上限/邊界） |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-001 | 資料模型（per-slot、候補、代報名） | architect | APPROVED（2026-07-22，reviewer 通過 + errata + 使用者核可） |
| D-002 | 報名核心（+N/-N/候補遞補） | backend-engineer | 未開始 |

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
- **（D-002 落實）** 報名/取消/遞補交易一律經 `runImmediate` 封裝（G2 守門對 DEFERRED 交易為盡力非強制）；`DATABASE_PATH` vs `DATABASE_URL` 於切 PG 時於 config 併容。

## 決策待辦（需使用者裁決）
- （無）CLAUDE.md §4 版本註記已於 2026-07-23 經使用者同意加註指向 ADR-003。
