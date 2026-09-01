# 02 — 指令契約（LINE Command Contract）

> 擁有者：api-contract-designer。**版本：v0.4（由既有實作反向產生，尚未凍結）**
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
| `編輯`（無參數） | `edit_help` | 回目前活動資訊（日期／時間／場地／費用／人數上限）＋四條範例。未知欄位名（如 `編輯 費率 100`）與「有欄位但缺新值」（`編輯 日期`）亦走此 |
| `編輯 日期 <YYYY/MM/DD 或 YYYY-MM-DD>` | `edit_event{field:'date'}` | 值經既有 `validateDate` 正規化為 `YYYY-MM-DD`；格式錯 → `invalid{command:'edit_event', reason:'create_bad_date'}` |
| `編輯 時間 <H:MM 或 HH:MM>` | `edit_event{field:'time'}` | 值經既有 `validateTime` 正規化為 `HH:MM`（24h 零填充）；格式錯 → `invalid{command:'edit_event', reason:'create_bad_time'}` |
| `編輯 場地 <名稱>` | `edit_event{field:'location'}` | **`地點` 為 parser 收但對外不示範的隱藏別名**（D-015 F1：所有文案一律用「場地」）；值 > 40 字（`MAX_LOCATION_LEN`，UTF-16 code unit）→ `invalid/bad_location`，**不截斷** |
| `編輯 費用 <金額>` | `edit_event{field:'fee'}` | 語法不變，沿用 `validateFee`（依前綴判斷，同開團一行式／D-005 §6.1）：裸 `N` → `per_person`；`場地費N`/`均攤N` → `split_venue`。**任何時候皆可切換計費模式**（含已有人報名後；D-019 反轉 D-015 決議⑥，不再限制僅能同模式改金額）。純格式不合法（如 `abc`）→ domain 回 `bad_fee`（parser 不判、與現有計費模式無關），固定文案：「費用格式不正確。每人固定請輸入金額（例：編輯 費用 2500）；場地費均攤請輸入「場地費」+總額（例：編輯 費用 場地費4000）。」 |
| `編輯 人數 <N>` / `編輯 人數`（缺值） | `edit_event{field:'capacity'}` | **不執行任何異動**，一律回導向文案：增加名額請用 `加開 N`，縮減名額不支援（D-015 G2） |
| 其餘（含 `+0`、`+abc`、`+ 1`、閒聊） | `unknown` | **不回覆** |

**授權**（D-006）：開團全開，任何群成員都能開；`關閉報名` / `取消活動` 限
`events.host_user_id` 本人 ∪ super-admin（`ADMIN_USER_IDS`）。`編輯` 系列同樣是
`canManageEvent`（host ∪ super-admin），且僅限 `open` 且未過期的活動。

### `編輯` 的取值規則（逐欄不同，勿統一）

parser 對 `編輯 <欄位> <新值>` 的「新值」取法**依欄位而異**，兩者刻意相反，抄錯會造成誤拒或壞值：

| 欄位 | 取值 | 為什麼 |
|---|---|---|
| `fee` | **compact**：`tokens.slice(2).join('').replace(/\s+/g,'')` | domain 端呼叫 `validateFee`（D-019 起取代 `validateVenueFee`/`validatePrice`，依前綴判斷計費模式並允許切換）；`validateFee` 內部本身也會 compact，但 parser 端維持既有 compact 行為不變（`parse.ts` 不需改動）。不先壓掉空白，`編輯 費用 場地費 4000`、`編輯 費用 2500 元` 仍會被誤拒 |
| `location` | **保留空格**：`tokens.slice(2).join(' ')` 後 trim | 場地名本身含空格（例：`東方 A 場`）；壓掉會改壞名稱 |
| `date` / `time` | `tokens.slice(2).join('')` 後送 `validateDate` / `validateTime` | 日期時間不含空格，黏合可容忍使用者誤打空白 |

`location` 取值為空字串 → `edit_help`；`fee` compact 後為空字串 → `edit_help`。

### `編輯` 的回覆政策（與 `+N` 的靜默政策刻意不同）

- **首 token 為 `編輯` 者一律回覆、不落入 `unknown`**：`編輯` 不會出現在閒聊，故不套用
  `+N` / `加開` 的靜默防洗版政策。既然無參數 `編輯` 要回現值，`編輯 日期`（缺值）靜默
  就會變成「打對一半卻沒反應」的死角。
- **已知例外（非全域保證）**：
  1. 開團問答進行中時，handler 的 conversation 攔截**優先於**指令解析——本人在該群打
     `編輯 …` 會被當成該題答案（回 field error，非靜默）。
  2. 多行訊息只執行 `+N` / `-N`（D-012 G1），其中含 `編輯` 的行**被忽略**。

## 型別（`src/commands/types.ts` 為實作真值）

`ParsedCommand` 為 discriminated union，判別鍵是 `type`。D-015 新增：

| 成員 | 形狀 | 說明 |
|---|---|---|
| `edit_event` | `{ type:'edit_event'; field: EditEventField; value: string }` | `EditEventField = 'date' \| 'time' \| 'location' \| 'fee' \| 'capacity'`；`capacity` 僅供導向，domain 不執行異動 |
| `edit_help` | `{ type:'edit_help' }` | 回目前資訊＋範例 |

`invalid` 成員同步擴充（**既有指令行為零變更**）：

| 型別 | 新增值 | 說明 |
|---|---|---|
| `InvalidCommandKind` | `'edit_event'` | 可辨識為 `編輯` 嘗試但值畸形 |
| `InvalidReason` | `'bad_location'` | `編輯 場地 …` 超過 `MAX_LOCATION_LEN`（40，UTF-16 code unit 計，同 `MAX_PROXY_NAME_LEN` 計法）；**不截斷** |
| `invalid.detail?` | `{ len: number }`（`InvalidDetail`，**選填**） | 供 `bad_location` 回覆顯示「你輸入了 {n} 字」的實際字數；不帶時上層一律以無 `detail` 處理 |

> 註：開團路徑目前對場地**無**長度限制，40 字上限只在編輯路徑收斂；此不一致已入 Backlog，
> 不在本次契約範圍內。

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
| 編輯成功（改前 → 改後）＋ @ 正取者 / 導引 / 各類拒絕 | 編輯專用 formatter（**不得沿用 `formatFieldError`** 的開團問答字串——那會叫使用者裸打日期，落入 `unknown` 靜默死角） | D-015 §3 逐字釘死；`fee` 欄位切換計費模式時的成功句型與 `bad_fee` 文案改依 D-019 §5 |

> 【技術債】`formatAlreadyClosed`、`formatRaceLost` 於 D-008 把 `closed` 移出 active 集合後
> 已成不可達的防禦死碼。

## 去重與拒絕回應政策（**目前不對稱，待統一**）

以 `processed_events`（key = LINE `message.id`）做冪等。現況：

| 情形 | 是否 `markProcessed` | 重送同一訊息的行為 |
|---|---|---|
| 有副作用的步驟（報名、取消、開團、關閉…） | ✔ | 不重複執行、回「重複」 |
| `list` 的 `no_open_event` | ✔ | 不重複回 |
| **`編輯` 路徑的所有會回覆分支（含全部拒絕：`edit_help`、人數導向、未授權、無 active、已截止、已結束、不得改到過去、`bad_fee`、`bad_location`／格式錯）** | ✔ | 不重複回（`markProcessed` 位於該交易內所有拒絕 early-return **之前**；D-015 G5） |
| `signup` / `cancel` 的 `no_open_event`、非白名單、無 active、重複開團 | ✘ | **會重覆回覆一次** |
| `unknown`、無流程的 `confirm`/`abort` | ✘（且不回覆） | 無 |

**這是已知缺口，非設計意圖**：同型問題在 D-003 nit-3、D-004 §9、D-006 三處各出現一次
（LESSONS 登記 ×3，已達回寫門檻）。統一政策待 `T-016 LESSONS 回寫清償` 裁決後回填本節，
**在那之前新增 handler 請沿用「有副作用才 mark」，並在設計文件明確寫出該分支的選擇**。

> **`編輯` 是明文例外**：該路徑直接落實 CLAUDE.md §4 的通則（凡會回覆者一律消費
> `message.id`），不沿用上述舊政策。D-006 §2／G2「非授權者不 mark」的範圍限
> `closeEvent`／`cancelEvent`，D-010 G4 的範圍限 `addCapacity`。非授權者在編輯路徑
> **會** mark `processed_events`，但仍**不得** upsert `users`。

## 尚未生效的預告：D-020（同群多場並行活動，DRAFT）

> **本節純供追溯／預告，不代表目前系統行為**。`design/D-020-multi-event-per-group.md` 仍是
> **DRAFT**（待 design-reviewer + architect-reviewer 雙審 + 使用者核可才會實作）。在其落地前，
> 系統仍維持本文件其餘章節所述的「同群同時只有一場 active 活動」限制；以下僅預先登記其**若**
> 落地會牽動的契約面，供 reviewer／未來實作者追溯，**不得誤讀為現行行為**。

- **解除單場限制**：同群可同時有多場 `open` 活動；`+N`/`-N`/`名單`/`加開`/`分組`/`下一輪`/
  `關閉報名`/`取消活動`/`編輯` 於候選數 > 1 時需**消歧義**才能決定目標活動。
- **消歧義機制 A（quote-reply）**：使用者引用 bot 先前的一則訊息並回覆，即以該訊息對應的活動
  為目標。
- **消歧義機制 B（`@selector` 前綴）**：訊息以 `@<場地/日期/時間片段>` 開頭可指定目標活動，
  如 `@旭陽 8/15 +1`；語法細節見 D-020 §4.2。
- **消歧義失敗的四種新拒絕**：候選 >1 且無 quote/selector（`ambiguous`）、quote 與 selector
  指向不同活動（`conflict`）、selector 命中 0 場（`not_found`）、selector 命中 >1 場
  （`too_many`），各自固定中文提示，見 D-020 §5.2。
- **開團新增同群上限**：同群同時最多 **3 場** `open` 活動；達上限時 `開團`（一行式與逐步問答
  皆同）回固定文案「此群組已有 3 場進行中的球敘，請等其中一場結束後再開新團」（不帶任何活動
  明細），與既有的「場地+時間查重」（`duplicate_event`）為**兩種獨立拒絕**，訊息與判斷邏輯
  不共用（D-020 §3.5）。此上限為**應用層計數**判斷，非 DB 約束。

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
| v0.2 | 2026-08-23 | D-015／T-026 回填：指令一覽新增 `編輯` 6 列；新增〈`編輯` 的取值規則〉〈`編輯` 的回覆政策〉〈型別〉三節（`edit_event`／`edit_help`、`InvalidCommandKind:'edit_event'`、`InvalidReason:'bad_location'`、選填 `invalid.detail{len}`）；去重政策表新增編輯路徑列與明文例外註；回覆範本索引新增編輯列。REST 面與 `openapi.yaml` 無異動（本功能不新增 HTTP endpoint） | architect-reviewer（T-026 PASS） |
| v0.3 | 2026-08-31 | 新增〈尚未生效的預告：D-020〉一節，預先登記同群多場並行活動＋訊息消歧義（`@selector`／quote-reply）與同群 open 數上限（3 場，固定文案）若落地將牽動的契約面。**D-020 仍是 DRAFT，本次僅為 errata 預先登記，不代表現行行為已改變**；其餘章節未變動 | architect（D-020 errata） |
| v0.4 | 2026-09-01 | **本次變更來源 D-019（2026-09-01，APPROVED）**：`編輯 費用` errata——反轉 D-015 決議⑥，改為**任何時候皆可切換計費模式**（含已有人報名後），語法不變、沿用 `validateFee` 依前綴判斷 `per_person`/`split_venue`；同步更新〈`編輯` 的取值規則〉表 `fee` 列說明（`validateFee` 取代 `validateVenueFee`/`validatePrice`，不再是「已被 D-015 G6 禁用」）；補上新 `bad_fee` 固定文案（純格式錯誤，不再依現有計費模式分岔）；回覆範本索引 `編輯` 列註記切換行為改依 D-019 §5。**REST 面與 `openapi.yaml` 無異動**（本功能不新增/變更 HTTP endpoint，`EditEventResult`/`EditOk` 等為 domain 內部型別，未列於本文件〈型別〉節，故無需同步） | 待 architect-reviewer 確認 |
