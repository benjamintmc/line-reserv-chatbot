# OWNERSHIP — 誰能改什麼（Stakeholder Write Matrix）

> 原則：**工作區分散、狀態真相集中**。
> 每個角色有自己的工作清單可自由書寫；但任務狀態的真相只有一份，由 Orchestrator 維護。

## 一、為什麼不完全拆開

| 若完全拆成各自的 todo | 後果 |
|---|---|
| 各 agent 自行標記 DONE | 破壞「實作者不驗收自己的工作」的職責分離 |
| 無單一全域視圖 | Orchestrator 要讀 N 個檔案才知道進度，反而更貴 |
| 跨檔相依（T-014 等 T-011） | 阻塞關係看不見，容易死鎖 |
| 換模型接手 | 接手者需自行拼湊全貌，違反單一記憶原則 |

因此採混合制：**canonical board（集中） + per-agent worklist（分散）**。

## 二、檔案層級的寫入權

| 檔案 | 唯一可寫者 | 可讀者 | 說明 |
|---|---|---|---|
| `docs/task-board.md` | orchestrator | 全體 | 狀態真相；精簡索引 |
| `docs/task-board-archive.md` | orchestrator | 人工 | 不進 context |
| `docs/worklists/<role>.md` | 該 role 本人 | orchestrator + 本人 | 自己的佇列與工作筆記 |
| `docs/00-project-brief.md` | orchestrator（依使用者裁決） | 全體 | |
| `docs/01-architecture.md`、`docs/adr/` | architect | 全體 | |
| `docs/api/openapi.yaml`、`02-api-contract.md` | api-contract-designer | 全體 | |
| `design/D-xxx.md` §一、§二、§三 | 撰寫該設計的 agent | 全體 | |
| `design/D-xxx.md` 狀態列與討論紀錄 | orchestrator | 全體 | 只有 O 能標 APPROVED |
| `docs/reviews/RP-*.md` | 該任務實作者 | 對應 reviewer | 審查包 |
| 產品程式碼 | frontend / backend engineer | 全體 | reviewer、tester 不得改 |
| 測試碼 | unit-tester / e2e-tester | 全體 | engineer 可寫初版，tester 有最終編輯權 |
| `harness/LESSONS.md`、`harness/VERSION` | orchestrator | 全體 | |

## 三、欄位層級的權責（task-board 內）

即使 board 由 Orchestrator 獨佔書寫，資訊來源仍分屬各角色：

| 欄位 | 資訊來源 | 誰能促成變更 |
|---|---|---|
| ID / 任務 / 風險 / 相依 | orchestrator | orchestrator |
| 負責角色 | orchestrator | orchestrator |
| 狀態 | 各角色**提議**，orchestrator **裁定** | 見下方協定 |
| 產出路徑 | 該角色回報 | orchestrator 登錄 |

### 狀態變更協定（關鍵）
```
agent 在自己的 worklist 寫：  PROPOSE → CHECKS  或  PROPOSE → DONE（附證據）
orchestrator 驗證關卡後，才在 task-board 提交狀態轉換
```
**任何 agent 都不能自行把任務標為 DONE。** 這是刻意的職責分離：
提議與裁定分離，等同於 code review 中「作者不能自己 approve」。

## 四、技術性強制（非僅靠自律）

在 Claude Code 中，權限可透過角色檔 frontmatter 的 `tools` 欄位實際限制：

- `architect-reviewer`: `tools: Read` — 物理上無法寫入任何檔案。
- `design-reviewer`: `tools: Read, Bash` — 可跑檢查、不可改碼。
- `unit-tester` / `e2e-tester`: 有 Write，但鐵律限定只改測試碼（此層靠自律 + reviewer 抽查）。
- `orchestrator`: `Read, Write, Task` — 不給 Bash，避免它越界動手實作。

跨模型環境若無此機制，則以本文件為約定，並由 architect-reviewer 抽查違規。

## 五、爭議處理

- 某角色認為需要修改不屬於自己的檔案 → 回報 Orchestrator，由 Orchestrator 派給檔案擁有者。
- 兩個角色對同一檔案有需求（例如契約需同時滿足前後端）→ Orchestrator 主持，
  必要時上呈使用者裁決，結果寫入該檔案的 Changelog 或設計文件討論紀錄。
