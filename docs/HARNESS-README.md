# Agent Harness Starter Kit（多代理開發框架）

一套**模型無關（model-agnostic）**的多代理協作框架。以 Orchestrator 為唯一溝通窗口，
將任務派工給不同職能的 subagents，並以「文件即契約」確保任何模型（Claude、GPT、Gemini、開源模型）
接手時都能照章執行。

## 核心設計原則

1. **文件即真相（Docs as Source of Truth）**：所有決策落地成文件，不依賴模型記憶或對話歷史。
2. **契約先行（Contract-First）**：前後端只透過 `docs/02-api-contract.md` 溝通，介面先凍結、再實作。
3. **設計先行（Design-First）**：每個 feature 先寫三段式設計文件，經使用者確認 APPROVED 後才實作；Guardrails 供 reviewer 逐條稽核，Acceptance Checks 供 tester 逐條驗證。
4. **單一窗口（Single Point of Contact）**：使用者只跟 Orchestrator 對話；Orchestrator 負責拆解、派工、彙整。
5. **產出可驗收（Verifiable Output）**：每個任務有明確輸入輸出與 DoD，且能自動化的驗收一律自動化（`harness/checks/`），不依賴模型自我宣稱。
6. **職責分離（Separation of Duty）**：工作區分散、狀態真相集中；任何角色都不能驗收自己的工作，狀態轉換一律「提議 → Orchestrator 裁定」。
7. **成本自覺（Context Discipline）**：只讀被指名的章節、機器檢查先於模型審查、reviewer 只讀審查包——用最少的 token 換同樣的品質。
8. **可攜性（Portability）**：所有角色定義為純 Markdown 提示詞，換模型只需替換執行環境，不改流程。

## 目錄結構

```
your-project/
├── CLAUDE.md                  ← 專案憲法：模型進場第一份必讀文件
├── .claude/agents/            ← 各 subagent 的角色定義（Claude Code 原生支援；
│                                 其他模型可將內容作為 system prompt 使用）
├── docs/
│   ├── 00-project-brief.md    ← 專案簡報（需求、範圍、限制）
│   ├── 01-architecture.md     ← 系統架構（由 architect 產出）
│   ├── 02-api-contract.md     ← 前後端介面契約（由 api-contract-designer 產出）
│   ├── adr/                   ← Architecture Decision Records
│   ├── task-board.md          ← 狀態真相（唯一可寫者：Orchestrator）
│   └── worklists/<role>.md    ← 各角色專屬工作區（自己可寫，狀態需提議）
├── design/                    ← 功能設計文件（D-xxx，三段式：設計內容 →
│                                 Guardrails → Acceptance Checks；APPROVED 才可實作）
├── design/examples/           ← 黃金範例（已填寫完成的設計文件，供弱模型 few-shot）
└── harness/
    ├── WORKFLOW.md            ← 派工流程與任務狀態機
    ├── DEFINITION-OF-DONE.md  ← 各階段驗收標準
    ├── MODEL-PORTABILITY.md   ← 更換模型時的遷移指南
    ├── HANDOFF-TEMPLATE.md    ← session 結束/換模型的交接快照模板
    ├── ADOPTION-EXISTING-PROJECT.md ← 既有專案導入清單與 Orchestrator 指示
    ├── OWNERSHIP.md           ← 寫入權矩陣與狀態變更協定（提議 vs 裁定分離）
    ├── TOKEN-BUDGET.md        ← 上下文成本控制（閱讀清單、關卡順序、模型分級）
    ├── REVIEW-PACKET-TEMPLATE.md ← 審查包：讓 reviewer 只讀一頁完成審查
    ├── LESSONS.md             ← 重複性問題登記與回寫（harness 自我進化）
    ├── VERSION                ← harness 版本與演進紀錄
    └── checks/                ← 可執行品質關卡（AC 覆蓋、commit 可追溯）
```

## 快速開始（Start from Scratch）

1. 複製整個 starter kit 到新專案根目錄。
2. 填寫 `docs/00-project-brief.md`（或直接告訴 Orchestrator，由它幫你填）。
3. 修改 `CLAUDE.md` 頂部的「專案概要」區塊。
4. 對模型說：「請以 Orchestrator 角色啟動，讀取 CLAUDE.md 並開始 Phase 0。」
5. 之後所有溝通都只面向 Orchestrator。

## 套用到既有專案

```bash
cd /path/to/your-project && git checkout -b chore/adopt-harness
bash /path/to/agent-harness-starter/adopt.sh .   # 安全複製，不覆蓋既有檔案
```
完整檔案清單、給 Orchestrator 的五階段導入指示、以及 CLAUDE.md 需回填的項目，
見 **`harness/ADOPTION-EXISTING-PROJECT.md`**。
