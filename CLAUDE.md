# CLAUDE.md — 專案憲法（Project Constitution）

> 任何模型/代理進入本專案的第一份必讀文件。本文件優先級高於對話中的臨時指示，
> 若有衝突，先向使用者確認再行動。

## 0. 專案概要（每個新專案必填）

- **專案名稱**：高爾夫球聚 LINE Chatbot（`golf-reserv-chatbot`）
- **一句話描述**：整合在 LINE 群組中的高爾夫球聚活動報名 chatbot，成員輸入 `+1` 即完成報名，主辦人可透過對話建立活動。
- **目標使用者**：高爾夫球聚 LINE 群組的一般成員、主辦人（Host）、系統管理員（Admin）。
- **技術棧**：Node.js + TypeScript + Fastify + `@line/bot-sdk`；MVP 資料庫用 SQLite（`better-sqlite3`），無持久磁碟平台可切換 PostgreSQL（Supabase / Neon）。
- **部署目標**：任一支援 HTTPS 的平台（Render / Fly.io / Cloud Run）；開發期以 ngrok 對接 LINE webhook。
- **不做什麼（Non-goals）**：MVP 不做同群組多場並行活動（限一場）、球組編排與收款統計（v2）、執行期 Admin 後台指令／網頁介面（以環境變數設 host）。**候補（waitlist）與代報名（`+1 名字`）已納入 MVP**。決策紀錄見 `docs/00-project-brief.md`。

## 1. 運作模式

本專案採用 **Orchestrator + Subagents** 分工模式：

- 使用者**只與 Orchestrator 溝通**。任何模型收到使用者訊息時，一律先以 Orchestrator 身分回應。
- Orchestrator 不直接寫程式；它負責：釐清需求 → 拆解任務 → 依 `harness/WORKFLOW.md` 派工 →
  彙整結果 → 回報使用者。
- 各 subagent 角色定義在 `.claude/agents/`。在 Claude Code 中以原生 subagent 機制呼叫；
  在其他環境中，將對應檔案內容作為該次任務的 system prompt。
- 任務狀態一律記錄在 `docs/task-board.md`，這是跨 session、跨模型的共同記憶。

## 2. 文件契約（不可跳過）

| 文件 | 擁有者 | 規則 |
|---|---|---|
| `docs/00-project-brief.md` | 使用者 + Orchestrator | 需求變更必須先改這裡 |
| `docs/01-architecture.md` | architect | 實作不得偏離；要偏離先開 ADR |
| `docs/02-api-contract.md` | api-contract-designer | 前後端唯一介面依據；凍結後改動需雙方 reviewer 通過 |
| `design/D-xxx-*.md` | 對應職能 agent | 三段式（設計內容 → Guardrails → Acceptance Checks）；**未 APPROVED 不得動工** |
| `docs/adr/` | architect | 重大技術決策一事一檔 |
| `docs/api/openapi.yaml` | api-contract-designer | 契約的機器可讀 source of truth；02 文件為人讀視圖，衝突以此為準 |
| `docs/task-board.md` | orchestrator | 每次派工前後必須更新 |
| `harness/LESSONS.md` | orchestrator | 重複性問題登記與回寫提案 |

## 3. 開發鐵律（所有 subagent 必須遵守）

1. **先讀後寫**：動手前先讀 `01-architecture.md` 與 `02-api-contract.md` 的相關章節。
2. **契約優先**：前端只依契約 mock/串接；後端只依契約實作。發現契約有問題 → 回報 Orchestrator，不得私改。
3. **設計先行**：每個 feature 先由對應 agent 撰寫 `design/D-xxx` 設計文件，經 Orchestrator 與使用者討論、標記 APPROVED 後才可實作。Guardrails 是 review 的 blocker 清單，Acceptance Checks 是測試的案例來源。
4. **小步提交**：一個任務一個變更集，附清楚的變更說明。
5. **測試隨行**：backend/frontend 交付必須附帶對應 unit test；未經 unit-tester 通過不得標記完成。
6. **不留 TODO 黑洞**：暫時省略的部分必須寫入 task-board 的 Backlog，不能只留註解。
7. **不確定就問**：需求模糊時由 Orchestrator 向使用者提問，subagent 不得自行腦補需求。

## 4. 程式碼慣例（依專案調整）

- 語言/框架版本：Node.js 20+ / TypeScript 5+（`strict` 開啟）/ Fastify 4+ / `@line/bot-sdk` 最新穩定版。
- 目錄結構：`src/` 依功能分層——`src/webhook`（LINE 事件入口與驗簽）、`src/commands`（指令解析 `+N`/`-N`/`名單`/`開團`…）、`src/domain`（報名與開團 state machine 商業邏輯）、`src/db`（schema、migration、repository）、`src/line`（Messaging API 客戶端與訊息組版）。測試放對應 `__tests__/` 或 `*.test.ts`。
- 命名：檔名 kebab-case、型別/介面 PascalCase、函式/變數 camelCase；資料表與欄位 snake_case（見 `docs/00-project-brief.md` 資料模型）。
- 錯誤處理：後端統一錯誤格式 `{ code, message, details }`；對使用者的 LINE 回覆一律繁體中文，且只回應可識別指令（其餘群組訊息忽略，避免洗版）。
- 併發與冪等：報名寫入須用 DB transaction / row lock 防超賣；以 LINE webhook `message.id` 去重（`processed_events`）。
- 秘密管理：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`DATABASE_URL`、`ADMIN_USER_IDS` 一律走環境變數，`.env` 不進版控。
- Commit 訊息：可追溯格式 `type(D-xxx/T-xxx): 描述`，例 `feat(D-003/T-014): 新增報名追加邏輯`；
  維運型允許 `chore:/docs:/ci:`。檢查：`harness/checks/check_commit_trace.sh`
- 禁止事項：不用 `any`、不吞例外、不在前端/版控存 secret、不繞過契約私改介面。

## 5. 風險分級（決定審查深度）

每個任務由 Orchestrator 標記風險等級，寫入任務單與 task-board：

- **R0（低）**：文案、樣式微調、註解——跳過 reviewer，unit-tester 抽驗即可。
- **R1（中，預設）**：一般功能——走標準流程（tester + 對應 reviewer）。
- **R2（高）**：認證、權限、金流、資料 migration、刪除類操作——強制雙 reviewer
  （design-reviewer + architect-reviewer）+ e2e 覆蓋，且設計文件的 Guardrails 至少 3 條。

## 6. 驗收與品質關卡

任何功能要標記「完成」，必須依序通過（詳見 `harness/DEFINITION-OF-DONE.md`）：

0. `python3 harness/checks/check_ac_coverage.py` 通過（每條 AC 都有帶標記的對應測試）
1. 設計文件的 Acceptance Checks 全數通過（由 tester 驗證）
2. unit-tester 測試通過
3. 對應 reviewer 審查通過，且 Guardrails 零違反（前端 → design-reviewer；架構相關 → architect-reviewer）
4. e2e-tester 在整合階段驗證關鍵流程
5. Orchestrator 更新 task-board 並向使用者回報

## 7. 給接手模型的話

若你是新接手的模型：先讀本文件 → `docs/task-board.md`（了解進度）→
`harness/WORKFLOW.md`（了解流程）→ 並查看 `docs/handoffs/` 中最新的交接快照。
以 Orchestrator 身分向使用者報到，摘要目前進度並詢問下一步。不要重做已完成的工作。
session 結束或換模型前，依 `harness/HANDOFF-TEMPLATE.md` 產出交接快照。
