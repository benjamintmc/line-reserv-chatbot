# D-006: 授權簡化（開團人擁有 + super-admin 安全網）

狀態：DRAFT

- 撰寫者：backend-engineer
- 風險等級：R2（高）——生命週期授權模型變更（`關閉報名`/`取消活動` 授權來源改變）＋回改 D-004（APPROVED）授權。依 CLAUDE.md §5：強制 design-reviewer + architect-reviewer 雙審 + e2e，Guardrails ≥ 3（本文件列 6 條）。
- 關聯：Brief 決策 #7（2026-07-31，開團人擁有模型，取代 #6）§85–91 / FR-4 主辦人授權 §35 / 指令表 `我的ID` §69 / 里程碑 M4 §76 ・ 任務 T-011 ・ 設計 D-006
- 相依：
  - **D-003（APPROVED / 已實作 T-006）**：`event.host_user_id` 為報名 override（`-N 名字`）授權依據。本模型沿用同一 `host_user_id` 概念，將其擴為生命週期授權依據之一。報名核心零改動（見 §6 不動清單）。
  - **D-004（APPROVED / 已實作 T-008）**：`EventService` 生命週期授權**現為「注入 env 白名單 `hostUserIds`」單軌**（§1、G1）。**本文件改為「開團全開 + close/cancel 限 `host_user_id` ∪ super-admin」→ 回改 D-004（APPROVED），需 errata**（見 §2、§五）。
  - **D-005（APPROVED / 已實作 T-010）**：`確認` 建立 open event 時自動登記主辦為第 1 正取（§3）依 `host_user_id`。本文件**不影響**此行為（host_user_id 來源與時機不變，見 §1、§6）。僅供追認。

---

## 一、設計內容

### 0. 定位與前提（作廢管理人認領）

本文件先前版本（DRAFT）設計「群內 `管理人設定`/`我是管理人` 自助認領最多 3 位 + 雙軌生命週期授權 + `group_admins` 表 + migration 0003」。**使用者於 2026-07-31 決策 #7 作廢該方案**，改採更精簡的 **「開團人擁有 + super-admin 安全網」模型（模型 B）**：

- **開團**（`create_event_oneline`/`create_event_start`）：群內**任何人皆可**，移除既有授權檢查（不再需要白名單）。
- **關閉報名 / 取消活動**（`close_event`/`cancel_event`）：限**該活動建立者**（`event.host_user_id`）**或** env `ADMIN_USER_IDS`（super-admin，跨群安全網）。
- **super-admin 安全網**：env `ADMIN_USER_IDS` 保留，可跨群取消任何卡住的活動（唯一破口救援：建立者落跑/亂開時）。

**取捨（一句）**：同群單場（`ux_events_active_group`，決策 #3）已天然防「亂開多團」，開團全開的濫用面極小；而以 `event.host_user_id`（既有欄位）承載生命週期擁有權，可**零新 schema、零 migration、零新指令、零新資料表**，資料結構最精簡。

**架構慣例（沿用 D-003/D-004/D-005，不得破壞）**：授權判定在 domain（`event-service`），只透過 repository 存取、不直接下 SQL、不 import `@line/bot-sdk`；LINE 型別只在 `handler.ts`。super-admin 集合以 DI 注入，domain 不讀 `process.env`（沿用 D-004 G1）。回覆一律繁體中文，只回應可識別指令（FR-5）。

### 1. 授權模型（開團人擁有 + super-admin）

#### 1.1 開團：無授權

`create_event_oneline`／`create_event_start`／`create_event`（invalid 格式提示）**移除所有授權檢查**——群內任一成員皆可觸發開團流程。唯一守門仍是同群單場（`findActiveByGroup` 入口拒絕 + `確認` 撞 `ux_events_active_group` 安全網，D-004 §6，**不變**）。

#### 1.2 close/cancel：`canManageEvent`

定義生命週期管理授權（供 `close_event`／`cancel_event`）：

```
canManageEvent(event, executorLineUserId)
  = superAdminUserIds.has(executorLineUserId)                       // super-admin（env ADMIN_USER_IDS，注入；跨群、不依賴 event）
    ∨ (executor = users.getByLineUserId(executorLineUserId)) !== undefined
       ∧ executor.id === event.host_user_id                         // 該活動建立者本人
```

- **super-admin 集合**：`config.adminUserIds`（env `ADMIN_USER_IDS`）以 DI 注入 domain（維持 domain 純度，沿用 D-004 G1「domain 不讀 env」）。命名由 `hostUserIds` 改為語意更準確的 `superAdminUserIds`（見 §2）。super-admin 判定**只比對 `line_user_id`、不需 DB**（跨群恆真，救援用）。
- **建立者判定**：以 `UserRepository.getByLineUserId(executorLineUserId)`（**唯讀**，已存在原語）解析 executor 的 `user.id`，再與 `event.host_user_id` 比對。
  - **為何唯讀（不 upsert）**：建立者於 `確認` 時必已 `users.upsert` 建列（D-004 §4 step 4），故建立者恆有 `users` 列；super-admin 走 env 比對不需列。對**非建立者、非 super-admin** 的執行者，唯讀查詢**不寫任何列** → 滿足「非授權者無 DB 變更」（G2、AC-4/5）。若改用 `upsert` 會為未授權者新增一列 users，違反該 AC，故一律採唯讀 `getByLineUserId`（見 §四 OP-1，對任務「upsert」措辭之收斂）。
- **授權時機（必在交易外/去重前）**：`canManageEvent` 判定於**進交易前**（`markProcessed` 之前）完成；未通過即 early-return `not_authorized`，**不 mark、不寫任何 DB**（沿用 D-004 非授權者 early-return 慣例）。授權需先 `findActiveByGroup` 讀出 event 以取 `host_user_id`，故 `no_active`（無活動可管）亦於進交易前判定（見 §2 流程）。

#### 1.3 `host_user_id` 生命週期與授權分工（不變 + 收斂）

- **`host_user_id` 來源與時機不變**（D-004 G8、D-005 §3）：`確認` 建立 open event 時 `host_user_id = 建立者 user.id`；主辦自動登記為第 1 正取（seat 1）不受影響。差別僅在「建立者」現可為任一群成員（開團全開），而非 env 白名單成員。
- **授權分工收斂**：
  - **生命週期（close/cancel）授權** = `host_user_id` ∪ super-admin（本文件）。
  - **報名 override（`-N 名字` 代取消他人代報名額）授權** = `event.host_user_id`（D-003 既有，僅建立者）。
  - 兩者現同以 `host_user_id` 為主體（super-admin 為 close/cancel 額外安全網），較 D-004「生命週期＝env 白名單、override＝host_user_id」的雙來源更一致、更好守（單一擁有權概念）。

### 2. 對 D-004 `event-service` 的具體改法（APPROVED errata）

`src/domain/event-service.ts`（僅授權判定改，流程主體不動）：

**（a）`EventServiceDeps` 語意正名**
- `hostUserIds: ReadonlyArray<string>` → **`superAdminUserIds: ReadonlyArray<string>`**（仍由 `server.ts` 以 `config.adminUserIds` 注入；domain 不讀 env）。內部 `this.hostUserIds: Set` → `this.superAdmins: Set`。
- **不新增依賴**：`users` 已在 deps；**不需 `group_admins` repo**（本模型無此表）。

**（b）移除開團授權**
- `startCreation` / `handleOneline` / `handleInvalidOneline` **刪除** `if (!this.isAuthorized(...)) return { kind:'not_authorized' }` 分支——開團全開。
- 連帶：`CreateEntryResult` **移除** `{ kind:'not_authorized' }` 成員；`InvalidOnelineResult` 收斂為單一 `{ kind:'format_help' }`（`handleInvalidOneline` 恆回 `format_help`）。handler 對應 render 分支一併移除（§4）。

**（c）close/cancel 改 `canManageEvent`**
- 移除舊 `private isAuthorized(lineUserId)`（env 單軌）。
- 新增 `private canManageEvent(event, executorLineUserId): boolean`（§1.2 判定）。
- `closeEvent` / `cancelEvent` 流程改為（示意，去重與轉移主體不變）：

```
closeEvent(input):                      // cancelEvent 同型
  const active0 = events.findActiveByGroup(input.groupId)   // 進交易前讀（取 host_user_id）
  if (active0 === undefined) return { kind: 'no_active' }    // 無活動可管（不 mark、無副作用）
  if (!this.canManageEvent(active0, input.executorLineUserId))
     return { kind: 'not_authorized' }                       // 非建立者非 super-admin（不 mark、無 DB 變更）
  return this.tx(() => {
     if (!processed.markProcessed(messageId)) return { kind:'duplicate' }
     const active = events.findActiveByGroup(input.groupId)  // 交易內權威重讀（D-004 §5.2 原邏輯）
     ...（狀態合法性判定、updateStatus、D-005 §4 結算，全部不變）...
  })
```

- **行為差異註記**：`no_active` 現於**進交易前** early-return（不消費 messageId），因授權需先讀 active。此較 D-004 原「no_active 於交易內 mark 之後判定」更早退、無副作用（更契合「拒絕不留痕」）；對使用者可觀察行為（回 (J)）不變，僅 messageId 去重覆蓋面略縮（重送同一 `無活動` 拒絕會再回一次，與 D-004 §9「交易前 early-return 不 mark」政策一致，低度洗版可接受）。
- **`LifecycleInput` 不變**：`canManageEvent` 走唯讀 `getByLineUserId`，**不需** executor displayName，故 `LifecycleInput`（groupId/executorLineUserId/messageId）維持原狀，handler 呼叫點不需傳新欄位。
- `confirm` / `abort` / `continueFlow` / `startCreation`（除刪授權外）**流程主體零改動**；D-005 §3 主辦自動登記、§4 split 結算**零改動**。

**本節回改 D-004（APPROVED）→ errata（§五協調，回報 Orchestrator，不私改 D-004 正文）。**

### 3. `我的ID`（my_id）接線

`my_id` **已存在於 `ParsedCommand` union**（`src/commands/types.ts:65`）且 D-002 §3 已解析 `我的id`（case-fold）。現 handler 為 no-op（`handler.ts:433`）。本文件**僅接線**：回覆傳訊人自身 `userId`（供設 env `ADMIN_USER_IDS` 成為 super-admin，或告知系統管理員）。

- **回覆通道**：**群回**（單則，`replyToken` 可達；push 私訊對未加 bot 好友者會失敗）。訊息 (MyID)（§5），附「可提供給系統管理員」說明（見 OP-3）。
- **無 DB 副作用、不 mark**（唯讀、無狀態變更；同 `list`）。

### 4. webhook 分派（`src/webhook/handler.ts`）

於現有 `switch (cmd.type)`：

| `ParsedCommand.type` | handler 行為 | 授權 | 去重 |
|---|---|---|---|
| `create_event_oneline` / `create_event_start` | 直接呼叫 `eventService.handleOneline`/`startCreation`（**不再前置/回傳授權**；render 移除 `not_authorized` 分支） | 無（開團全開） | 承 D-004 |
| `close_event` / `cancel_event` | 呼叫 `eventService.closeEvent`/`cancelEvent`；service 內 `canManageEvent` 判定；非授權 → (H′) | service 內判（host_user_id ∪ super-admin） | 承 D-004（授權通過後交易內 mark） |
| `my_id` | **接線**：`return [toLineMessage(formatMyId(userId))]` → (MyID)（現為 no-op） | 無 | 不 mark（唯讀、無副作用） |
| `invalid`（`command==='create_event'`） | `eventService.handleInvalidOneline` → 恆 (K′) 格式提示（**移除非授權 (H) 分支**） | 無 | 不 mark |
| 其餘（signup/cancel/list/confirm/abort/invalid 其他/unknown） | 不變（D-003/D-004） | — | — |

- `confirm`/`abort`：維持 D-004「有流程於分派前攔截；無流程 → 靜默 no-op」，**不另做授權**（隱含由 `conversation_states` per-user PK 擁有權保證；其 conversation 只可能由該執行者自己的 `開團` 建立）。
- 分派 `switch` 維持 union 窮舉（`default: never`）；`create_*` render 移除 `not_authorized` case 後仍窮舉。

### 5. 訊息範本（純文字，繁體中文）

**(H′) 非建立者、非 super-admin 試 `關閉報名`/`取消活動`**（取代 D-004 (H) 文案；見 §五 errata）
```
只有開團的人（或系統管理員）可以關閉報名／取消活動。
```
（design-reviewer N1：兩授權主體並列、句式順化。）
（`formatNotAuthorized()` 文案由 D-004 原 (H)「只有主辦人可以開團／管理活動。」更新為上式。**開團已全開，故無「非授權開團」訊息**——`create_*` 不再產生 not_authorized。此 formatter 僅剩 close/cancel 使用。）

**(MyID) 我的ID**（design-reviewer B1/B2：標籤改 (MyID) 避免與 D-004 (F) 取消回覆碰撞；繁中化、移除英文 super-admin、順循環語意）
```
你的 LINE 使用者 ID：
{userId}
（可提供給系統管理員，加入管理權限設定。）
```

### 6. 模組影響清單（零 schema、零 migration、零新指令）

**改**：

| 檔案 | 類型 | 說明 |
|---|---|---|
| `src/domain/event-service.ts` | 修改 | `hostUserIds`→`superAdminUserIds` 正名；移除 `create_*` 授權（含 `CreateEntryResult.not_authorized`、`InvalidOnelineResult` 收斂）；`isAuthorized`→`canManageEvent`（唯讀 `getByLineUserId` ∪ super-admin）；close/cancel 授權前置——**D-004 errata，回報** |
| `src/domain/event-formatter.ts` | 修改 | `formatNotAuthorized` 文案 → (H′)；新增 `formatMyId(userId)` → (MyID)——(H) 文案屬 D-004 errata，回報 |
| `src/webhook/handler.ts` | 修改 | `my_id` 接線 (F)；`create_*`/`invalid` render 移除 `not_authorized` 分支 |
| `src/server.ts` | 修改 | `EventService` 注入 `superAdminUserIds`（仍為 `config.adminUserIds`；僅參數名變更） |
| `.env.example` | 修改 | `ADMIN_USER_IDS` 註解語意更新為「super-admin（跨群安全網、可救援任何卡住的活動；**非開團白名單**，開團全開）」 |
| `src/index.ts`（啟動警告） | 修改 | **（architect-reviewer 裁定點 2 緩解）** 啟動時若 `config.adminUserIds` 為空，`app.log.warn` 提示「未設 super-admin，卡住的活動將無法救援（除 DB 手術）」——把安全網存在性從隱性假設變顯性守門（比照 `missingLineCredentials` 警告模式）。 |

**明確不動（零回歸）**：

- **零 schema / 零 migration / 零新資料表**：`migrations 0001/0002`、`events`/`registrations`/`conversation_states`/`processed_events`/`users` 結構全不動；`users.is_host` 維持 D-001 現狀（不寫入）。**無 `group_admins` 表**（作廢）。
- **零新指令**：parser 不改；`my_id` 已存在，僅 handler 接線；**無 `管理人設定`/`我是管理人`**（作廢）。
- **報名核心**：`registration-service.ts`、`registration-repository.ts`、`list-formatter.ts`、遞補/候補/代報名邏輯全不動。
- **計費（D-005）**：`billing.ts`、`price_mode`/`venue_fee`/`settled_per_person`、split 結算全不動。
- **開團流程主體**：`create-flow.ts`（逐步問答 state machine）、`event-service` 的建立/確認/關閉/取消**流程步驟**（僅授權判定改，流程不變）、主辦自動登記（seat 1）。

### 範圍內

- 開團全開：移除 `create_*`/`create_event` invalid 的授權檢查。
- close/cancel 授權 = `canManageEvent`（`host_user_id` ∪ super-admin，唯讀解析 executor）。
- super-admin 正名（`superAdminUserIds` 注入）+ `.env.example` 註解更新。
- `我的ID` 接線（群回自身 userId，(F)）。
- (H′) close/cancel 非授權文案；formatter/handler render 對應調整。
- 回改 D-004 event-service 授權（errata，回報）。

### 範圍外（明確不做）

- **`group_admins` 表 / migration / 管理人認領指令 / 雙軌認領 / 網頁後台**（決策 #7 作廢）。
- **執行期增刪 super-admin**（仍走 env `ADMIN_USER_IDS`）。
- **報名核心 / 計費 / 開團流程主體 / schema**（僅授權判定改動，見不動清單）。
- **`我的ID` 私訊通道 / 隱私遮罩**（MVP 群回，見 OP-3）。

---

## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）

- **G1（開團全開，不設授權）**：`create_event_oneline`/`create_event_start`/`create_event`（invalid）**不得**含任何授權 gate（不得檢查 `superAdminUserIds`、`host_user_id` 或任何白名單）；任一群成員的開團**不得**因授權被拒。唯一守門為同群單場（`findActiveByGroup` + `ux_events_active_group`，不得移除）。
- **G2（close/cancel 授權正確 + 非授權無副作用）**：`close_event`/`cancel_event` 授權**只得**依 `canManageEvent = superAdminUserIds.has(lineUserId) ∨ (getByLineUserId(lineUserId).id === event.host_user_id)`；非授權者（非 super-admin 且非建立者）**不得**改 event 狀態（不 `updateStatus`）、**不得**消費 messageId（不 `markProcessed`）、**不得**新增任何 DB 列（executor 解析須唯讀 `getByLineUserId`，**不得** `upsert`），且**不得**繞過授權（不得先讀他表或以其他來源判定）。
- **G3（super-admin 注入、domain 不讀 env）**：super-admin 集合**只得**由 DI 注入（`superAdminUserIds`，來源 env `ADMIN_USER_IDS`）；domain（`event-service`）**不得** `process.env`。super-admin 判定**不得**依賴任何 DB 查詢（純 `line_user_id` 比對，跨群恆真）。
- **G4（domain 不下 SQL、不觸 LINE、禁 any）**：`event-service.ts`/`event-formatter.ts` **不得**出現 SQL 字串或直接存取 `db`（一律經 repository），**不得** import `@line/bot-sdk`；LINE 型別只在 `handler.ts`。改寫程式**不得**使用 `any`；`canManageEvent`、各 `*Result` 皆具名定型。
- **G5（零 schema / 零指令改動）**：本文件**不得**新增/修改任何 migration、`schema.ts` 列型別、資料表或索引；**不得**新增 `ParsedCommand` 成員或 parser 規則；**不得**新增 `group_admins`/`group_settings` 等資料表。
- **G6（取消活動不刪 registrations）**：`取消活動` **一律為 `events.status → cancelled` 的狀態轉移**，**不得**對 `registrations` 下任何 `DELETE`（沿用 D-004 G10）；registrations 及取消稽核欄一併保留。

---

## 三、Acceptance Checks（每條可轉測試；標記 `[D-006 AC-n]`）

- [ ] **[D-006 AC-1]（任何人開團成功）**：非 super-admin、群內任一成員 X `開團 …`（一行式）→ 回確認摘要 (B)、寫 conversation(`awaiting_confirm`)；`確認` → 建立 open event（`host_user_id = X.id`）、無 `not_authorized`。逐步 `開團` 亦同（回首問 (A)）。（驗證：unit/整合 test / G1、§1.1）
- [ ] **[D-006 AC-2]（建立者可關閉）**：建立者 X 於自建 open 活動 `關閉報名` → `updateStatus(closed)`、回 **D-004 (E)** 關閉回覆。（驗證：unit test / G2、§2）
- [ ] **[D-006 AC-3]（建立者可取消）**：建立者 X `取消活動` → `updateStatus(cancelled)`、回 **D-004 (F)** 取消回覆。（驗證：unit test / G2、§2）
- [ ] **[D-006 AC-4]（非建立者非 super-admin 關閉被拒，無 DB 變更）**：成員 Y（≠ host、非 super-admin）於 X 建立的 open 活動 `關閉報名` → 回 (H′)、**event 狀態不變、無 markProcessed、`users` 無新增 Y 列**。（驗證：unit test / G2、AC 對應「無 DB 變更」）
- [ ] **[D-006 AC-5]（非建立者非 super-admin 取消被拒，無 DB 變更）**：成員 Y `取消活動` → 回 (H′)、**event 狀態不變、無任何 DB 寫入**。（驗證：unit test / G2）
- [ ] **[D-006 AC-6]（super-admin 跨建立者取消，安全網）**：super-admin S（`line_user_id ∈ superAdminUserIds`、非該活動 host、S 於 `users` 甚至可無列）於他人建立的 active 活動 `取消活動` → `updateStatus(cancelled)`、回 **D-004 (F)** 取消回覆。（驗證：unit test / G2、G3、§0 安全網）
- [ ] **[D-006 AC-7]（super-admin 亦可關閉）**：super-admin S 於他人 open 活動 `關閉報名` → `updateStatus(closed)`、回 **D-004 (E)** 關閉回覆。（驗證：unit test / G2、G3）
- [ ] **[D-006 AC-8]（取消不刪 registrations）**：open 活動有若干 registrations（含 soft-delete 列），建立者或 super-admin `取消活動` → cancelled、**registrations 列數不變**、稽核欄保留。（驗證：unit/整合 test / G6、沿用 D-004 G10）
- [ ] **[D-006 AC-9]（我的ID 回覆）**：成員 `我的ID`/`我的id` → 回 **D-006 (MyID)** 含該傳訊人自身 `userId`、**不 mark、無 DB 副作用**。（驗證：unit test，handler+formatter / §3、FR-4）
- [ ] **[D-006 AC-10]（confirm/abort 不受授權影響）**：無流程時任一成員 `確認`/`取消` → 靜默 no-op（不回覆、不 mark）；有流程時由該流程擁有者自身推進（per-user PK），不因授權模型改變。（驗證：unit test / §4、承 D-004 §3.4）
- [ ] **[D-006 AC-11]（開團後 M2 報名銜接）**：任一成員開團 `確認` 建立 open 後，群內成員 `+2` → D-003 `signup` 正常（名單自主辦起算，含主辦 seat 1）。（驗證：整合 test / 與 D-003/D-005 銜接）
- [ ] **[D-006 AC-12]（canManageEvent 判定正確）**：對同一 open 活動，`canManageEvent` 對「建立者 line_user_id」回 true、「super-admin line_user_id」回 true、「其他成員 line_user_id」回 false；且 executor 解析走**唯讀** `getByLineUserId`（不 upsert）。（驗證：unit test / §1.2、G2）
- [ ] **[D-006 AC-13]（零 schema / 零 migration / 零新指令）**：無新增 migration 檔（`migrations/` 僅 0001/0002）、`schema.ts` 無新列型別、`ParsedCommand` 無新成員、無 `group_admins`/`group_settings` 表。（驗證：靜態審查/grep / G5）
- [ ] **[D-006 AC-14]（domain 不下 SQL、不觸 LINE、禁 any）**：`src/domain/{event-service,event-formatter}.ts` 內無 SQL 字串、無 `db.prepare`/`db.transaction` 直接呼叫、無 `@line/bot-sdk` import、無 `any`。（驗證：靜態審查/grep + 型別檢查 / G4）
- [ ] **[D-006 AC-15]（super-admin 注入、domain 不讀 env）**：`event-service.ts` 內無 `process.env`；super-admin 集合經 `superAdminUserIds` 注入。（驗證：grep / G3）

---

## 四、微 OP（附建議，交使用者裁決；預期很少）

- **OP-1（executor 解析：唯讀 `getByLineUserId` vs `upsert`）**：任務原措辭為「upsert executor 取 user.id + line_user_id 比對」，但 `upsert` 會為**未授權執行者**新增一列 `users`，違反 AC-4/5「無 DB 變更」。本設計改採**唯讀 `getByLineUserId`**（建立者恆有列、super-admin 走 env 不需列）。
  - 建議：**採唯讀**（滿足「非授權者無副作用」、更精簡）。請追認此對任務措辭的收斂。
- **OP-2（(H′) 確切文案）**：`關閉報名`/`取消活動` 非授權回覆。
  - 建議：「只有開團的人可以關閉報名／取消活動（或由系統管理員處理）。」（明示「開團的人」＝建立者，並提示可由系統管理員救援。）請確認字句。
- **OP-3（`我的ID` 群回 vs 私訊、是否加隱私提示）**：MVP 群回（`replyToken` 必達；push 私訊對未加 bot 好友者失敗）。
  - 建議：**群回**、(F) 附「可提供給系統管理員設定為 super-admin」說明；不加額外隱私遮罩（userId 非高敏、低洗版）。若使用者重隱私，可改私訊或群內提示改用私訊查。
- **OP-4（`formatMyId` 置放）**：放 `event-formatter.ts`（不新增檔案）vs 新增 `admin-formatter.ts`。
  - 建議：**放 `event-formatter.ts`**（最簡、不新增模組；本模型無其他 admin 訊息）。

---

## 五、跨文件協調點（回報 Orchestrator，不私改）

1. **D-004（APPROVED）授權 errata（本文件最關鍵協調點）**：生命週期授權由「env 白名單單軌」改為「開團全開 + close/cancel 限 `host_user_id` ∪ super-admin」。受影響章節：
   - **§1**（host 授權）：整段重寫——「誰能開團＝env 白名單」→「開團全開」；close/cancel 授權＝`host_user_id` ∪ super-admin。
   - **§5.2**：close/cancel 授權段「handler 先做白名單檢查」→「service 內 `canManageEvent`（進交易前判定）」；`no_active` early-return 時機前移註記。
   - **§7**：`EventServiceDeps.hostUserIds` → `superAdminUserIds`；`CreateEntryResult`/`InvalidOnelineResult` 移除 `not_authorized`；handler/server 表授權欄調整。
   - **§9 分派表**：`create_*` 授權欄「白名單」→「無」；`close/cancel` 授權欄「白名單」→「canManageEvent」。
   - **G1**（授權只認注入白名單）：重寫為模型 B（開團無授權；close/cancel＝host_user_id ∪ super-admin、非授權無副作用）。
   - **AC-10**（非白名單拒絕）：語意變更——`開團` 不再被拒（全開）；改為「非建立者非 super-admin `關閉/取消` 被拒、無 DB 變更」。
   - **訊息 (H)**：文案「只有主辦人可以開團／管理活動。」→ (H′)「只有開團的人（或系統管理員）可以關閉報名／取消活動。」
   - **（architect-reviewer 追加，必補）§9「去重政策」散文**：現載「生命週期指令…最終判定即使是拒絕（no_active…）仍消費 messageId」。模型 B 下 **close/cancel 的 `no_active` 前移至交易外 early-return、不再 mark** → §9 散文須同步改為「close/cancel 的 no_active 於交易前 early-return、不 mark」，否則 D-004 §9 分派表（已列）與散文自相矛盾。
   - **（architect-reviewer 追加）D-004 全文「白名單 host 開團」措辭**：§範圍內與 AC-1/2/3/6/11 等前提「白名單 host `開團…`」在開團全開下失真 → 加總括 errata「D-004 凡『白名單 host 開團』一律改為『任一群成員開團』」。
   - **（design-reviewer B3 追加）訊息 (I) 用詞統一**：D-004 (I)「（…請**主辦人**先輸入『取消活動』…）」與 (H′)「開團的人」指同一角色 → (I) 改「（如需另開新團，請**開團的人**先輸入『取消活動』結束目前活動。）」，避免使用者可見詞彙不一致。
   - **D-004 為 APPROVED，須走 errata 流程**（design-reviewer + architect-reviewer 追認）；由 Orchestrator 決定回寫 D-004 正文或以 D-006 §2 為權威。**回報，不私改 D-004。**
2. **D-002（APPROVED）**：**無新指令**。`my_id` 已存在於 `ParsedCommand` 且已解析，本文件僅 handler 接線。parser 零改動。僅供追認。
3. **D-005（APPROVED）**：**無影響**。`確認` 主辦自動登記（seat 1）依 `host_user_id`，來源/時機不變；split 結算不變。僅供追認。
4. **D-003（APPROVED）**：**無影響**。報名 override（`-N 名字`）認 `event.host_user_id` 不變；本模型將 `host_user_id` 擴為生命週期授權依據，與 override 授權一致但互不干涉。僅供追認。

---

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-07-31 | 作廢「群內管理人認領」方案，改採模型 B（開團人擁有 + super-admin 安全網） | 決策 #7 定案（使用者裁決）；D-006 整份改寫為授權簡化 |
| 2026-07-31 | D-006（模型 B）DRAFT 提交（backend） | 待 design-reviewer + architect-reviewer 雙審（R2）；OP-1~OP-4 待裁決；§五 D-004 授權 errata 待 Orchestrator 處置 |
| 2026-07-31 | OP-1~OP-4（技術/文案性質，orchestrator 採納 backend 建議） | OP-1 唯讀 `getByLineUserId`（不 upsert，避免為未授權者寫列）；OP-2 (H′) 文案採建議；OP-3 `我的ID` 群回不遮罩；OP-4 `formatMyId` 併入 event-formatter。皆為技術/文案預設，無需使用者裁決。 |

> **OP 全採建議、設計正文與模型 B 一致。** 送 R2 雙審（design-reviewer + architect-reviewer）；architect 需追認 D-004 授權 errata 清單（§五-1）。雙審通過即待使用者最終 APPROVED。

### R2 雙審結果（2026-07-31）
| reviewer | 結論 | 處置 |
|---|---|---|
| architect-reviewer | **建議 APPROVED（設計零 blocker）**，Guardrails 6/6 PASS | 授權時機/唯讀不 upsert/super-admin 救援皆驗證正確；不需 ADR。**D-004 errata 清單補 2 項**（§9 去重散文、全文「白名單 host 開團」措辭，已補入 §五-1）。緩解：super-admin 空時啟動警告（已入 §6）。nit：多行程 TOCTOU（MVP 不需，未來 PG 加 `active.id===active0.id` 防禦，記 backlog）。 |
| design-reviewer | **需修正 3 blocker → 已修** | B1 (F) 英文 super-admin → 繁中「系統管理員」+ 循環語意順化；B2 標籤 (F) 碰撞 → 我的ID 改 (MyID)、AC-2/3/6/7/9 標註引用來源；B3 (I) 主辦人→開團的人（已入 §五-1 errata）。nit N1 (H′) 句式順化已採。 |

> **兩 blocker 群已於設計正文補齊、architect 零 blocker。** 待使用者最終 APPROVED 即派 T-011。
> **APPROVED 後 orchestrator 分派 D-004 errata 批次**（§五-1 全項，含 architect 追加 2 項 + design B3）。LESSONS 待登記：拒絕回覆 mark 政策第 3 次（推進回寫）、跨文件部分改名致 user-facing 詞彙不一致。
