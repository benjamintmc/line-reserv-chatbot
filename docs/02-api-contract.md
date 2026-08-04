# 02 — 指令契約（LINE Command Contract）

> 擁有者：api-contract-designer。**版本：v0.1（由既有實作反向產生，尚未凍結）**
>
> **本專案沒有前後端分離**：對外介面是 **LINE 群組對話**，不是 REST。真正需要凍結的「介面」
> 是指令語法與回覆範本——使用者記得的是 `+1`，不是 endpoint。REST 面只有 LINE 平台呼叫的
> 兩條，機器可讀版見 `docs/api/openapi.yaml`。
>
> **權威來源**：指令語法 → `design/D-002`；回覆文案 → `src/domain/*-formatter.ts` 與
> D-003/D-004/D-005/D-008。本文件是**跨文件的統一視圖**，衝突時以權威來源為準。

## 通用約定

- **只回應可辨識的指令**；其餘群組訊息一律靜默忽略，避免洗版（FR-5）。
- **只處理群組來源的文字訊息**；非群組、非文字、無 `userId` 者直接忽略。
- 回覆一律**繁體中文**。
- 解析前的正規化順序（D-002 §2）：型別防禦 → 全形空格轉半形 → trim → 空字串短路 →
  白名單字元正規化 → 大小寫折疊比對。
- **流程攔截優先於指令解析**：若該使用者有進行中的 `conversation_states`，
  其訊息一律被當作開團問答的答案，不走指令分派（per-user PK 隔離，同群他人不受影響）。

## 指令語法

| 輸入 | 解析結果 | 說明 |
|---|---|---|
| `+N`（`+1`、`+2`…） | `signup` | N 為 1..20（`MAX_COUNT`）；超出 → `invalid/count_out_of_range` |
| `+N 名字` | `signup` + `proxyName` | 代報名；名字上限 20 字，超長**截斷**而非拒絕 |
| `-N` / `-N 名字` | `cancel` | 同上；取消為 `cancelled_at` 標記，不刪列 |
| `名單` / `list`（大小寫不拘） | `list` | |
| `開團` / `新活動`（無其他 token） | `create_event_start` | 進入逐步問答 |
| `開團 <日期> <時間> <地點> <人數> <費用>` | `create_event_oneline` | 5 個參數；arity/格式錯 → `invalid/create_*` |
| `確認` | `confirm` | 流程中＝送出建立；無流程＝靜默 no-op |
| `取消` | `abort` | 流程中＝放棄開團；無流程＝靜默 no-op |
| `關閉報名` | `close_event` | 授權 = `canManageEvent` |
| `取消活動` | `cancel_event` | 授權 = `canManageEvent`；狀態轉移，**不刪 registrations** |
| `我的ID`（大小寫不拘） | `my_id` | 回自己的 userId，供設定 `ADMIN_USER_IDS` |
| 其餘（含 `+0`、`+abc`、`+ 1`、閒聊） | `unknown` | **不回覆** |

**授權**（D-006）：開團全開，任何群成員都能開；`關閉報名` / `取消活動` 限
`events.host_user_id` 本人 ∪ super-admin（`ADMIN_USER_IDS`）。

## 回覆範本索引

| 情境 | formatter | 檔案 |
|---|---|---|
| 報名成功 / 取消成功 | `formatSignup` / `formatCancel` | `list-formatter.ts` |
| 名單 | `formatList`（`phase`：live / 已截止 / 已結束） | `list-formatter.ts` |
| 候補遞補通知 | `formatPromotionNotice` | `list-formatter.ts`（用 `textV2` + mention） |
| 無活動 / 已結束 / 無可取消 | `formatNoOpenEvent` / `formatEventEnded` / `formatNothingToCancel` | `list-formatter.ts` |
| 開團問答提問 / 欄位錯誤 / 確認摘要 | `formatFlowPrompt` / `formatFieldError` / `formatConfirmSummary` | `event-formatter.ts` |
| 開團成功公告 | `formatOpenAnnouncement` | `event-formatter.ts` |
| 關閉報名 / 取消活動 / 放棄流程 | `formatClosed` / `formatCancelled` / `formatAborted` | `event-formatter.ts` |
| 未授權 / 已有活動 / 無 active | `formatNotAuthorized` / `formatAlreadyActiveEntry` / `formatNoActiveEvent` | `event-formatter.ts` |
| 一行式格式說明 | `formatOnelineFormatHelp` | `event-formatter.ts` |

> 【技術債】`formatAlreadyClosed`、`formatRaceLost` 於 D-008 把 `closed` 移出 active 集合後
> 已成不可達的防禦死碼。

## 去重與拒絕回應政策（**目前不對稱，待統一**）

以 `processed_events`（key = LINE `message.id`）做冪等。現況：

| 情形 | 是否 `markProcessed` | 重送同一訊息的行為 |
|---|---|---|
| 有副作用的步驟（報名、取消、開團、關閉…） | ✔ | 不重複執行、回「重複」 |
| `list` 的 `no_open_event` | ✔ | 不重複回 |
| `signup` / `cancel` 的 `no_open_event`、非白名單、無 active、重複開團 | ✘ | **會重覆回覆一次** |
| `unknown`、無流程的 `confirm`/`abort` | ✘（且不回覆） | 無 |

**這是已知缺口，非設計意圖**：同型問題在 D-003 nit-3、D-004 §9、D-006 三處各出現一次
（LESSONS 登記 ×3，已達回寫門檻）。統一政策待 `T-016 LESSONS 回寫清償` 裁決後回填本節，
**在那之前新增 handler 請沿用「有副作用才 mark」，並在設計文件明確寫出該分支的選擇**。

## REST 面（僅供平台呼叫）

| Method | Path | 說明 |
|---|---|---|
| `POST` | `/webhook` | LINE 事件入口。必帶 `x-line-signature`；驗簽失敗 → 401。**先完成處理（含 replyMessage）才回 200**（serverless 時序，D-007 G3） |
| `GET` | `/health` | 存活探針；**不依賴 DB**，供 Cloud Run 探活 |

驗簽失敗回 `{ "message": "invalid signature" }`（401）。
CLAUDE.md §4 記載的統一錯誤格式 `{ code, message, details }` 目前**沒有對外消費者**，
僅為慣例保留；若日後新增管理 API 再落實。

## Changelog

| 版本 | 日期 | 變更 | 審查者 |
|---|---|---|---|
| v0.1 | 2026-08-05 | 由既有實作反向產生；重定位為指令契約（原 REST 模板全為佔位符，從未填寫） | 待審 |
