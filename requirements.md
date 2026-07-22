# 高爾夫球聚 LINE Chatbot — 需求規格與開發計畫

> 本文件可直接作為 Claude Code 專案的起始規格（建議放在 repo 根目錄，或作為 `CLAUDE.md` 的基礎）。

---

## 1. 專案概述

打造一個整合在 LINE 群組中的活動報名 chatbot，用於高爾夫球聚的召集與報名管理。核心體驗：

- 一般成員在群組輸入 `+1`（或 `+2`、`+3`…）即完成報名，bot 即時回覆目前報名名單。
- 具「主辦人」身分的用戶可透過 chatbot 建立下一場活動（日期、時間、地點、可報名人數、每人價格）。
- 系統管理員可在後台指定哪些 LINE 用戶具備主辦人資格。

## 2. 角色定義

| 角色 | 說明 | 權限 |
|---|---|---|
| 一般成員 | 群組內任何用戶 | 報名（+N）、取消（-N）、查詢名單與活動資訊 |
| 主辦人（Host） | 由管理員指定的用戶 | 一般成員權限 + 建立活動、關閉/取消活動、手動調整名單 |
| 系統管理員（Admin） | 系統維運者 | 管理主辦人白名單、查看所有活動資料 |

## 3. 功能需求

### FR-1 報名機制
- **FR-1.1** 活動開放報名期間，成員在群組輸入 `+1` 即以「傳訊人的 LINE 顯示名稱」報名 1 位。
- **FR-1.2** 支援 `+2`、`+3`、`+4`… 一次報名多位，名單顯示為傳訊人名字加編號，例如 `王小明`、`王小明(2)`、`王小明(3)`。
- **FR-1.3** 同一人重複輸入 `+N` 視為「追加」報名（例如已 +1 再 +2 → 共 3 位）。
- **FR-1.4** 報名成功後 bot 回覆：活動摘要 + 目前完整名單（條列）+ 剩餘名額。
- **FR-1.5** 報名額滿時：拒絕超額報名並回覆「已額滿」。若 `+N` 會導致超額，僅接受剩餘名額內的數量並明確告知（或全數拒絕，見 §10 待確認）。
- **FR-1.6** 支援取消：輸入 `-1`、`-2`… 減少自己的報名人數；歸零則從名單移除。

### FR-2 名單查詢
- **FR-2.1** 輸入 `名單`（或 `list`）時，bot 回覆目前活動資訊 + 已報名名單（依報名順序條列、含序號）+ 已報名/上限人數 + 每人價格 + 預估總金額。
- **FR-2.2** 無進行中活動時，回覆「目前沒有開放報名的活動」。

### FR-3 活動建立（主辦人限定）
- **FR-3.1** 主辦人輸入 `開團` 或 `新活動` 觸發建立流程；非主辦人觸發時回覆權限不足。
- **FR-3.2** 需收集欄位：日期、時間、地點、可報名人數上限、每人價格。
- **FR-3.3** 收集方式採兩種並行：
  - 一行式指令：`開團 2026/08/15 07:30 東方球場 16人 2200元`（bot 解析欄位）。
  - 逐步問答（conversation state）：bot 依序詢問各欄位，適合不熟指令格式的主辦人。
- **FR-3.4** 建立前 bot 顯示活動摘要並請主辦人回覆 `確認` 才正式開團；開團後在群組公告活動資訊與報名方式。
- **FR-3.5** 同一群組同時間僅允許一場「進行中」活動（見 §10 待確認）。
- **FR-3.6** 主辦人可輸入 `關閉報名`、`取消活動` 管理活動狀態。

### FR-4 主辦人管理（後台）
- **FR-4.1** Admin 可新增/移除主辦人（以 LINE userId 為準）。
- **FR-4.2** MVP 階段以最簡方式實作即可：環境變數或資料表 + 簡單 CLI/API；未來可擴充為簡易 admin 網頁或 LIFF。
- **FR-4.3** 提供輔助指令讓用戶查詢自己的 userId（例如私訊 bot 輸入 `我的ID`），方便 Admin 設定白名單。

### FR-5 訊息行為規範
- Bot 只回應可識別的指令（`+N`、`-N`、`名單`、`開團` 等），其餘群組訊息一律忽略，避免洗版。
- 所有回覆使用繁體中文。

## 4. 指令規格總表

| 指令 | 對象 | 行為 |
|---|---|---|
| `+1` ~ `+N` | 全員 | 報名 N 位（掛在傳訊人名下） |
| `-1` ~ `-N` | 全員 | 取消 N 位 |
| `名單` / `list` | 全員 | 顯示活動資訊與報名名單 |
| `開團 <日期> <時間> <地點> <人數> <價格>` | 主辦人 | 一行式建立活動 |
| `開團` | 主辦人 | 進入逐步問答建立流程 |
| `確認` / `取消` | 主辦人 | 開團流程中確認或放棄 |
| `關閉報名` | 主辦人 | 停止接受報名 |
| `取消活動` | 主辦人 | 取消進行中活動並公告 |
| `我的ID` | 全員（私訊） | 回覆該用戶的 LINE userId |

## 5. 非功能需求

- **NFR-1** Webhook 回應需在 LINE 平台逾時限制內完成；報名寫入需處理併發（多人同時 +1 不可導致超賣，使用 DB transaction / row lock）。
- **NFR-2** 報名操作具冪等保護：以 LINE webhook 的 `message.id` 去重，避免重送事件造成重複報名。
- **NFR-3** 資料持久化，服務重啟不遺失活動與報名資料。
- **NFR-4** 顯示名稱取自 LINE Profile API，並在報名當下快照儲存（之後改名不影響歷史名單）。
- **NFR-5** 秘密資訊（channel secret / access token）一律走環境變數，不進版控。

## 6. 資料模型（草案）

```
users
  id            PK
  line_user_id  TEXT UNIQUE
  display_name  TEXT            -- 最近一次快照
  is_host       BOOLEAN DEFAULT false
  created_at    TIMESTAMP

events
  id            PK
  group_id      TEXT            -- LINE group/room id
  host_user_id  FK -> users
  event_date    DATE
  event_time    TIME
  location      TEXT
  capacity      INTEGER
  price_per_person INTEGER
  status        TEXT  -- draft / open / closed / cancelled / done
  created_at    TIMESTAMP

registrations
  id            PK
  event_id      FK -> events
  user_id       FK -> users
  display_name  TEXT            -- 報名當下快照
  count         INTEGER         -- 該用戶目前報名人數
  updated_at    TIMESTAMP
  UNIQUE(event_id, user_id)

conversation_states              -- 逐步開團問答用
  line_user_id  TEXT PK
  state         TEXT
  payload       JSONB
  updated_at    TIMESTAMP

processed_events                 -- webhook 冪等去重
  message_id    TEXT PK
  processed_at  TIMESTAMP
```

## 7. 系統架構與技術選型（建議）

- **語言/框架**：Node.js + TypeScript + Fastify（或 Express），搭配官方 `@line/bot-sdk`。若偏好 Python 可改 FastAPI + `line-bot-sdk`，架構相同。
- **資料庫**：MVP 用 SQLite（單機簡單）；若部署在無持久磁碟的平台則直接用 PostgreSQL（Supabase / Neon 免費層即可）。
- **部署**：任一支援 HTTPS 的平台（Render / Fly.io / Cloud Run）。開發期用 ngrok 對接 LINE webhook。
- **LINE 設定**：Messaging API channel、關閉自動回覆、webhook 開啟、bot 加入群組權限開啟。

```
LINE Platform ──webhook──▶ API Server ──▶ Command Parser
                                   │            │
                                   │      ┌─────┴──────┐
                                   │   報名邏輯    開團流程(state machine)
                                   │      └─────┬──────┘
                                   └──────────▶ DB (events/registrations/users)
```

## 8. 開發計畫（Milestones）

### M0 環境與骨架（0.5 天）
- 建立 repo、TypeScript 專案、lint/test 設定。
- LINE channel 申請、webhook 驗證（echo bot 跑通）、ngrok 對接。

### M1 資料層與指令解析（0.5–1 天）
- DB schema + migration。
- Command parser：`+N` / `-N` / `名單` / `開團` / 其他忽略。單元測試涵蓋各種輸入（`+1`、`＋１` 全形、`+0`、`+99` 上限保護）。

### M2 報名核心（1 天）
- `+N` / `-N` 報名與取消，含追加邏輯、額滿判斷、transaction 防超賣、webhook 去重。
- 名單回覆訊息格式（Flex Message 或純文字，MVP 先純文字）。

### M3 開團流程（1–1.5 天）
- 一行式指令解析（日期/時間/地點/人數/價格）。
- 逐步問答 state machine + 確認機制。
- 主辦人權限檢查、`關閉報名`、`取消活動`。

### M4 主辦人管理與輔助功能（0.5 天）
- `我的ID` 指令、host 白名單管理（CLI 或簡單 admin API）。

### M5 部署與驗收（0.5 天）
- 正式環境部署、環境變數設定、webhook 切換、實機群組測試。

## 9. 驗收標準（節錄）

1. 群組中輸入 `+3` 後，名單出現 `王小明`、`王小明(2)`、`王小明(3)`，剩餘名額正確扣減。
2. 兩人同時報名最後一個名額，僅一人成功，另一人收到額滿訊息。
3. 非主辦人輸入 `開團` 被拒絕；主辦人可完整走完開團 → 公告 → 報名流程。
4. 服務重啟後名單資料完整保留。
5. Bot 對群組閒聊訊息完全不回應。

## 10. 待確認事項（開工前決定）

1. `+N` 導致超額時：部分接受（補滿剩餘）還是全數拒絕？（建議：部分接受並告知）
2. 額滿後是否需要候補（waitlist）機制？（建議：MVP 不做，v2 再加）
3. 同一群組是否可能同時有多場活動？（建議：MVP 限一場，簡化 `+1` 的對象判斷）
4. 是否需要幫非 LINE 用戶代報名（例如 `+1 陳大哥`）？（常見需求，建議 v1.1 支援 `+1 名字` 語法）
5. 活動結束後是否需要分組（每組 4 人的球組編排）與收款統計？（v2 候選功能）
6. Admin 後台的形式：CLI／API 即可，還是需要網頁介面？

## 11. Claude Code 起手建議

在 Claude Code 中可用以下 prompt 開始：

```
請閱讀 golf-line-bot-requirements.md，依照 M0–M2 的計畫初始化專案：
- Node.js + TypeScript + Fastify + @line/bot-sdk + better-sqlite3
- 建立 DB schema 與 migration
- 實作 webhook 驗證與 command parser（含單元測試）
先不要部署，完成後告訴我如何用 ngrok 本地測試。
```

需要準備的環境變數：

```
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
DATABASE_URL=            # 若使用 PostgreSQL
ADMIN_USER_IDS=          # 逗號分隔的初始主辦人 userId（可選）
```
