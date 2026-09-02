# CLAUDE.md — 專案憲法（Project Constitution）

> 任何模型/代理進入本專案的第一份必讀文件。本文件優先級高於對話中的臨時指示，
> 若有衝突，先向使用者確認再行動。

## 0. 專案概要（每個新專案必填）

- **專案名稱**：約球 LINE Chatbot（repo 名 `golf-reserv-chatbot` 沿用自初版，未更名以免影響部署座標）
- **一句話描述**：常駐 LINE 群組的約球報名 chatbot——任何成員可 `開團` 建立活動，其他人輸入 `+1` 即完成報名，額滿自動轉候補並依序遞補。**球種中性**：活動只有「時間／場地／人數／費用」四要素，不預設也不限定球種；使用者可見文案一律中性（D-005 §3 決議），**新增文案不得引入特定球種用語**。
- **目標使用者**：約球 LINE 群組的一般成員、開團的人（活動建立者）、系統管理員（`ADMIN_USER_IDS`）。
- **技術棧**：Node.js 20+ / TypeScript / Fastify 5 / `@line/bot-sdk` 9 / **PostgreSQL（`pg`）**。版本以 §4 為準。
- **部署目標**：Cloud Run（`asia-east1`，min-instances=0）+ Neon Postgres，已於 2026-08-02 上線；開發期以 cloudflared / ngrok 對接 LINE webhook。
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
| `docs/task-board.md` | orchestrator | 每次派工前後必須更新；**唯一可寫者是 orchestrator** |
| `docs/worklists/<role>.md` | 該 role 本人 | 個人工作區；狀態真相仍以 task-board 為準（見 §8） |
| `harness/LESSONS.md` | orchestrator | 重複性問題登記與回寫提案 |
| `harness/TOKEN-BUDGET.md` | orchestrator | 上下文成本規則；派工與閱讀範圍依此（見 §9） |
| `harness/OWNERSHIP.md` | orchestrator | 誰能寫哪個檔案、狀態變更協定 |

## 3. 開發鐵律（所有 subagent 必須遵守）

1. **先讀後寫**：動手前先讀 `01-architecture.md` 與 `02-api-contract.md` 的相關章節。
2. **契約優先**：前端只依契約 mock/串接；後端只依契約實作。發現契約有問題 → 回報 Orchestrator，不得私改。
3. **設計先行**：每個 feature 先由對應 agent 撰寫 `design/D-xxx` 設計文件，經 Orchestrator 與使用者討論、標記 APPROVED 後才可實作。Guardrails 是 review 的 blocker 清單，Acceptance Checks 是測試的案例來源。
4. **小步提交**：一個任務一個變更集，附清楚的變更說明。
5. **測試隨行**：backend/frontend 交付必須附帶對應 unit test；未經 unit-tester 通過不得標記完成。
6. **不留 TODO 黑洞**：暫時省略的部分必須寫入 task-board 的 Backlog，不能只留註解。
7. **不確定就問**：需求模糊時由 Orchestrator 向使用者提問，subagent 不得自行腦補需求。

## 4. 程式碼慣例（依專案調整）

- 語言/框架版本（依 `package.json` 實際值，非最新版）：Node.js ≥20（`engines`）/ TypeScript `^5.5.4`（`strict` 開啟）/ Fastify `^5.10.0` / `@line/bot-sdk` `^9.5.0` / `pg` `^8.13.1` / vitest `^4.1.10` / eslint `^9.9.0`。
  **`better-sqlite3` 已於 T-012（D-007，PG-only 移植）移除**；ADR-003 的版本 pin 僅為歷史紀錄，不再適用。
- 目錄結構：`src/` 依功能分層——`src/webhook`（LINE 事件入口與驗簽）、`src/commands`（指令解析 `+N`/`-N`/`名單`/`開團`…）、`src/domain`（報名與開團 state machine 商業邏輯）、`src/db`（schema、migration、repository）、`src/line`（Messaging API 客戶端與訊息組版）。測試放對應 `__tests__/` 或 `*.test.ts`。
- 命名：檔名 kebab-case、型別/介面 PascalCase、函式/變數 camelCase；資料表與欄位 snake_case（見 `docs/00-project-brief.md` 資料模型）。
- 錯誤處理：後端統一錯誤格式 `{ code, message, details }`；對使用者的 LINE 回覆一律繁體中文，且只回應可識別指令（其餘群組訊息忽略，避免洗版）。
- 併發與冪等：報名寫入須用 DB transaction / row lock 防超賣；以 LINE webhook `message.id` 去重（`processed_events`）。
  - **決策輸入必須鎖內取得**：任何「讀 → 決策 → 寫」流程，決策所依據的值（capacity、已用名額、可釋出數…）一律於鎖內重讀，**不得沿用交易外快照**——「寫在鎖內」不等於安全。
  - **去重政策（拒絕回覆一律消費）**：凡本次會送出回覆的訊息（**含純拒絕文案**），一律消費其 `message.id`，重送即不再回覆。例外**僅限**下列兩類，其餘一律消費：(a)「本來就不回覆」的路徑（`unknown`／未攔截雜訊）；(b) **純判斷、零 DB 副作用的早退拒絕**——即不呼叫任何 service、不產生任何狀態變化者，現況為 `closeEvent`／`cancelEvent` 的交易外 `not_authorized`（`event-service.ts:601-603`）與 D-026 §5.2 的四種消歧義拒絕（`ambiguous`／`conflict`／`not_found`／`too_many`）。**(b) 類的代價是 LINE 重送會重複回覆同一則提示，此為已知並接受的取捨**（2026-09-02 使用者裁決，見 D-026 errata）；新增此類分支須在該設計文件明列，不得默默擴大。新增指令分支時，`markProcessed` 須置於所有拒絕 early-return **之前**。
- 秘密管理：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`DATABASE_URL`、`ADMIN_USER_IDS` 一律走環境變數，`.env` 不進版控。
- Commit 訊息：可追溯格式 `type(D-xxx/T-xxx): 描述`，例 `feat(D-003/T-014): 新增報名追加邏輯`；
  維運型允許 `chore:/docs:/ci:`。檢查：`harness/checks/check_commit_trace.sh`
- 禁止事項：不用 `any`、不吞例外、不在前端/版控存 secret、不繞過契約私改介面。
- **指令**（tester 與 checks 都依賴這幾條，勿自行猜測）：

  | 用途 | 指令 | 備註 |
  |---|---|---|
  | 測試 | `npm test` | vitest；**PG-only，須先 `docker compose up -d`** 起 port 5433 的測試 DB |
  | Lint | `npm run lint` | eslint 9 flat config（`eslint.config.mjs`） |
  | Build | `npm run build` | `tsc` + postbuild 複製 `src/db/migrations/*.sql` 到 `dist/` |
  | Migration | `npm run db:migrate` | 讀 `DATABASE_URL` |
  | harness 關卡 | `npm run harness:check` | 三個 check 一次跑完 |

  **不要直接呼叫 `python3 harness/checks/*.py`**：本機 `python3` 是 Windows Store app 別名 stub
  （exit 49、無輸出），真 Python 要用 `py`。`npm run harness:check` 已封裝直譯器偵測與 UTF-8 輸出。

## 4.5 既有專案現況（harness 導入日：2026-08-05）

### 豁免規則
- 導入日之前的既有程式碼與設計文件**不需回溯**滿足新增的關卡。
- 新規則僅適用於：新增檔案、以及被該次任務**實際修改**的既有檔案。
- 具體豁免：`harness/doc-budget-exempt.txt` 列出的 8 份 D 文件不受 120 行上限約束（新設計文件仍受）。
- Commit 可追溯格式 `type(D-xxx/T-xxx)` **自 2026-08-05 起於 CI 強制**，不回溯檢查更早的歷史。

### 凍結區（不得擅自重構）
- `src/db/migrations/0001~0003`——**已在 PROD 執行過**，只能新增 migration，不得改寫既有檔內容。
- `src/db/tx.ts` 的交易 runner 與 client-bound repo 綁定（D-007 路線 A）——鎖正確性關鍵路徑，改動一律 R2。

### 預設高風險模組（一律 R2）
- `src/db/migrations/`（資料 migration）
- `src/domain/registration-service.ts`（報名/取消/遞補的併發與超賣防護）
- `src/domain/event-service.ts`（授權判定 `canManageEvent`、event 狀態機、刪除類「取消活動」）

### 環境變數
- 清單見 `.env.example`（`LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `DATABASE_URL` / `ADMIN_USER_IDS`）；新增變數必須同步更新該檔。

## 5. 風險分級（決定審查深度）

每個任務由 Orchestrator 標記風險等級，寫入任務單與 task-board：

- **R0（低）**：文案、樣式微調、註解——**設計用 stub 寫在任務單內（3–5 行 + 1 條 Guardrail + 1 條 AC）、不建 D 檔**，跳過 reviewer，unit-tester 抽驗即可。
- **R1（中，預設）**：一般功能——完整 D-xxx（設計內容 ≤ 40 行），單一 reviewer **只讀審查包 + diff**。
- **R2（高）**：認證、權限、金流、資料 migration、刪除類操作——強制雙 reviewer（design-reviewer + architect-reviewer）+ e2e 覆蓋，且設計文件的 Guardrails 至少 3 條。

## 6. 驗收與品質關卡

任何功能要標記「完成」，必須依序通過（詳見 `harness/DEFINITION-OF-DONE.md`）：

0. `npm run lint` / `npm run build` / `npm test` / `npm run harness:check` 全綠
   ——**未全綠不得送模型審查**（模型審查是最貴的一關，不能拿來抓機器抓得到的錯）
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

> 註：§0–§7 **編號已凍結**（多份 APPROVED 文件硬引用 §4、§5）；新章節附加於 §7 後或以 §x.5 插入，不重編號。

## 8. 職責與寫入權（所有角色必須遵守）

採 **工作區分散、狀態真相集中**：

- 每個角色有專屬工作區 `docs/worklists/<role>.md`，可自由記錄佇列、筆記、疑問——
  只有自己能寫，不佔用他人 context。本專案只建 4 份實際使用的角色，補建方式見
  `docs/worklists/README.md`。
- 任務狀態的真相只有一份：`docs/task-board.md`，**唯一可寫者是 Orchestrator**。
- **任何 agent 都不得自行將任務標為 DONE**。做法是在自己的 worklist 寫下
  `PROPOSE → DONE` 並附證據（審查包／測試結果），由 Orchestrator 驗證關卡後裁定。
  這等同 code review 的「作者不能自己 approve」。
- 完整的檔案寫入權矩陣見 `harness/OWNERSHIP.md`；需要改不屬於自己的檔案時，
  回報 Orchestrator 轉派給該檔案的擁有者，不得逕行修改。

## 9. 上下文預算（所有角色必須遵守）

本框架以多角色分工換取品質，代價是脈絡重複載入。因此：

- **只讀被指名的文件與章節**（角色預設範圍見 `harness/TOKEN-BUDGET.md` 規則一）；派工單沒列的，不要「為了保險」順便讀。
- **關卡順序：先機器、後模型**。lint → test → `npm run harness:check` 全綠，才送 reviewer。
- **reviewer 只讀審查包（`docs/reviews/RP-T-xxx.md`）+ diff**，不重讀 codebase。
- **輸出有預算**：審查報告 ≤ 40 行、測試報告 ≤ 30 行、階段回報 ≤ 20 行。
- **本文件與角色檔是穩定前綴**，不塞任務 ID、日期等易變資訊，以利提示快取。
