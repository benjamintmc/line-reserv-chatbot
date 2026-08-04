# 01 — Architecture（系統架構）

> 擁有者：architect。實作不得偏離本文件；要偏離先開 ADR。
>
> **本文件由既有實作反向產生（2026-08-05，harness 導入）**，反映的是 **PROD LIVE 的現況**，
> 不是理想狀態。凡現況不理想者一律標【技術債】，不美化為設計決策。
>
> **權威來源分工**：本文件是**入口與索引**。細節的權威來源仍是 `design/D-001`~`D-008` 與
> `docs/adr/ADR-001`~`004`；兩者衝突時以設計文件為準，並回報 Orchestrator 修正本文件。

## 系統概觀

一個沒有前端的 LINE 群組報名機器人。使用者在 LINE 群組打 `+1`，bot 回覆更新後的名單。
對外介面是**對話**而非 REST——REST 面只有 LINE 平台呼叫的 webhook 與健康檢查兩條。

```mermaid
graph LR
  U[LINE 群組成員] -->|訊息| LINE[LINE Platform]
  LINE -->|POST /webhook + x-line-signature| CR[Cloud Run<br/>Fastify]
  CR -->|reply API| LINE
  CR -->|pg pooled 連線| NEON[(Neon Postgres)]
  OPS[部署者] -->|npm run db:migrate<br/>直連非 pooler| NEON
```

- **執行環境**：Cloud Run（`group-chatbot-504305` / `asia-east1` / min-instances=0）。
- **請求生命週期**：驗簽 → 逐事件 `handleEvent` → **await 完整處理（含 replyMessage）後才回 200**。
  serverless 於回應送出後可能凍結 CPU，先回 200 會導致回覆漏送（D-007 §4 / G3）。
- **無狀態**：實例不持有任何跨請求狀態；對話流程狀態存在 DB 的 `conversation_states`。

## 模組劃分

| 模組 | 職責 | 對外介面 | 依賴 |
|---|---|---|---|
| `src/server.ts` | Fastify app、LINE 驗簽、DI 組裝（Pool → repositories → runners → services → handler） | `POST /webhook`、`GET /health` | 全部下游 |
| `src/webhook/handler.ts` | 事件分派、`processed_events` 去重、result → LINE 訊息的 render、profile 取名 | `handleEvent(event)` | commands、domain、line |
| `src/commands/` | 純函式指令解析：`normalize`（全形/空白）→ `parse` → `ParsedCommand` 判別聯集；`validators` | `parseCommand(text)` | 無（D-002 G2：零副作用） |
| `src/domain/` | 商業邏輯與訊息組版。`registration-service`（報名/取消/FIFO 遞補）、`event-service`（開團狀態機、授權）、`create-flow`（逐步問答）、`billing`、`roster`、`event-formatter` / `list-formatter` | service 方法回傳 result 判別聯集 | db repositories |
| `src/db/` | `tx.ts`（交易 runner，**client-bound repo 綁定**）、`repositories/`（5 支）、`migrate.ts`、`schema.ts`（Row 型別）、`time.ts`（UTC ↔ 台北） | repository 方法 | `pg` |
| `src/line/client.ts` | Messaging API 客戶端（reply、`getGroupMemberProfile`） | — | `@line/bot-sdk` |
| `src/config.ts` | 環境變數集中讀取；**domain 不讀 env**（D-006 G3） | `config` | `dotenv` |

**分層規則**：handler 不寫商業邏輯；domain 不讀 env、不碰 LINE SDK 型別以外的傳輸細節；
repository 不做決策。指令解析在 `src/commands/`，**不在** `src/domain/`（D-001 §9 errata）。

## 資料模型

四張表，詳細 schema、約束與狀態機的權威來源是 **D-001**（含歷次 errata）。

| 表 | 用途 | 關鍵約束 |
|---|---|---|
| `events` | 一場球聚一列 | `ux_events_active_group` partial unique index → **同群組同時只有一場 active 活動**；active 集合 = `{draft, open}`（D-008 T-014 把 `closed` 移出） |
| `registrations` | **per-slot**：一個名額一列 | `status ∈ {confirmed, waitlist}` 只表達佇列位置；取消以 `cancelled_at` 正交表達（不刪列，保留稽核） |
| `conversation_states` | 開團逐步問答的暫存 | PK = `line_user_id` → 一人同時最多一段流程 |
| `processed_events` | webhook `message.id` 去重 | 冪等性不得只靠記憶體（D-001 G6） |

- `events.event_datetime` 存 **UTC ISO-8601 秒精度**，字典序 == 時序，故過期判定可純字串比較；
  顯示時經 `src/db/time.ts` 還原為台北時間（D-008 §3）。
- 金額一律整數新台幣元。`price_mode ∈ {per_person, split_venue}`；均攤採無條件進位，
  關閉報名時把最終攤額快照進 `settled_per_person`（D-005）。

## 併發與正確性（本專案最關鍵的一節）

超賣防護是這個系統唯一真正困難的部分，經歷過兩次真實缺陷：

1. **交易內所有查詢必須綁同一連線**。pool 下若交易內各查詢走 `pool.query()`，
   `SELECT … FOR UPDATE` 的鎖與後續 INSERT 可能落在不同 client → **鎖形同虛設、靜默超賣**。
   實作用 `buildTxRepos(client)` 產出 client-bound repo 注入 work（D-007 路線 A，`src/db/tx.ts`）。
2. **「讀-決策-寫」的決策輸入也必須在鎖內取得**，不只是寫在鎖內。
   T-012 的 B1 缺陷即為 cancel 用交易**外**快照算遞補額度，sync→async 後在 await 讓點被並發插入
   → 正取數 > capacity。修法為改由鎖內 `RETURNING` 的真實列數推導。
3. `createImmediateRunner` 先 `SELECT id FROM events WHERE id=$1 FOR UPDATE` 鎖住該場，再跑 work；
   第二個並行者阻塞至前者 COMMIT 後才重新計數。

> 這兩條通則已在 `harness/LESSONS.md` 登記為回寫候選（各達 2 次），尚未落成 Guardrail 模板——
> 見 task-board 的 `T-016 LESSONS 回寫清償`。

## 技術選型

| 項目 | 選擇 | 理由 / ADR |
|---|---|---|
| DB | Postgres（Neon serverless，pooled 連線） | ADR-004。原為 SQLite，因 Cloud Run 無持久磁碟而移植（D-007 / T-012） |
| 執行平台 | Cloud Run（min-instances=0） | ADR-004。真免費層；代價是冷啟動 |
| Web 框架 | Fastify 5 | 輕量、`addContentTypeParser` 便於保留 rawBody 供 LINE 驗簽 |
| 測試 | vitest，**PG-only 打真 DB** | D-007 OP-5。不做 in-memory fake——鎖與併發語意是測試重點，fake 測不到 |
| 遷移 | 手寫 `.sql` + `migrate.ts` | 無 ORM。migrate **從啟動路徑解耦**，是部署步驟（D-007 G7/OP-6） |

歷史決策 ADR-001（per-slot 報名）、ADR-002（交易防超賣）、ADR-003（better-sqlite3 版本 pin）
仍保留供追溯；**ADR-003 已隨 PG 移植失效**，該依賴不復存在。

## 非功能性需求

- **安全**：LINE 簽章驗證失敗即 401；secret 一律 runtime env，不進 image、不進版控（D-007 G6）。
- **冪等**：以 `message.id` 去重。**注意去重政策目前不對稱**——見下方技術債。
- **可觀測性**：Pino 結構化 log。單事件處理失敗只記 log 不中止其他事件。
- **效能**：非瓶頸。bot 只用 reply（不消耗 LINE 的 push 額度）。

## 部署

- `Dockerfile` 多階段（node:22-slim）；PG-only 故無 native 依賴，image 小、冷啟快。
- 流程與線上座標見 `docs/deployment-runbook.md`（含 Neon 建 DB → 直連 migrate → build/push → deploy → LINE Verify → 冒煙）。
- `PORT` 由 Cloud Run 注入；`/health` 不依賴 DB，供平台探活。

## 【技術債】現況清單

登記於 task-board Backlog，此處建立交叉索引：

| 項目 | 說明 | 出處 |
|---|---|---|
| 去重政策不對稱 | 純拒絕回覆（`no_open_event` / 非白名單 / 無 active）不 `markProcessed`，重送會重覆回覆；有副作用的步驟才 mark。**同型問題已出現 3 次**仍無統一政策 | LESSONS ×3 |
| 遞補會拆散整批 | `pickWaitlistForPromotion` 以列為單位 `LIMIT`，剩餘名額 < 隊首批次人數時會拆批，與「整批不部分接受」的進場原子性不對稱。修法需 `registrations.batch_id` ⇒ migration ⇒ R2 | T-015 / Backlog |
| 防禦死碼 | `formatAlreadyClosed`、`cancelEvent` 的 `status!=='closed'` 分支等，於 D-008 把 closed 移出 active 集合後已不可達 | T-014 reviewer nit |
| 缺未來時間驗證 | `確認` 未驗 `event_datetime > NOW()`，可建立「即刻過期的死團」 | D-008 §六 nit-6 |
| 設計文件治理成本 | 8 份 D 文件 250–563 行且互相 errata（D-005 一次改動觸及 4 份）。已對既有文件豁免行數上限，但缺輕量 errata 協定 | LESSONS ×3 |
| e2e 未覆蓋 | 代報名、候補遞補、主辦 override 取消等關鍵旅程仍只有 unit 覆蓋 | Backlog |

## Changelog

| 日期 | 變更 | 來源 |
|---|---|---|
| 2026-08-05 | 由既有實作反向產生初版（現況快照，含技術債標記） | harness 1.4.0 導入 |
