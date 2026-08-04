# 約球 LINE Chatbot（`golf-reserv-chatbot`）

一個常駐在 LINE 群組的**約球報名 chatbot**。有人想約，輸入 `開團` 建立活動；想去的人打 `+1` 就完成報名，
bot 即時回覆名單、剩餘名額與每人費用。額滿自動轉候補，有人取消則依序遞補並 @ 通知。

**不綁定特定球種**——活動只有「時間、場地、人數、費用」四個要素，打什麼球由揪團的人自己決定。
Bot 的回覆文案一律中性，不預設球種。

> 註：repo 名稱 `golf-reserv-chatbot` 沿用自初版，功能已中性化，暫未更名以免影響既有部署座標。

**狀態：已上線（PROD LIVE，2026-08-02）** — Cloud Run + Neon Postgres，運行成本 $0/月。

本專案同時採用一套**模型無關（model-agnostic）的多代理開發框架**（Orchestrator + Subagents，
文件即契約）來推進開發——產品與開發流程並存於同一 repo，見下半部。

---

## 產品概覽

| 面向 | 內容 |
|---|---|
| 目標使用者 | 揪團約球的 LINE 群組成員；開團的人（活動建立者）；系統管理員 |
| 核心體驗 | 群組輸入 `+N` 報名、`-N` 取消、`名單` 查詢；任何人皆可 `開團` |
| 技術棧 | Node.js 20+ / TypeScript 5.5 / Fastify 5 / `@line/bot-sdk` 9 / PostgreSQL（`pg` 8） |
| 部署 | Cloud Run（`asia-east1`，min-instances=0）+ Neon Postgres |

### 角色與權限

授權模型刻意做得很輕（見 [`design/D-006`](design/D-006-admin-claiming.md)）：

| 角色 | 權限 |
|---|---|
| 一般成員 | 報名 `+N`、取消 `-N`、代報名 `+N 名字`、查詢 `名單` |
| 開團的人 | **任何成員都能開團**（無白名單）；建立者可 `關閉報名`、`取消活動` |
| 系統管理員 | 由環境變數 `ADMIN_USER_IDS` 指定，跨群可管理任何活動（安全網） |

## 指令總表

| 指令 | 對象 | 行為 |
|---|---|---|
| `+1` ~ `+N` | 全員 | 報名 N 位；額滿時**整批轉候補**（不部分接受） |
| `+N 名字` | 全員 | 代報名，掛在代報者名下（取消責任也在代報者） |
| `-1` ~ `-N` / `-N 名字` | 全員 | 取消 N 位；釋出名額依 FIFO 自動遞補候補者並 @ 通知 |
| `名單` / `list` | 全員 | 顯示活動資訊、正取／候補名單、每人費用 |
| `開團 <日期> <時間> <地點> <人數> <費用>` | 全員 | 一行式建立活動 |
| `開團` / `新活動` | 全員 | 進入逐步問答建立流程 |
| `確認` / `取消` | 流程中 | 送出建立 / 放棄開團 |
| `關閉報名` | 建立者或管理員 | 停止接受報名，結算最終費用 |
| `取消活動` | 建立者或管理員 | 取消活動並公告（不刪報名紀錄，保留稽核） |
| `我的ID` | 全員 | 回覆自己的 LINE userId（供設定 `ADMIN_USER_IDS`） |

> Bot 只回應可識別的指令，其餘群組訊息一律忽略（避免洗版），所有回覆使用繁體中文。

### 費用模式

開團時可選兩種計價（見 [`design/D-005`](design/D-005-billing-modes.md)）：

- **每人固定價**：直接指定每人金額。
- **場地費均攤**：指定場地費總額，依實際報名人數動態均攤、**無條件進位到整數元**。
  報名人數變動時顯示為「暫估」，`關閉報名` 時才快照為最終金額。

## 關鍵設計重點

- **防超賣**：報名寫入一律在 `SELECT … FOR UPDATE` 交易內完成，且**交易內所有查詢綁同一連線**
  （pool 下若落到不同 client，鎖會形同虛設）。多人同時 `+1` 不會超額。
- **決策輸入也必須在鎖內取得**：不只是「寫」在鎖內。曾有一次真實超賣即源於用交易外快照計算遞補額度。
- **冪等去重**：以 LINE webhook 的 `message.id` 去重（`processed_events`），重送事件不重複報名。
- **名稱快照**：顯示名稱取自 LINE Profile API，於報名當下快照，日後改名不影響歷史名單。
- **單場自動釋放**：活動時間過了就自動釋放擋團（惰性判定），不必手動收尾即可開下一場。
- **serverless 時序**：先 await 完整處理（含回覆送出）才回 200——先回 200 會讓回覆漏送。
- **秘密走環境變數**：channel secret / access token / 連線字串不進版控、不進 image。

## 資料模型

`events` · `registrations`（**per-slot**，一個名額一列）· `conversation_states`（逐步開團問答）·
`processed_events`（webhook 去重）· `users`。
權威來源見 [`design/D-001`](design/D-001-data-model.md)，架構總覽見 [`docs/01-architecture.md`](docs/01-architecture.md)。

## 系統架構

```
LINE 群組 ──webhook──▶ Cloud Run (Fastify) ──▶ 指令解析 (src/commands)
                            │  驗簽 / 去重            │
                            │                  ┌─────┴──────┐
                            │            報名邏輯      開團流程
                            │        (registration-      (state machine
                            │          service)          + create-flow)
                            └──────────────────▶ Neon Postgres
```

---

## 本機開發

### 環境變數

```bash
LINE_CHANNEL_SECRET=          # LINE Messaging API channel secret
LINE_CHANNEL_ACCESS_TOKEN=    # LINE channel access token
DATABASE_URL=                 # Postgres 連線字串（app 用 pooled；migrate 走直連）
ADMIN_USER_IDS=               # 逗號分隔的管理員 userId（可選）
```

完整清單見 `.env.example`；新增變數必須同步更新該檔。

### 常用指令

```bash
npm install
docker compose up -d      # 起測試用 Postgres（port 5433）——測試為 PG-only，必須先跑
npm test                  # vitest
npm run lint
npm run build             # tsc + 複製 migrations 到 dist/
npm run db:migrate        # 套用 migration（讀 DATABASE_URL）
npm run dev               # 本機啟動 Fastify
npm run harness:check     # 開發框架的品質關卡
```

開發期以 cloudflared / ngrok 取得 HTTPS URL 對接 webhook。
在 LINE Developers Console：建立 Messaging API channel → **Response mode 設為 Bot** → 關閉自動回應 →
開啟 webhook → 開啟 bot 加入群組權限，webhook URL 指向 `https://<tunnel>/webhook`。

> 踩雷提醒：LINE 的「Verify 成功」**不等於**使用者訊息會送進 webhook——Response mode 必須是 Bot 而非 Chat。

### 部署

流程與線上座標見 [`docs/deployment-runbook.md`](docs/deployment-runbook.md)。
CI（GitHub Actions）每次 push 執行：lint → build → test（含 Postgres service）→ 框架關卡 → commit 格式檢查。

## 開發里程碑

| 里程碑 | 內容 | 狀態 |
|---|---|---|
| M0 | 環境與骨架、echo bot 跑通 | ✅ |
| M1 | 資料層與指令解析 | ✅ |
| M2 | 報名核心：`+N`/`-N`、額滿、候補、防超賣、去重 | ✅ |
| M3 | 開團流程：一行式、逐步問答、授權、關閉/取消 | ✅ |
| M4 | 費用模式、授權簡化、單場自動釋放 | ✅ |
| M5 | PG 移植與部署上線 | ✅ 2026-08-02 |

後續規劃見 [`docs/task-board.md`](docs/task-board.md) 的 Backlog——目前包含「我的球聚」個人待辦查詢、
開團後加開名額、關閉報名時 @ 正取者等。

---

## 開發框架：Orchestrator + Subagents

本 repo 以「文件即契約」的多代理框架推進開發，任何模型（Claude／GPT／Gemini／開源）接手都能照章執行。
框架版本 **1.4.0**（見 `harness/VERSION`）。

### 核心原則

1. **文件即真相**：決策落地成文件，不依賴模型記憶或對話歷史。
2. **契約先行**：介面先凍結再實作。本專案的對外介面是 LINE 對話，故契約即
   [`docs/02-api-contract.md`](docs/02-api-contract.md) 的**指令契約**。
3. **設計先行**：每個 feature 先寫三段式設計文件（設計內容 → Guardrails → Acceptance Checks），
   APPROVED 後才實作。
4. **單一窗口**：使用者只與 Orchestrator 對話，由它拆解、派工、彙整。
5. **職責分離**：任何角色都不能驗收自己的工作；狀態轉換一律「提議 → Orchestrator 裁定」。
6. **成本自覺**：只讀被指名的章節、機器檢查先於模型審查、reviewer 只讀審查包。
7. **產出可驗收**：能自動化的驗收一律自動化（`harness/checks/`），不依賴模型自我宣稱。

### 目錄結構

```
├── CLAUDE.md                  ← 專案憲法：模型進場第一份必讀文件
├── .claude/agents/            ← 各 subagent 角色定義
├── src/                       ← 產品程式碼（commands / domain / db / webhook / line）
├── docs/
│   ├── 00-project-brief.md    ← 專案簡報（需求、範圍、驗收）
│   ├── 01-architecture.md     ← 系統架構、併發正確性、技術債、LINE 平台限制
│   ├── 02-api-contract.md     ← 指令契約（指令語法、回覆範本、去重政策）
│   ├── api/openapi.yaml       ← HTTP 面（webhook / health）
│   ├── adr/                   ← Architecture Decision Records
│   ├── task-board.md          ← 任務看板（Orchestrator 唯一可寫）
│   ├── worklists/             ← 各角色專屬工作區
│   ├── reviews/               ← 審查包（reviewer 只讀這個 + diff）
│   └── handoffs/              ← 交接快照
├── design/                    ← 功能設計文件（D-xxx，APPROVED 才可實作）
└── harness/
    ├── WORKFLOW.md            ← 派工流程與任務狀態機
    ├── DEFINITION-OF-DONE.md  ← 各階段驗收標準
    ├── TOKEN-BUDGET.md        ← 上下文成本規則
    ├── OWNERSHIP.md           ← 誰能寫哪個檔案
    ├── LESSONS.md             ← 重複性問題登記與回寫
    └── checks/                ← 可執行品質關卡
```

### 如何啟動

對模型說：**「請以 Orchestrator 角色啟動，讀取 `CLAUDE.md` 與 `docs/task-board.md`，
並查看 `docs/handoffs/` 最新的交接快照。」** 之後所有溝通都只面向 Orchestrator。
