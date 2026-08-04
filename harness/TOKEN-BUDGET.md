# TOKEN BUDGET — 上下文成本控制

> 本框架的 token 主要不是燒在「做事」，而是燒在**每個角色重新載入脈絡**。
> 本文件定義降低重複載入的規則，所有角色必須遵守。

## 成本來源盤點

| 來源 | 說明 | 對策 |
|---|---|---|
| 脈絡重載 | 同一份架構/契約文件被 5–6 個角色各讀一次 | 閱讀清單（只讀指定章節） |
| 全檔閱讀 | 讀整份大文件只為了看一段 | 文件切檔 + 錨點定位 |
| 產物轉述 | Orchestrator 把 subagent 全文轉貼給使用者 | 摘要協定（結構化四段式） |
| 審查重讀 | reviewer 重讀整個檔案而非變更 | 審查包（diff + 自檢表） |
| 無效審查 | 送審後才發現測試沒過 | 關卡順序：機器檢查先於模型審查 |
| 看板膨脹 | task-board 累積上百列仍全量讀取 | DONE 任務歸檔 |
| 過度儀式 | R0 小改動也走完整設計文件流程 | 分級文件（stub / 完整） |

## 規則一：閱讀清單（Reading Manifest）

派工單**必須**指名該角色要讀的檔案與章節，不得只寫「請參考文件」。
各角色的預設閱讀範圍如下，超出範圍需在任務單明確授權：

| 角色 | 必讀 | 不需讀 |
|---|---|---|
| architect | brief 全文、既有 ADR 標題列表 | 契約細節、實作碼 |
| api-contract-designer | 架構 §模組劃分 §資料模型、brief §範圍 | 實作碼、ADR 全文 |
| frontend-engineer | 對應 D-xxx 全文、契約中**該功能用到的 endpoint** | 後端實作、架構全文 |
| backend-engineer | 對應 D-xxx 全文、同上 endpoint、架構 §分層 | 前端實作 |
| unit-tester | D-xxx §三（AC）、待測檔案 | 設計內容全文、契約 |
| e2e-tester | brief §關鍵旅程、各 D 的 e2e 類 AC | 實作細節 |
| design-reviewer | D-xxx §二（Guardrails）、審查包 | 設計內容全文、後端碼 |
| architect-reviewer | 待審文件本身、架構 §模組劃分 | 實作細節（除非抽查） |

**CLAUDE.md 與自己的角色檔是唯一每次都讀的固定前綴**——這是刻意的，見規則六。

## 規則二：文件切檔與錨點

- 單一文件超過 **300 行**即應切分（`check_doc_budget.py` 會警告）。
- 契約按資源切檔：`docs/api/paths/todos.yaml`、`auth.yaml`，避免為了一個 endpoint 載入整份 spec。
- 架構文件的模組章節若膨脹，切為 `docs/01-architecture/<module>.md`，主檔只留索引。
- 所有章節使用穩定標題（`## 資料模型`），派工單以 `檔案#章節` 定位。

## 規則三：關卡順序（先機器、後模型）

```
lint / build → unit test → harness/checks/*.py → 【此處全綠才送模型審查】→ reviewer
```
任何一關失敗就退回實作者，**不得**送 reviewer。模型審查是最貴的一關，
不能拿來抓機器抓得到的錯。

## 規則四：分級文件（依風險決定儀式）

| 風險 | 設計文件 | 審查 | e2e |
|---|---|---|---|
| R0 | **設計 stub**（直接寫在任務單內：3–5 行 + 1 條 Guardrail + 1 條 AC），不建檔 | 免 | 免 |
| R1 | 完整 D-xxx，但設計內容段 ≤ 40 行 | 單一 reviewer 讀審查包 | 選配 |
| R2 | 完整 D-xxx，不設上限 | 雙 reviewer | 必要 |

## 規則五：審查包（Review Packet）

實作者交付時產出審查包（見 `harness/REVIEW-PACKET-TEMPLATE.md`），
reviewer 原則上**只讀審查包 + diff**，不重讀整個 codebase；
只有審查包自檢有疑義時才展開原始檔案。

## 規則六：善用 prompt caching（提示快取）

每次呼叫的訊息順序固定為：

```
[穩定前綴] CLAUDE.md → 角色檔 → 相關文件章節
[易變後綴] 任務單 → 對話
```

穩定前綴逐字不變才能命中快取。因此：
- **不要**每次微調 CLAUDE.md 措辭；要改就集中在一次改完。
- **不要**把時間戳、任務 ID 等易變資訊塞進 CLAUDE.md 或角色檔。
- 同一 feature 的多個任務盡量在同一 session 連續執行，快取才有機會複用。

## 規則七：輸出長度預算

| 產出 | 建議上限 |
|---|---|
| 設計文件（R1） | 120 行 |
| 審查報告 | 40 行（blocker 優先，nit 條列即可） |
| 測試報告 | 30 行（AC 對照表 + 失敗清單） |
| Orchestrator 對使用者的階段回報 | 20 行四段式 |

冗長不等於嚴謹。超出預算多半代表任務該再拆一層。

## 規則八：模型分級（跨模型環境）

不同角色對推理深度的需求差異很大，能力最強的模型應留給最貴的決策：

| 層級 | 角色 | 理由 |
|---|---|---|
| 高階模型 | architect、architect-reviewer、orchestrator | 決策品質影響整個專案，錯了要重來 |
| 中階模型 | api-contract-designer、frontend/backend-engineer、design-reviewer | 有明確文件依循，中階足夠 |
| 輕量模型 | unit-tester、e2e-tester（腳本撰寫）、文件格式化 | 高度機械化，AC 已寫明要測什麼 |

在單模型環境中此表無作用；換到可混搭的環境（API/多工具）時照表配置，
通常可省下總成本的一半以上。

## 規則九：看板與紀錄歸檔

- task-board 只保留 **未 DONE + 最近 10 筆 DONE**，其餘移入 `docs/task-board-archive.md`。
- 交接快照只讀最新一份；歷史快照不進 context。
- LESSONS 已回寫的項目移入下方「已回寫紀錄」，不再佔用活躍區。

## 快速自檢

派工前，Orchestrator 問自己三個問題：
1. 這個角色**真的需要**讀這份文件全文嗎？
2. 機器檢查跑過了嗎？（沒跑就送審是浪費）
3. 這個任務的風險等級，配得上我要求的儀式規模嗎？
