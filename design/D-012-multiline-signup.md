# D-012: 多行批次報名（Multiline Signup：一則多行訊息逐行執行 +N/-N）

- 狀態：APPROVED（2026-08-17，使用者最終核可；design-reviewer PASS、nit 收斂）——解鎖 T-020 實作
- 撰寫者：backend-engineer
- 關聯：使用者新需求（一則含多行訊息＝逐行報名/取消）／任務 T-020（實作，待編號）
- 相依：
  - **D-002（APPROVED）**：`parseCommand(text)` 單行純解析——本文件**每行**復用之，不重做解析。
  - **D-003（APPROVED）**：`signup()`/`cancel()` 交易、去重（`markProcessed(messageId)`）、FIFO、代報名——本文件**不改其交易/超賣/遞補語意**，僅改 handler 拆行與傳入的去重鍵值。
- 風險等級：**R1**（不動 `registration-service` 超賣/交易核心；只改 `handler.ts` 拆行 + 去重鍵字串值）。後續單一 design-reviewer。

---

## errata（2026-08-31，來源 D-020／同群多場並行活動；**DRAFT，尚未核可/未實作**，本節僅供追溯，不改本文件 APPROVED 狀態；不代表現行系統行為已改變）

> D-020 若落地：本文件拆行邏輯（`\r?\n` 拆行、複合去重鍵 `${message.id}#${lineIndex}`）**完全不變
> ——多場並行不影響去重機制**。改變的只是「批次要作用於哪一場活動」的決定方式：`handleBatch` 前，
> D-020 §5.2 的 `splitSelector` 對整段原文呼叫一次（在本文件既有的拆行**之前**），消歧義解出恰一個
> `eventId` 後套用到批次內每一行（D-020 G12：批次僅認第一行 `@selector`，第 2 行以後即便帶 `@`
> 也不切換活動）。單場（candidates.length===1）時行為零回歸，沿用消歧義 `single` 分支。**目前均
> 未生效**。
>
> 權威來源：`design/D-020-multi-event-per-group.md` §5.2。

---

## 一、設計內容

### 0. 定位
LINE 把「多行貼上」的整段當**一則**訊息、只給**一個 `message.id`**。本功能讓 `handler.ts` 依換行拆行，對**每個非空行**各自 `parseCommand`，**僅**對解析為 `signup`/`cancel` 的行**依序**執行，最後合併為**一次 reply（≤5 則訊息）**。其餘指令（名單/開團/分組/確認…）**不納入**逐行批次（使用者裁決）。

### 1. 去重鍵（核心技術挑戰的解法）
現行去重：一個 `message.id` 一列（`processed_events.message_id TEXT PK`；signup/cancel 於交易內首步 `markProcessed(input.messageId)`）。多行沿用同一 `message.id` → 第 2 行起被判 duplicate 而跳過。

**解法：每行傳入複合去重鍵 `${message.id}#${lineIndex}`**（`lineIndex`＝換行切分陣列的 0-based 索引，含被忽略/空行，確保重送時同一行命中同鍵）。
- `signup`/`cancel` 的 `messageId` 參數型別本即 `string`、僅作去重鍵用途，`markProcessed` 以其為 `TEXT PK`。**複合鍵是合法字串 → 每行各自成列、各自去重**。
- 效果：①每行獨立記錄；②LINE 重送整則時每行命中**各自**的複合鍵 → 逐行 duplicate → 不重複報名；③崩潰於半途時，已 commit 之行重送為 duplicate、未達之行首次執行（part-resend，AC-8）。
- **確認結論：無需改 `registration-service` 簽名**（見 §五）。

### 2. 拆行與分派（`handler.ts`）
1. **conversation 攔截優先不變**：進行中開團流程（`conv.state !== 'grouping'`）仍以**整段 `text`** 走 `continueFlow`（批次不介入流程答案）。
2. 否則以 `/\r?\n/` 拆 `text` 為 `lines`。**行數 ≤ 1**（單行）→ **維持現行單指令路徑，零回歸**。
3. **行數 ≥ 2**（多行）→ 批次路徑：
   - 逐行 `trim`；空行**忽略**（不計入執行，但**保留其 lineIndex**＝split 陣列索引，供去重鍵穩定）。
   - 每非空行 `parseCommand(line)`；**僅** `type==='signup'|'cancel'` 為可執行行，其餘型別（含 `list`/`create_*`/`invalid`/`unknown`）**忽略**（沿用「只回應可識別指令」，裁決 #3）。
   - **依序 await** 執行每可執行行既有 `service.signup/cancel`，傳 `messageId=`${messageId}#${i}``（`i`＝該行 split 索引）、其餘參數（groupId/executor/顯示名/count/proxyName）同單行路徑。**後行看得到前行效果**（容量被前行填滿→後行自動候補）。
4. **上限（裁決 #2）**：`MAX_BATCH_LINES = 20`，**只計可執行的 +/- 行**（空行/被忽略行不計）。可執行行數 > 20 → **整則拒絕**、回一句繁中提示、**不部分執行**（不呼叫任何 signup/cancel、不 markProcessed）。

### 3. 合併回覆（一次 reply、≤5 則訊息）
- reply 封套 = **一次 reply token、≤5 則訊息**（摘要 + 名單 + 遞補 @ 各為一則；**逐行摘要是「同一則訊息內的多文字行」，非 5 則各一行**）。
- **摘要字串（釘死；用語沿用既有 `list-formatter`「正取/候補」，勿新增第二措辭）**：報名行 →「已報名：{名字、名字…}」，該行落候補者於名字後標「（候補）」；取消行 →「已取消：{名字}」。
  - **errata（2026-08-18，使用者裁決）**：取消行**同報名行聚合**為「已取消：{名字、名字…}」（原釘死字串為單數「已取消：{名字}」，實作已聚合以與報名側對稱、可讀性較佳）。兩類並存時報名行在前。此為本文件唯一 errata；**不得**再依原單數字串把實作改回逐行。
- **末尾附一次**更新後名單（復用 `list-formatter`/`roster`，取批次執行完的最終 view，僅一次）。
- **遞補 @ mention**：批次期間若有遞補，reply 末段附 @ 通知（複用 D-003 §4）；mention 數量與單則長度上限/截斷記 Backlog。
- 逐行 `duplicate`（重送）之行**不產生摘要行**；**整則全 duplicate → 回空、不 reply**（對齊 D-003 G9 重送不回覆）。
- **超上限拒絕字串（釘死）**：「一次最多報名 20 筆，請分次輸入。」（不執行任何行）

### 範圍內
- `handler.ts` 依換行拆行；多行時逐行 `parseCommand`、僅執行 `signup`/`cancel`、依序執行、複合去重鍵、合併為一次 reply。
- 單行維持現行行為（零回歸）。

### 範圍外
- 修改 `registration-service` 的交易/超賣/遞補/代報名語意（一律不動）。
- `名單`/`開團`/`分組`/`確認`/`取消` 等指令的逐行批次（僅 `+N`/`-N`）。
- 開團問答流程中的多行（仍走 `continueFlow` 整段）。
- 批次整批原子性（跨行 all-or-nothing）——本功能為**逐行獨立交易**，不做跨行交易。

---

## 二、Guardrails（Must NOT）
- **G1（僅限 +/-）**：批次逐行只得執行 `signup`/`cancel`；其餘 `ParsedCommand.type`（`list`/`create_*`/`confirm`/`abort`/`group*`/`my_id`/`invalid`/`unknown`）一律忽略，不得於批次內執行。
- **G2（複合去重鍵）**：多行每行傳入的去重鍵必須為 `${message.id}#${lineIndex}`；不得多行共用單一 `message.id`（否則第 2 行起誤判 duplicate），亦不得用行內容/時間等非穩定值作鍵（整則重送須命中同鍵）。
- **G3（不動核心）**：不得修改 `registration-service` 的交易邊界、`markProcessed` 去重位置、整批候補/FIFO 遞補/超賣防護語意；本功能僅在 handler 拆行並傳入複合鍵字串。
- **G4（一次 reply）**：批次一律以**一次 reply token（≤5 則訊息）**回覆，不得逐行各發一則 reply/push 造成洗版。
- **G5（單行零回歸）**：`lines.length <= 1` 時必須走與現行完全相同的單指令路徑，行為不得改變。
- **G6（上限不部分執行）**：可執行 +/- 行數 > `MAX_BATCH_LINES` 時，不得執行任何一行副作用；一律整則拒絕並回提示。

## 三、Acceptance Checks
- [ ] **[D-012 AC-1]**：訊息 `+1 陳小姐\n+1 張先生` → 兩次 `signup`（各 `count=1`、proxyName 分別為兩名），產生 2 筆代報名（`kind='proxy'`）；以一次 reply 回覆。（驗證：unit test，handler + mock service）
- [ ] **[D-012 AC-2]**：同一 `message.id` 的兩行 `+1` 整則**重送** → 每行以 `${id}#0`/`${id}#1` 各自 duplicate → **不新增任何列**；整批全 duplicate → **回空、不 reply**（對齊 D-003 G9）。（驗證：unit/整合，複合鍵去重）
- [ ] **[D-012 AC-3]**：混合行 `+1 A\n今天天氣真好\n-1`（中間非 +/- 行）→ 只執行第 1、3 行（`signup`/`cancel`），中間行忽略；lineIndex 仍為 0/1/2（去重鍵穩定，裁決 #3）。（驗證：unit test，G1）
- [ ] **[D-012 AC-4]**：單行 `+3`（無換行）→ 走現行單指令路徑、行為與 D-003 完全一致（零回歸）。（驗證：unit test，G5）
- [ ] **[D-012 AC-5]**：批次中途容量填滿——capacity 剩 1，`+1\n+1` → 第 1 行正取、第 2 行**整批候補**（後行看得到前行效果，無超賣）。（驗證：整合，序列化交易 / G3）
- [ ] **[D-012 AC-6]**：`-1 A\n-1 B` 兩行 `cancel` 皆執行（`-N` 行可用），各以複合鍵去重。（驗證：unit test）
- [ ] **[D-012 AC-7]**：行數上限——可執行 +/- 行數 > `MAX_BATCH_LINES`（20；空行/被忽略行不計）→ **整則拒絕**、回一句繁中提示、**未執行任何行**（無 markProcessed）；恰 20 行可正常執行。（驗證：unit test，G6、裁決 #2）
- [ ] **[D-012 AC-8]**：part-resend——兩行 `+1`，第 1 行 commit+mark（`${id}#0`）後、第 2 行前中斷；整則重送 → 第 1 行 duplicate 略過、第 2 行（`${id}#1`）首次執行成功 → 最終各 1 筆、**不重複報名**（複合鍵核心價值）。（驗證：整合，模擬中斷後重放）
- [ ] **[D-012 AC-9]**：同一則兩條相同行 `+1 陳小姐\n+1 陳小姐` → index 0/1 為不同去重鍵 → **皆執行**，產生「陳小姐」「陳小姐(2)」兩名額（刻意輸入兩人、**正確行為**，非重複 bug）。（驗證：unit test，roster 後綴）

---

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-17 | #1 合併回覆格式 | 逐行簡短摘要（例「已報名：陳小姐、張先生」）+ 末尾附**一次**更新後名單；有遞補則附 @ 通知（複用 D-003）。以**一次 reply（≤5 則訊息）**表達，不強塞單一 message 物件 |
| 2026-08-17 | #2 每則最大行數上限 + 超過行為 | `MAX_BATCH_LINES=20`；**上限只計可執行的 +/- 行**（空行/被忽略行不計）；超過→**整則拒絕**、回一句繁中提示、**不部分執行** |
| 2026-08-17 | #3 混入非 +/- 指令行 | **忽略**那些行（沿用「只回應可識別指令」），不整則退回原單指令路徑 |
| 2026-08-18 | #4 T-020 review B1：實作逐行一句 vs 設計釘死聚合 | **裁決：改實作、不改設計**（報名側聚合為「已報名：陳小姐、張先生」）。複審續指出取消側亦已聚合但無設計背書 → **追加裁決：取消側同步聚合**，見 §一.3 errata |
| 2026-08-31 | D-020 預告 errata（architect 執行，使用者已核可採納） | 拆行/複合去重鍵邏輯不變；批次目標活動改由 D-020 消歧義（`splitSelector` 於拆行前解一次）決定。**D-020 仍 DRAFT，本次僅預先登記，未生效**。 |
