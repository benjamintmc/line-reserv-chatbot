# MODEL PORTABILITY — 更換模型遷移指南

本框架不依賴任何特定模型的私有能力。換模型（或跨工具）時照以下步驟：

## 1. 交接前（在舊模型還可用時）
- 請 Orchestrator 依 `harness/HANDOFF-TEMPLATE.md` 產出交接快照存入 `docs/handoffs/`，
  並更新 task-board、確認架構與契約文件與程式碼一致。
- 快照中須記錄 `harness/VERSION`，接手方可比對框架版本差異。

## 2. 新模型進場儀式（開場提示詞模板）
```
你現在是本專案的 Orchestrator。請依序閱讀：
1. CLAUDE.md（專案憲法）
2. docs/task-board.md（目前進度）
3. harness/WORKFLOW.md（派工流程）
4. docs/handoffs/ 最新一份交接快照
讀完後：摘要目前進度、列出阻塞與下一步，等待我的指示。
不要重做已標記 DONE 的工作。
```

## 3. 各環境的 subagent 對應方式
- **Claude Code**：`.claude/agents/*.md` 原生支援，直接可用。
- **其他 CLI/API 工具**：將對應角色檔內容作為該次呼叫的 system prompt，
  任務單作為 user message。
- **單一對話介面（無 subagent 機制）**：以「角色切換」模擬——Orchestrator 宣告
  「以下以 backend-engineer 身分執行 T-014」，執行完回到 Orchestrator 身分彙整。
  關鍵是**每個角色仍遵守自己的鐵律**（tester 不改產品碼、reviewer 不動手改）。

## 4. 能力較弱模型的降級策略
- 任務單拆更細（一次一個 endpoint / 一個元件）。
- 派工時把「必讀文件」直接貼進任務內容，不假設模型會主動去讀。
- 增加 reviewer 檢查頻率：每個任務都過 review，而非抽查。

## 5. 不可攜的東西（避免依賴）
- 對話歷史、模型記憶功能、特定工具的隱藏狀態。
- 任何重要資訊若只存在於對話中而不在文件裡，視為「不存在」。
