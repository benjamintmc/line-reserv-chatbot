# ADOPTION — 既有專案導入 harness

> 目標：在**不動既有程式碼**的前提下，先把框架與文件補齊，再開始用新流程開發。
> 原則：既有程式碼**不需回溯**滿足新規則；規則只約束「導入之後新寫或修改的部分」。

## 一、檔案清單

### A. 直接複製，無需修改（框架本體）
```
.claude/agents/*.md              全部 9 個角色定義
harness/WORKFLOW.md
harness/DEFINITION-OF-DONE.md
harness/MODEL-PORTABILITY.md
harness/TOKEN-BUDGET.md
harness/OWNERSHIP.md
harness/HANDOFF-TEMPLATE.md
harness/REVIEW-PACKET-TEMPLATE.md
harness/LESSONS.md               （空表，開始累積）
harness/ADOPTION-EXISTING-PROJECT.md
harness/VERSION
harness/checks/                  全部腳本
design/README.md
design/D-000-TEMPLATE.md
design/examples/                 黃金範例
docs/adr/ADR-000-template.md
docs/worklists/*.md              各角色工作區（空表）
docs/task-board-archive.md       （空表）
docs/reviews/.gitkeep
docs/handoffs/.gitkeep
```

### B. 複製空白模板，由 Orchestrator 反向文件化填寫
```
docs/00-project-brief.md         ← 需與你問答補齊
docs/01-architecture.md          ← architect 讀 codebase 還原
docs/02-api-contract.md          ← api-contract-designer 讀路由還原
docs/api/openapi.yaml            ← 同上，機器可讀版
docs/task-board.md               ← 建立 baseline（含既有技術債）
```

### C. 高風險：**絕對不要直接覆蓋**
```
CLAUDE.md      ← 專案若已有，必須「合併」而非覆蓋（見第三節）
README.md      ← kit 的 README 會蓋掉你的專案 README！
               改放到 docs/HARNESS-README.md
.gitignore     ← 只追加，不覆蓋
```

### D. 導入後應加入的既有專案設定
- CI 加入：`python3 harness/checks/check_ac_coverage.py`、`check_doc_budget.py`、`check_board_sync.py`
- `check_commit_trace.sh` **不要**直接套用於歷史 commit（歷史不符新格式會全紅）；
  在 CLAUDE.md 記錄「可追溯格式自 {{導入日}} 起生效」，CI 只檢查該日之後的 commit。

> 註：`check_ac_coverage.py` 只掃描 **APPROVED 的設計文件**，既有程式碼沒有設計文件，
> 因此導入當下自然通過，不會被舊碼拖垮——這是刻意設計。

## 二、導入步驟

```bash
cd /path/to/your-project
git checkout -b chore/adopt-harness
bash /path/to/agent-harness-starter/adopt.sh .    # 安全複製，不覆蓋既有檔案
git add -A && git commit -m "chore: 導入 agent harness v1.3.0"
```
`adopt.sh` 遇到同名檔案會存成 `*.harness-new` 並列出清單，由你人工合併。

## 三、給 Orchestrator 的導入指示（可直接複製貼上）

```
你是本專案的 Orchestrator，我們正在為這個「既有專案」導入 agent harness。
請依序執行下列五個階段，每個階段結束時停下來向我回報並等待確認，不要一次做完。

【階段 A：盤點】
1. 讀 CLAUDE.md、harness/WORKFLOW.md、harness/OWNERSHIP.md、harness/TOKEN-BUDGET.md。
2. 盤點 codebase：目錄結構、套件清單與版本（package.json / pyproject.toml / go.mod 等）、
   進入點、路由定義位置、測試框架與執行指令、lint/build 指令、CI 設定、環境變數。
3. 產出「盤點報告」（≤ 30 行）給我，**先不要寫任何檔案**。

【階段 B：反向文件化】
1. 派 architect 讀 codebase，還原 docs/01-architecture.md：模組劃分、資料模型、
   實際使用的技術與版本、部署方式。凡是「現況如此但不理想」的部分，
   標記為【技術債】而不要美化成設計決策。
2. 派 api-contract-designer 從既有路由/controller 還原 docs/02-api-contract.md 與
   docs/api/openapi.yaml，版本標為 0.x 並註明「由既有實作反向產生，尚未凍結」。
3. 兩份文件由 architect-reviewer 審查後給我確認。

【階段 C：回填 CLAUDE.md】
依第四節清單，把從 codebase 觀察到的事實回填進 CLAUDE.md。
規則：每一項都必須有證據（檔案路徑或指令輸出），**不要猜測、不要寫理想值**；
無法從程式碼判定的（例如 Non-goals、目標使用者）列成問題清單向我提問。

【階段 D：建立基線】
1. 建立 docs/task-board.md 基線：把階段 B 標記的技術債登記為 BACKLOG 任務，
   標好風險等級（認證/金流/migration 一律 R2）。
2. 在 harness/LESSONS.md 記下導入時觀察到的既有反覆問題（如有）。
3. 產出第一份交接快照 docs/handoffs/。

【階段 E：試跑】
挑一個最小的新需求，完整走一遍 設計 → 我確認 → 實作 → 檢查 → 審查 → 裁定 DONE，
驗證流程在本專案可行。過程中的卡點記入 LESSONS.md。
```

## 四、CLAUDE.md 需要回填的內容清單

Orchestrator 應把以下**從 codebase 實際觀察到的事實**寫入，每項附證據來源：

### §0 專案概要
| 項目 | 從哪裡取得 |
|---|---|
| 專案名稱 / 一句話描述 | package.json name、README、或問使用者 |
| 目標使用者 | **問使用者**（程式碼看不出來） |
| 技術棧 | 套件清單 + lockfile 的**實際版本**，不是最新版 |
| 部署目標 | Dockerfile / vercel.json / CI workflow / Procfile |
| Non-goals | **問使用者** |

### §4 程式碼慣例（既有專案最關鍵的一節）
| 項目 | 取得方式 |
|---|---|
| 語言/框架版本 | manifest + lockfile |
| 目錄結構 | 實際 tree，說明各層職責 |
| 命名慣例 | 統計既有檔案（如「元件 PascalCase，佔 90%」），少數例外也要註明 |
| 錯誤處理 | 既有 error middleware / exception handler 的實際格式 |
| **測試指令** | 例 `pnpm test`、`pytest -q`——checks 與 tester 都需要 |
| **lint/build 指令** | 例 `pnpm lint && pnpm build`——關卡順序第一關 |
| 既有依賴清單 | 避免 agent 重複引入功能相同的套件 |
| 禁止事項 | 從 tsconfig strict、eslint rules、既有 review 慣例推導 |
| Commit 格式 | 註明「`type(D-xxx/T-xxx)` 格式自 {{導入日}} 起生效」 |

### §新增：既有專案專屬章節（建議加在 §4 之後）
```markdown
## 4.5 既有專案現況（導入日：YYYY-MM-DD）

### 豁免規則
- 導入日之前的既有程式碼**不需回溯**滿足 Acceptance Checks 與 Guardrails。
- 新規則僅適用於：新增檔案、以及被本次任務實際修改的既有檔案。

### 凍結區（不得擅自重構）
- {{路徑}}：原因（例：無測試覆蓋、外部系統相依、上線中的關鍵路徑）

### 已知技術債（對應 task-board BACKLOG）
- {{項目}} → T-xxx

### 預設高風險模組（一律 R2）
- {{認證/權限/金流/資料 migration/刪除操作的路徑}}

### 環境變數
- 清單見 .env.example；新增變數必須同步更新該檔
```

## 五、導入完成的判定

- [ ] A~D 四類檔案就位，無誤覆蓋（`git diff` 確認 README/CLAUDE.md 未被清空）
- [ ] 01-architecture、02-api-contract 反映**現況**（含技術債標記），非理想狀態
- [ ] CLAUDE.md 的測試/lint/build 指令**實際可跑通**
- [ ] `harness/checks/*` 全數通過
- [ ] 已完成一次階段 E 的完整流程試跑
