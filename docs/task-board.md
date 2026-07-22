# Task Board（任務看板）

> 擁有者：orchestrator。這是跨 session、跨模型的共同記憶，每次派工前後必須更新。

## 目前階段：M0（環境與骨架）

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-001 | 完成 project brief（彙整 requirements） | – | R0 | orchestrator | DONE | docs/00-project-brief.md | 已彙整 + 6 項決策定案 |
| T-002 | M0 專案骨架 + echo bot | – | R0 | backend-engineer | CODE_DONE / 待驗證 | package.json, tsconfig.json, src/ | 本機無 Node，尚未 npm install / test |
| T-003 | 本機安裝 Node.js 20+ | – | – | 使用者 | BLOCKED | – | 阻塞 T-002 驗證與後續所有實作 |
| T-004 | M1 DB schema + migration | 待開 D-001 | R1 | architect + backend | BACKLOG | src/db/ | 需 per-slot schema（候補/代報名） |
| T-005 | M1 command parser（+N/-N/名單/開團） | 待開 D-002 | R1 | backend-engineer | BACKLOG | src/commands/ | 含全形/上限/邊界單元測試 |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-001 | 資料模型（per-slot、候補、代報名） | architect | 未開始 |
| D-002 | 報名核心（+N/-N/候補遞補） | backend-engineer | 未開始 |

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| T-003 | 本機未安裝 Node.js / npm，無法 install、build、test、跑 dev server | 使用者 |

## Backlog（含暫緩的 TODO）
- M1 起導入 better-sqlite3（M0 暫不加，避免 native build 影響骨架驗證）。
- 代報名（`+1 名字`）與候補遞補的 e2e 案例補入 e2e-tester 清單。

## 決策待辦（需使用者裁決）
- （無）開工前 6 項決策已於 2026-07-22 定案，見 docs/00-project-brief.md「決策紀錄」。
