# 高爾夫球聚 LINE Chatbot（golf-reserv-chatbot）

一個常駐在 LINE 群組的**高爾夫球聚報名 chatbot**。成員在群組輸入 `+1` 即完成報名，
bot 即時回覆名單與剩餘名額；具「主辦人」身分者可透過對話建立下一場活動。

本專案同時採用一套**模型無關（model-agnostic）的多代理開發框架**（Orchestrator + Subagents，
文件即契約）來推進開發——產品需求與開發流程並存於同一 repo。

---

## 產品概覽

| 面向 | 內容 |
|---|---|
| 目標使用者 | 高爾夫球聚 LINE 群組的一般成員、主辦人（Host）、系統管理員（Admin） |
| 核心體驗 | 群組輸入 `+N` 報名、`-N` 取消、`名單` 查詢；主辦人 `開團` 建立活動 |
| 技術棧 | Node.js + TypeScript + Fastify + `@line/bot-sdk`；MVP 用 SQLite（`better-sqlite3`），可切換 PostgreSQL |
| 部署 | 任一支援 HTTPS 的平台（Render / Fly.io / Cloud Run）；開發期以 ngrok 對接 webhook |

### 角色與權限

| 角色 | 權限 |
|---|---|
| 一般成員 | 報名（`+N`）、取消（`-N`）、查詢名單與活動資訊 |
| 主辦人（Host） | 成員權限 + 建立活動、關閉/取消活動、手動調整名單 |
| 系統管理員（Admin） | 管理主辦人白名單、查看所有活動資料 |

## 指令總表

| 指令 | 對象 | 行為 |
|---|---|---|
| `+1` ~ `+N` | 全員 | 報名 N 位（掛在傳訊人名下，顯示為 `名字`、`名字(2)`…） |
| `-1` ~ `-N` | 全員 | 取消 N 位，歸零則移出名單 |
| `名單` / `list` | 全員 | 顯示活動資訊、名單、每人價格與預估總金額 |
| `開團 <日期> <時間> <地點> <人數> <價格>` | 主辦人 | 一行式建立活動 |
| `開團` / `新活動` | 主辦人 | 進入逐步問答建立流程 |
| `確認` / `取消` | 主辦人 | 開團流程中確認或放棄 |
| `關閉報名` | 主辦人 | 停止接受報名 |
| `取消活動` | 主辦人 | 取消進行中活動並公告 |
| `我的ID` | 全員（私訊） | 回覆該用戶的 LINE userId（供 Admin 設定白名單） |

> Bot 只回應可識別的指令，其餘群組訊息一律忽略（避免洗版），所有回覆使用繁體中文。

## 關鍵設計重點（非功能需求）

- **防超賣**：報名寫入使用 DB transaction / row lock，多人同時 `+1` 不會超額。
- **冪等去重**：以 LINE webhook 的 `message.id` 去重（`processed_events`），重送事件不重複報名。
- **名稱快照**：顯示名稱取自 LINE Profile API，於報名當下快照儲存，日後改名不影響歷史名單。
- **資料持久化**：服務重啟後活動與報名資料完整保留。
- **秘密走環境變數**：channel secret / access token 不進版控。

## 資料模型（草案）

`users` · `events` · `registrations` · `conversation_states`（逐步開團問答）· `processed_events`（webhook 去重）。
完整欄位見 [`docs/00-project-brief.md`](docs/00-project-brief.md)。

## 系統架構

```
LINE Platform ──webhook──▶ API Server ──▶ Command Parser
                                   │            │
                                   │      ┌─────┴──────┐
                                   │   報名邏輯    開團流程(state machine)
                                   │      └─────┬──────┘
                                   └──────────▶ DB (events / registrations / users)
```

---

## 本機開發

> 產品程式碼尚未落地（目前 repo 為需求與開發框架）。以下為 M0–M2 規劃的起手流程。

### 環境變數

```bash
LINE_CHANNEL_SECRET=          # LINE Messaging API channel secret
LINE_CHANNEL_ACCESS_TOKEN=    # LINE channel access token
DATABASE_URL=                 # 若使用 PostgreSQL；SQLite 可省略
ADMIN_USER_IDS=               # 逗號分隔的初始主辦人 userId（可選）
```

### 啟動（規劃）

```bash
npm install
npm run dev            # 本機啟動 Fastify server
ngrok http 3000       # 取得 HTTPS URL，填入 LINE webhook
```

在 LINE Developers Console：建立 Messaging API channel → 關閉自動回覆 → 開啟 webhook →
開啟 bot 加入群組權限，webhook URL 指向 `https://<ngrok>/webhook`。

## 開發里程碑

| 里程碑 | 內容 | 估時 |
|---|---|---|
| M0 | 環境與骨架：repo、TS、lint/test、LINE channel、echo bot 跑通 | 0.5 天 |
| M1 | 資料層與指令解析：schema + migration、command parser（含全形/上限測試） | 0.5–1 天 |
| M2 | 報名核心：`+N`/`-N`、追加、額滿、防超賣、去重、名單訊息 | 1 天 |
| M3 | 開團流程：一行式解析、逐步問答 state machine、權限、關閉/取消 | 1–1.5 天 |
| M4 | 主辦人管理與輔助：`我的ID`、host 白名單管理 | 0.5 天 |
| M5 | 部署與驗收：正式環境、webhook 切換、實機群組測試 | 0.5 天 |

## 待確認事項（開工前決定）

1. `+N` 超額時：部分接受（補滿剩餘）或全數拒絕？**建議部分接受並告知。**
2. 是否需候補（waitlist）？**建議 MVP 不做。**
3. 同群組是否可能同時多場活動？**建議 MVP 限一場。**
4. 是否需代報名 `+1 名字`？**建議 v1.1 支援。**
5. 是否需球組編排與收款統計？**v2 候選。**
6. Admin 後台形式：CLI／API 或網頁介面？

---

## 開發框架：Orchestrator + Subagents

本 repo 以「文件即契約」的多代理框架推進開發，任何模型（Claude／GPT／Gemini／開源）接手都能照章執行。

### 核心原則

1. **文件即真相**：決策落地成文件，不依賴模型記憶或對話歷史。
2. **契約先行**：前後端只透過 [`docs/02-api-contract.md`](docs/02-api-contract.md) 溝通，介面先凍結再實作。
3. **設計先行**：每個 feature 先寫三段式設計文件（設計內容 → Guardrails → Acceptance Checks），APPROVED 後才實作。
4. **單一窗口**：使用者只與 Orchestrator 對話，由它拆解、派工、彙整。
5. **產出可驗收**：能自動化的驗收一律自動化（`harness/checks/`），不依賴模型自我宣稱。
6. **可攜性**：角色定義皆為純 Markdown 提示詞，換模型只需替換執行環境。

### 目錄結構

```
golf-reserv-chatbot/
├── CLAUDE.md                  ← 專案憲法：模型進場第一份必讀文件（已填入本專案概要）
├── requirements.md            ← 原始需求規格（權威來源已彙整入 docs/00-project-brief.md）
├── .claude/agents/            ← 各 subagent 角色定義（Claude Code 原生；其他模型作 system prompt）
├── docs/
│   ├── 00-project-brief.md    ← 專案簡報（需求、範圍、資料模型、里程碑、驗收）
│   ├── 01-architecture.md     ← 系統架構（architect 產出）
│   ├── 02-api-contract.md     ← 前後端介面契約（api-contract-designer 產出）
│   ├── api/openapi.yaml       ← 契約的機器可讀 source of truth
│   ├── adr/                   ← Architecture Decision Records
│   └── task-board.md          ← 任務看板（Orchestrator 維護）
├── design/                    ← 功能設計文件（D-xxx，三段式；APPROVED 才可實作）
└── harness/
    ├── WORKFLOW.md            ← 派工流程與任務狀態機
    ├── DEFINITION-OF-DONE.md  ← 各階段驗收標準
    ├── MODEL-PORTABILITY.md   ← 更換模型時的遷移指南
    ├── HANDOFF-TEMPLATE.md    ← 交接快照模板
    ├── LESSONS.md             ← 重複性問題登記與回寫
    └── checks/                ← 可執行品質關卡（AC 覆蓋、commit 可追溯）
```

### 如何啟動

對模型說：**「請以 Orchestrator 角色啟動，讀取 `CLAUDE.md` 與 `docs/00-project-brief.md`，從 M0 開始。」**
之後所有溝通都只面向 Orchestrator。
