# D-003: 報名核心（Registration Core：+N / -N / 名單 + webhook 接線）

- 狀態：APPROVED（2026-07-31，architect-reviewer 通過 + nit-2/5 採納 + 使用者最終核可）
- 撰寫者：backend-engineer
- 關聯：Brief FR-1 報名機制 §29–32 / FR-2 名單查詢 §33 / FR-5 訊息規範 §36 / 決策紀錄 #1 整批候補、#2 FIFO 遞補、#4 代報名 §80–83 / 里程碑 M2 §74 / 成功條件 §8–14 / 關鍵使用者旅程 §87–91 ・ 任務 T-006 ・ 設計 D-003
- 相依：
  - **D-001（APPROVED）**：`registrations` per-slot schema、soft-delete、seq 語意，以及 repository 原語（`runImmediate`/`countConfirmed`/`listConfirmed`/`listWaitlist`/`findActiveByOwner`/`findActiveProxy`/`insertSlots`/`cancelByIds`/`pickWaitlistForPromotion`/`promoteByIds`…）。**本文件只組合這些原語，不重新設計 schema**；另需 D-001 資料層補一個新原語 `findActiveProxyByName`（見文末清單）。
  - **D-002（APPROVED）**：`ParsedCommand` union 是本文件的**輸入**；`parseCommand()` 已完成解析。**本文件消費解析結果，不重做解析、不重做正規化。**
- 風險等級：**R1（標準）**（使用者裁決 2026-07-23；併發防超賣已在 T-004 資料層測試覆蓋，本文件為組合層。Guardrails 保留 11 條，R1 不強制但保留無妨）。

---

## 一、設計內容

### 0. 定位與前提

D-003 實作 **M2 報名核心 domain 邏輯 + webhook 接線**：把 D-002 解析出的 `signup` / `cancel` / `list` 指令，透過 D-001 的 repository 原語轉成正取/候補/遞補的資料變更與繁體中文名單回覆。

**前提（M2 範圍界定）**：假設同群組**已存在一場 `status='open'` 的活動**（開團流程屬 M3 / D-004，本文件不做）。本文件只處理報名、取消、查詢三條路徑，以及其邊界（無 open 活動）。

- domain 只透過 repository 存取，**不直接下 SQL**（D-001 §9、本文件 G10）。
- 所有報名/取消/遞補寫入一律在 D-001 `RegistrationRepository.runImmediate`（BEGIN IMMEDIATE）交易內執行（防超賣 NFR-1；未在交易內時 repo 原語會自我守門拋例外）。
- 對使用者的 LINE 回覆一律繁體中文；只回應可識別且可執行的指令，`unknown` 一律不回覆（FR-5）。

**主辦人（host）身分認定（M2 最小化做法）**：M2 已假設存在一場 `status='open'` 活動，其 `events.host_user_id`（開團者）即為該活動主辦人。**授權判斷一律用 `executor.id === event.host_user_id`**。env host 白名單（決定「**誰能開團**」）屬 M3/M4，**M2 的主辦人 override 只認 `event.host_user_id`，不讀 env**。

**顯示名快照取得（群組情境；NFR-4）**：MVP 只在**群組**運作，取傳訊人/被代報者名下的 LINE 顯示名一律用 **`messagingApi.MessagingApiClient.getGroupMemberProfile(groupId, userId)`**，**不用 `getProfile(userId)`**——後者對「未加 bot 為好友」的成員會 404，使新使用者落入佔位，劣化名單品質。取名 fallback 順序見 §7 邊界表。（若 source 非群組——MVP 不預期——可退回 `getProfile` 或忽略該事件。）

### 1. 模組劃分（`src/domain/` 新增；`src/webhook/handler.ts` 改寫）

| 檔案 | 職責 | 依賴 | 被誰依賴 |
|---|---|---|---|
| `src/domain/registration-service.ts` | 報名核心 domain：`signup()` / `cancel()` / `getListView()`。組合 repository 原語完成額滿判斷、整批候補、FIFO 遞補、soft-delete、代取消授權、去重。**回傳結構化 domain 結果物件（非 LINE 訊息）**。嚴禁 `any` | db repositories（registration/event/user/processed）、schema 型別 | webhook handler |
| `src/domain/roster.ts` | **純函式**：把有效名單列（`RegistrationRow[]`）渲染為顯示名單——`名字`/`名字(2)` 後綴生成、整體序號。不觸 DB、不觸 LINE | schema 型別 | list-formatter、registration-service（如需） |
| `src/domain/list-formatter.ts` | **純函式**：把 domain 結果物件組版為繁體中文文字與 **mention 描述子**（LINE-agnostic：`{ text, mentionees: { index, length, lineUserId }[] }`）。活動摘要、名單列、剩餘名額、每人價格、預估總金額、候補序位、遞補通知文案 | roster、schema 型別 | webhook handler |
| `src/webhook/handler.ts`（改寫） | webhook 接線：從 LINE `WebhookEvent` 抽出 `groupId`/`userId`/`messageId`/`text` → `parseCommand` → 依 `type` 分派 → 以 `getGroupMemberProfile` 取名（async）→ 呼叫 service → 呼叫 formatter → 組出 `messagingApi.Message[]`（含 mention）。**LINE SDK 型別只在此層出現** | commands（parseCommand）、domain（service/formatter）、line client、db repositories | server.ts（`/webhook` 路由） |

> 分層理由：domain / formatter 對 LINE SDK 無耦合（可純測），handler 負責 LINE 事件形狀與 async I/O（profile fetch、reply）。

#### 1.1 domain 結果物件型別（設計說明用，非實作交付；嚴禁 `any`）

```ts
// registration-service 回傳型別（示意）
interface RegistrationView {
  event: EventRow;
  confirmed: RegistrationRow[];   // listConfirmed 結果（依 seq）
  waitlist: RegistrationRow[];    // listWaitlist 結果（依 seq）
  confirmedCount: number;         // = confirmed.length（= 有效正取數）
  available: number;              // = capacity - confirmedCount（>=0）
}

type SignupResult =
  | { kind: 'no_open_event' }
  | { kind: 'duplicate' }                                   // 冪等：重送已處理，靜默
  | { kind: 'ok'; outcome: 'confirmed' | 'waitlisted';
      requested: number; subjectDisplayName: string;       // errata(T-006)：被報名主體稱謂（自報名=傳訊人；代報名=輸入名字）；原草圖名 ownerDisplayName 與 owner_user_id 語意衝突，改此更精確
      newSlots: RegistrationRow[]; view: RegistrationView };

type CancelResult =
  | { kind: 'no_open_event' }
  | { kind: 'duplicate' }
  | { kind: 'nothing_to_cancel' }                           // 查無可取消（含非主辦人代取消他人）
  | { kind: 'ok'; cancelled: number; requested: number;
      subjectDisplayName: string;                          // errata(T-006)：同上，被取消主體稱謂
      promoted: RegistrationRow[];                          // 被遞補列（供 @ 通知）
      view: RegistrationView };

type ListResult =
  | { kind: 'no_open_event' }
  | { kind: 'duplicate' }                                   // errata(T-006)：§5 唯讀 list 重送 → 略過回覆之出口（草圖漏列，實作依 §5 補上）
  | { kind: 'ok'; view: RegistrationView };
```

### 2. `+N` 報名流程（`signup`）

輸入：`ParsedCommand`＝`{ type:'signup', count:N, proxyName? }`、`groupId`、傳訊人 `lineUserId`、`messageId`、以及**傳訊人顯示名稱**（handler 於呼叫前以 **`getGroupMemberProfile(groupId, userId)`** 取得快照，NFR-4；取名失敗 fallback 見 §7）。

**交易外前置（handler / service 前段）**：
1. `eventRepo.findActiveByGroup(groupId)` → 取當前 active 活動；**過濾 `status==='open'`**。非 open（無活動 / draft / closed / cancelled）→ 回 `no_open_event`（回覆「目前沒有開放報名的活動」）。
2. **取顯示名快照**：`displayName = getGroupMemberProfile(groupId, lineUserId).displayName`（群組成員 profile；失敗走 §7 fallback）。
3. `userRepo.upsert(lineUserId, displayName)` → 取得 `owner`（傳訊人 user 列；idempotent，交易外安全）。
4. 決定 slot 內容：
   - 自報名（無 `proxyName`）：`kind='self'`、`slotDisplayName = owner.display_name`（本次快照）。
   - 代報名（有 `proxyName`）：`kind='proxy'`、`slotDisplayName = proxyName`、`owner_user_id = owner.id`（定案 #4；D-001 §3）。

**交易內（`registrationRepo.runImmediate(() => { ... })`）——以下全部在同一 IMMEDIATE 交易，含去重）**：
1. `processedRepo.markProcessed(messageId)` → 回 `false`（重送）則**立即中止交易並回 `duplicate`**（原子回滾，見 §5 去重）。
2. `confirmed = registrationRepo.countConfirmed(event.id)`。
3. `available = event.capacity - confirmed`。
4. **整批決策（定案 #1，不部分接受）**：
   - `available >= N` → `status = 'confirmed'`（整批進正取）。
   - `available <  N` → `status = 'waitlist'`（**整批 N 位轉候補**；即使 `available>0` 也不部分接受）。
5. `newSlots = registrationRepo.insertSlots({ eventId: event.id, ownerUserId: owner.id, displayName: slotDisplayName, kind, status }, N)`（seq 於交易內指派）。
6. 交易回傳 `{ outcome, newSlots }`。

**交易後**：`view = { confirmed: listConfirmed(id), waitlist: listWaitlist(id), ... }` → formatter 組出回覆（活動摘要 + 完整名單 + 剩餘名額；候補時附候補序位）。

> 邊界：`countConfirmed`/`insertSlots`/`available` 皆走有效性過濾的 repo 原語（`cancelled_at IS NULL`），滿足 G6 / D-001 G10。`countConfirmed` 在 IMMEDIATE 交易內讀取，兩筆併發報名被序列化，第二筆重新計數看到已滿 → 整批候補，無超賣（AC-2）。

### 3. `-N` 取消流程（`cancel`）

輸入：`{ type:'cancel', count:N, proxyName? }`、`groupId`、傳訊人 `lineUserId`、`messageId`。

**交易外前置**：
1. 取 open 活動（同 §2 step 1）；非 open → `no_open_event`。
2. 取顯示名快照（`getGroupMemberProfile`，同 §2；供回覆稱謂與 users 快照更新）→ `userRepo.upsert(...)` → `executor`（傳訊人，亦即執行取消者）。
3. `isHost = (executor.id === event.host_user_id)`（本活動主辦人認定，見 §0）。

**定位待取消列（交易外查詢，交易內再取消）**：

- **自取消（無 `proxyName`）**：`rows = registrationRepo.findActiveByOwner(event.id, executor.id).filter(r => r.kind === 'self')`（**只取本人自報名列**；本人的代報名名額不受 `-N` 影響，需以 `-N 名字` 取消）。
- **代取消（有 `proxyName`）——依是否主辦人走單一路徑，避免歧義**：
  - **非主辦人**（`isHost === false`）：只走 **owner-scoped** `registrationRepo.findActiveProxy(event.id, executor.id, proxyName)`（僅本人代報列）。查無 → `nothing_to_cancel`（**不得取消他人代報名額**，G4）。
  - **主辦人**（`isHost === true`）：走**跨 owner** 新原語 `registrationRepo.findActiveProxyByName(event.id, proxyName)`（取**任一 owner** 代報的該名字有效列，含主辦人自己代報的列）。
  - **優先順序與合併規則（消歧）**：主辦人**一律只走** `findActiveProxyByName`（其結果已涵蓋主辦人自己代報的列），**不再與 owner-scoped 結果合併** → 單一列來源，無重複、無「主辦人同時是代報者」的歧義；非主辦人一律只走 `findActiveProxy`。

**權限檢查（本層明確判定，對接 G4）**：
- 自取消：executor 取消自己 self 名額，恆允許。
- 代取消：
  - 非主辦人 → 只能取消**自己**代報的名額（owner-scoped 定位天然保證）；查無他人代報名額即拒（`nothing_to_cancel`）。
  - 主辦人 → 得代取消**任一** owner 代報的該名字名額（`findActiveProxyByName` 跨 owner 定位）。

**取消順序（定案：先候補、後正取；各組內高 seq 先取消）**：
- 對定位到的 `rows`（不論自取消 / 本人代取消 / 主辦跨 owner 代取消），一律：分為 `waitlist` 與 `confirmed` 兩組；每組內依 `seq` **由大到小**排序。
- 串接 `ordered = [...waitlistDesc, ...confirmedDesc]`；取前 `min(N, rows.length)` 列為 `toCancel`。
- **多筆同名歧義（主辦人代取消）**：不同 owner 各代報一個「陳大哥」時，主辦人 `-1 陳大哥` 依上述同一順序（先候補後正取、組內高 seq 先）取 `min(N, 筆數)` 列——即**優先取消最新（高 seq）者**，與整體取消順序一致，定義明確。
- 理由見 §四取捨；效果：混合持有「正取 + 候補」時，`-N` 優先退未定案候補、保留正取；高 seq 先退使顯示上先消失 `名字(N)`（保留 `名字`、`名字(2)`）。

**交易內（`runImmediate`）**：
1. `processedRepo.markProcessed(messageId)` → `false` → 中止回 `duplicate`。
2. `{ cancelled, freedConfirmed } = registrationRepo.cancelByIds(toCancel.map(r=>r.id), executor.id)`（soft-delete：設 `cancelled_at` / `cancelled_by_user_id = executor.id`；主辦人代取消時稽核欄記主辦人，對接 D-001 AC-12；G3 禁硬 DELETE）。
3. `freedConfirmed`＝**本次鎖內實際取消且原 `status='confirmed'` 的列數**（由 `cancelByIds` 的 `RETURNING status` 於同一 FOR UPDATE 交易內得出；本次實際釋出的正取名額數，不分自取消或主辦代取消）。**不得**以交易外快照 `toCancel.filter(...)` 推導（B1 errata，見文末「已定案／errata」）。
4. **FIFO 遞補（定案 #2；B2 errata 修正額度算法）**：取消後於**同一鎖內**重算可用名額
   `promotionQuota = fresh.capacity − registrationRepo.countConfirmed(event.id)`（`fresh` 為鎖內重讀的 event 列，`countConfirmed` 已含本次 soft-delete 結果）。若 `promotionQuota > 0`：
   - `picks = registrationRepo.pickWaitlistForPromotion(event.id, promotionQuota)`（有效候補中最小 seq 起，至多 `promotionQuota` 列；已取消列自動排除）。
   - **不得**以 `freedConfirmed`（本次釋出正取數）當額度（B2 errata）：G1「整批候補」會留下**擱置空位**（如 capacity=10、confirmed=9 時 `+2` 整批候補，該 1 位無人可用），`freedConfirmed` 只看「本次釋出量」而看不到既有擱置空位，導致空位永久無法回收。以「當下剩餘名額」為額度即同時回收本次釋出與既有擱置空位。
   - 同理**觸發條件**由 `freedConfirmed > 0` 放寬為 `promotionQuota > 0`：取消**候補列**亦可能讓擱置空位重新塞得下隊首（如上例候補批由 2 縮為 1），此時應遞補。`promotionQuota` 以容量為上界，故仍不超賣。
   - `const promotedN = registrationRepo.promoteByIds(picks.map(r=>r.id))`（waitlist→confirmed，seq 不變；G8）。
   - **防禦性斷言（nit-5 採納）**：同步 IMMEDIATE 交易內 `promotedN` 應恆等於 `picks.length`（picks 皆為剛選出的有效 waitlist 列，無競態）；若 `promotedN !== picks.length` 記錄異常（log error，屬不預期狀態），並以實際遞補列 `getById` 回讀為準，避免通知與資料不一致。
   - `promoted = picks`（供 @ 通知）。
5. 交易回傳 `{ cancelled, promoted }`。

**遞補數守恆（G8；B2 errata）**：遞補列數 ≤ `promotionQuota = capacity − 鎖內有效正取數`，故最終有效正取數永不超過 `capacity`（不超賣）。**主辦人代取消 confirmed 代報名額同樣觸發 FIFO 遞補**（與自取消一致）。

> B2 errata 前後差異：舊版以 `freedConfirmed` 為額度且僅在其 `> 0` 時遞補，會讓 G1 整批候補產生的擱置空位永久無法回收（回報情境：capacity=10、confirmed=9、`+2 陳先生` 整批候補 → 某人 `-1` 後只遞補 1 位，仍空 1 位）。新版額度為「當下剩餘名額」，該情境兩列一併遞補。原「被取消的候補列不觸發遞補」的敘述隨之收斂為：**取消候補列不新增名額，但若當下仍有剩餘名額且候補隊首塞得下，仍會遞補**；正取滿（`promotionQuota = 0`）時行為與舊版一致（AC-5 不受影響）。

**已知限制（拆批，記 Backlog）**：`pickWaitlistForPromotion` 以列為單位 `LIMIT`，當 `promotionQuota` < 候補隊首批次人數時會**拆散整批**（如剩 1 位、隊首為 `+2` → 1 列遞補為正取、1 列留候補），與 G1 進場時的整批原子性不對稱。使用者裁決（2026-08-02）：**本次先允許拆批**，整批原子遞補列為後續優化（需新增 `batch_id` 欄位，屬 migration ⇒ R2）。

**交易後**：重查 `view` → formatter 組出：取消結果 + 更新後名單 + 剩餘名額；若 `promoted.length>0` 追加**遞補通知訊息**（§4）。

**邊界**：
- `rows.length === 0`（本人無可取消名額 / 非主辦人代取消他人查無 / 代取消查無該名字）→ `nothing_to_cancel`（回「您目前沒有可取消的名額」或「查無您代報的『名字』名額可取消」）。
- `N > rows.length`（超過可取消數）→ 取消全部 `rows`（`min` 效果），正常回覆（不報錯）；即「歸零移出」（旅程 #3）。

### 4. 遞補通知（@ mention）

被遞補者以 LINE **mention（@）** 於群組標註（定案 #2）。

**技術做法**（LINE Messaging API 文字訊息 mention）：
- 目標 userId = **被遞補列 owner 的 `line_user_id`**：`userRepo.getById(row.owner_user_id).line_user_id`。
  - 自報名列（`kind='self'`）：mention 該報名者本人。
  - 代報名列（`kind='proxy'`）：`display_name` 是非 LINE 名字（如「陳大哥」），無 line_user_id；改 **mention 代報者本人**（owner 是真實 LINE 用戶），文案標明「（由 @代報者 代報）」。
- **顯示文字與 userId 來源**：被 @ 的**顯示文字**取自 registration 快照 `display_name`（自報名列）或代報者的 `users.display_name`（proxy 列的代報者稱謂）——皆為**已存快照**，非即時再打 profile；mention 的 **userId** 取自 `users.line_user_id`（`userRepo.getById(owner_user_id)`）。故 §4 不另呼叫 `getGroupMemberProfile`（名字在報名當下已由 §2 取得並存入 users/registrations）。
- formatter 產出 LINE-agnostic 描述子：文字字串 + `mentionees: { index, length, lineUserId }[]`（index/length 為 mention 顯示文字在字串中的位置）；handler 轉為 LINE 訊息。
  - **errata(T-006)**：安裝的 `@line/bot-sdk@^9.5.0` 之 `messagingApi.TextMessage` 已無 `mention.mentionees` 欄位，mention 改由 **`TextMessageV2` + `substitution` placeholder** 表達。故 handler 依描述子的 index/length 切出 mention 子字串換成 `{mN}` placeholder，組出 `TextMessageV2`。**formatter 仍維持 LINE-agnostic 描述子不變**（分層原則不破壞，轉換僅在 handler 唯一觸 LINE 型別處）；architect-reviewer 判定可接受、不需 ADR。
- 遞補通知作為 **reply 的追加訊息**（reply 至群組，mention 於群組內生效；reply 最多 5 則），不另發 push。

**Fallback（技術不可行時）**：
- 若 `owner.line_user_id` 取不到（理論上不會，owner 必為既存 user），或 mention 組裝失敗 → 退化為**純文字** `@名字`（不可點按），仍發送通知。
- handler 對 `replyMessage` 失敗以 `try/catch` 記錄（沿用現有骨架），不影響 DB 已完成的遞補（遞補是交易內結果，通知失敗不回滾）。

### 5. 併發與冪等（在流程哪一步去重）

- **去重位置**：對**有副作用**的指令（`signup` / `cancel`），`processedRepo.markProcessed(messageId)` 作為 `runImmediate` 交易內的**第一步**；回 `false`（重送）即中止交易 → 去重標記與報名/取消寫入**在同一 IMMEDIATE 交易內原子成敗**。好處：LINE 重送或處理中途崩潰時，交易回滾使「標記 + 副作用」一致，重送可乾淨重放（exactly-once 副作用）。
- **唯讀指令**（`list`）：`markProcessed` 於查詢前呼叫（交易外）；重送 → 略過回覆（避免重複貼名單）。唯讀無資料副作用，故不需與交易綁定。
- **防超賣**：`countConfirmed` → 整批決策 → `insertSlots` 全在同一 `runImmediate`（IMMEDIATE 鎖序列化寫入，ADR-002 / D-001 G2）。取消/遞補同受此交易語意保護。
- `messageId` 來源＝LINE `message.id`（僅訊息事件有；非訊息事件本文件不處理）。

### 6. webhook 分派表（`src/webhook/handler.ts` 改寫）

從 `WebhookEvent` 取 `event.type==='message' && event.message.type==='text'` 才進入；抽 `text=event.message.text`、`messageId=event.message.id`、`userId=event.source.userId`、`groupId=event.source.groupId`（群組情境）。`text` → `parseCommand`。

| `ParsedCommand.type` | M2 handler | 回覆 | 去重 |
|---|---|---|---|
| `signup` | `registrationService.signup` | 報名結果 + 活動摘要 + 完整名單 + 剩餘名額（候補時附候補序位） | 交易內 markProcessed |
| `cancel` | `registrationService.cancel` | 取消結果 + 更新名單 + 剩餘名額（+ 遞補 @ 通知） | 交易內 markProcessed |
| `list` | `registrationService.getListView` | 活動摘要 + 依序名單 + 每人價格 + 預估總金額 | 查詢前 markProcessed |
| `create_event_oneline` / `create_event_start` / `confirm` / `abort` / `close_event` / `cancel_event` | （D-004 / M3） | **M2 no-op（不回覆）** | 不 mark |
| `my_id` | （M4） | **M2 no-op（不回覆）** | 不 mark |
| `invalid` | 回覆政策（見下） | signup/cancel 類→**靜默**；create_event 類→格式提示（M3 實作，M2 no-op） | 不 mark |
| `unknown` | — | **不回覆**（FR-5、成功條件 #5） | 不 mark |

- **`switch` 對 union 窮舉**（含 `default: never` 檢查），沿用 D-002 G7，新增指令型別時編譯期報錯。
- **非 text 事件 / 非群組來源**：一律忽略（沿用現行骨架「其餘不回覆」）。
  - **澄清註記（errata 2026-08-28，來源 D-018 §1.2）**：本條自此僅適用於 **message 類**事件。
    群組來源的 `join`／`leave` 事件改為**進入 handler 但只寫 `groups` 觀測資料**——
    仍**不回覆、不 `markProcessed`**（屬 CLAUDE.md §4 去重政策「本來就不回覆」的例外路徑），
    故對使用者可見行為零改變。非群組來源（1:1／room）的 join/leave 維持完全忽略。

**`invalid` 回覆政策（本文件定案，D-002 §6 留白）**：
- `invalid(command='create_event', ...)` → **回覆格式提示**（範例：`格式：開團 <日期> <時間> <地點> <人數> <價格>，例：開團 2026/08/15 07:30 東方球場 16人 2200元`）。開團是明確指令嘗試，值得引導。**此為 M3 開團流程實作；M2 不實作 create，故 M2 對此型別 no-op**，政策先行定案供 M3 沿用。
- `invalid(command='signup'|'cancel', reason='count_out_of_range')`（如 `+99`）→ **靜默不回覆**。理由：超量多為誤植/玩笑，回覆會招致洗版；brief 以防洗版為優先（FR-5）。此為 M2 範圍內、即刻生效的政策（AC-15）。

### 7. 邊界與錯誤彙整

| 情境 | 行為 |
|---|---|
| 無 open 活動（`signup`/`cancel`/`list`） | 回「目前沒有開放報名的活動」（統一定型句，涵蓋無活動 / draft / closed / cancelled；OP-4 裁決：僅 open 可操作） |
| `+N` 名額不足（含 `available>0` 但 `<N`） | **整批 N 位轉候補**（不部分接受），回覆已排候補 + 候補序位 |
| `-N` 本人持有數為 0 | 回「您目前沒有可取消的名額」 |
| `-N` 超過本人持有數 | 取消全部持有（`min`），正常回覆（歸零移出） |
| `-N 名字` 非主辦人代取消他人代報名額 | 拒絕：`findActiveProxy` owner-scoped 查無 → 回「查無您代報的『{名字}』名額可取消」（G4） |
| `-N 名字` 主辦人代取消他人代報名額 | **M2 範圍內**：`findActiveProxyByName` 跨 owner 定位 → soft-delete，`cancelled_by_user_id=主辦人`；若為 confirmed 則觸發 FIFO 遞補 |
| 群組取顯示名（`getGroupMemberProfile(groupId, userId)`）失敗 | fallback 順序：① 既有 `users.display_name`（若該 user 曾互動過有快照）→ ② 皆無則以「使用者」佔位。**不阻斷報名/取消**。（用群組成員 profile 而非 `getProfile`，避免未加 bot 好友者 404 劣化 AC-1／NFR-4 快照品質） |
| `replyMessage` / mention 失敗 | try/catch 記 log，不回滾已完成的 DB 變更 |
| 重送（相同 `message_id`） | 交易內 markProcessed 回 false → 中止、不重複報名/取消、不重複回覆 |

### 8. 名單訊息範本（純文字，繁體中文；以旅程 #1 資料舉例）

活動：`2026-08-15 07:30`、`東方球場`、`capacity=16`、`每人 2200 元`。傳訊人顯示名稱「王小明」。

**(A) 報名成功（正取）——`+3`（空場）**
```
[東方球場 球聚報名]
日期：2026-08-15 07:30
地點：東方球場
每人費用：2200 元

已為「王小明」報名 3 位（正取）。

報名名單（3/16）：
1. 王小明
2. 王小明(2)
3. 王小明(3)

剩餘名額：13
```

**(B) 整批轉候補——名額不足時 `+2`（正取已滿 16）**
```
[東方球場 球聚報名]
日期：2026-08-15 07:30
地點：東方球場
每人費用：2200 元

正取名額已滿，已將「王小明」的 2 位整批排入候補。
候補序位：第 1、2 位

報名名單（16/16）：
（16 位正取…）

候補名單：
1. 王小明
2. 王小明(2)

剩餘名額：0
```

**(C) 取消——`-1`（王小明由 3 位取消 1 位）**
```
[東方球場 球聚報名]
日期：2026-08-15 07:30
地點：東方球場
每人費用：2200 元

已為「王小明」取消 1 位。

報名名單（2/16）：
1. 王小明
2. 王小明(2)

剩餘名額：14
```

**(D) 取消觸發遞補——追加遞補通知訊息（第 2 則，含 @ mention）**
自報名被遞補：
```
名額釋出，恭喜由候補遞補為正取：
@王小明
```
代報名被遞補（陳大哥 由 李大華 代報）：
```
名額釋出，恭喜由候補遞補為正取：
陳大哥（由 @李大華 代報）
```
（`@王小明` / `@李大華` 為 LINE mention，tap 可跳轉；fallback 為純文字。）

**(E) 名單查詢——`名單` / `list`**
```
[東方球場 球聚]
日期：2026-08-15 07:30
地點：東方球場
每人費用：2200 元

報名名單（3/16）：
1. 王小明
2. 王小明(2)
3. 王小明(3)

剩餘名額：13
預估總金額：3 × 2200 = 6600 元
```
（若有有效候補，於名單後附「候補名單」段落（OP-3 裁決：保留顯示候補）；預估總金額 = **有效正取數 × 每人費用**，不計候補。）

**(F) 無 open 活動**
```
目前沒有開放報名的活動
```

### 9. `名字(2)` 後綴生成規則（`src/domain/roster.ts`，對接 D-001 §3「應用層渲染」）

- 輸入：有效名單列（依 `seq` 排序，如 `listConfirmed` / `listWaitlist` 之輸出）。
- 演算法（純函式）：逐列走訪，以 **`(owner_user_id, display_name)`** 為分組鍵維護出現次數：
  - 第 1 次出現 → 顯示 `display_name`。
  - 第 k(≥2) 次出現 → 顯示 `display_name(k)`。
- **整體序號**（`1.`、`2.`…）依有效列 `seq` 排序後 1-based 給定，與後綴分組獨立。
- 分組鍵含 `owner_user_id`（依 D-001 §3）：故同一人多名額才加後綴；**兩位不同 LINE 用戶恰好同顯示名，各自不加後綴**（後綴用於消歧「同一人的多個名額」）。代報名同一 owner 同名多列亦依此加後綴（如同一人 `+2 陳大哥` → `陳大哥`、`陳大哥(2)`）。
- 正取名單與候補名單**各自獨立**編號與後綴計數（兩段分開渲染）。

### 範圍內
- `+N` 報名：open 活動判定、`available = capacity − 有效正取數`、整批全進/整批候補（定案 #1，不部分接受）、代報名 `+N 名字`（`kind='proxy'`）、成功回覆（活動摘要 + 完整名單 + 剩餘名額 + 候補序位）。
- `-N` 取消：soft-delete、取消順序（先候補後正取、組內高 seq 先）、釋出正取觸發 FIFO 遞補（定案 #2）、代報名取消 `-N 名字`、**主辦人（`executor.id===event.host_user_id`）代取消任一 owner 的代報名額**（OP-2 裁決；跨 owner 定位）、遞補 @ mention 通知（含 fallback）。
- `名單` / `list`：活動資訊 + 依序名單（序號 + `名字(2)` 後綴）+ 已報名/上限 + 每人價格 + 預估總金額 + 有候補時附候補名單；無活動定型句。
- 併發（`runImmediate` 序列化防超賣）與冪等（`processed_events` 去重，交易內綁定）。
- 名單訊息組版（純文字繁中）與 `名字(2)` 後綴規則。
- webhook 接線：`parseCommand` → 分派表；群組取名用 `getGroupMemberProfile`；`unknown` 不回覆；`invalid` 回覆政策。

### 範圍外（留給後續設計，明確不做）
- **開團流程**（D-004 / M3）：`開團`（一行式/逐步問答）、`確認`/`取消`/`關閉報名`/`取消活動`、event 狀態轉移、**env host 白名單（決定誰能開團）**。本文件假設已有 `status='open'` 活動，主辦人只認該活動的 `host_user_id`。
- `create_*` / `confirm` / `abort` / `close_event` / `cancel_event` / `my_id` 的實際處理（M2 一律 no-op）。
- `我的ID`、**env host 白名單管理**（M4）。
- 跨群同時多場活動（定案 #3，MVP 限一場）。
- capacity 縮容降級（`confirmed→waitlist`）、球組編排、收款統計（v2）。
- `+N 名字` 於 N>1 的代報名語意細節超出「同 owner 同名加後綴」者（沿用 §9 規則；不另設計）。

---

## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）

- **G1（不部分接受）**：不得對 `+N` 部分接受；`available >= N` 時整批 `confirmed`，否則**整批 N 位 `waitlist`**（即使 `0 < available < N` 亦整批候補）。（定案 #1）
- **G2（交易邊界）**：不得在 `RegistrationRepository.runImmediate` 交易外進行任何 `registrations` 的插入/取消/遞補寫入（防超賣，D-001 G2；repo 原語會守門，設計亦不得繞過）。
- **G3（禁硬刪）**：不得對 `registrations` 直接 `DELETE`；取消一律經 `cancelByIds` soft-delete（沿用 D-001 G9）。
- **G4（代取消權限）**：**非主辦人不得取消他人代報名額**（只能取消自己代報的，一律以 owner-scoped `findActiveProxy(event.id, executor.id, name)` 定位，查無即拒）；**主辦人（`executor.id === event.host_user_id`）得代取消任一 owner 代報的該名字名額**（以跨 owner `findActiveProxyByName` 定位），且一律以 `cancelled_by_user_id` 記錄執行者（主辦人）。不得以其他方式繞過 owner-scoped 讓非主辦人取消他人名額。
- **G5（不回 unknown）**：`unknown` 一律不觸發任何回覆或 markProcessed（FR-5 防洗版）；handler 對 `unknown` 回空訊息陣列。
- **G6（有效性過濾）**：名單顯示、正取計數、`available`、遞補選取、`-N` 定位一律經**帶 `cancelled_at IS NULL`** 的 repo 原語（`countConfirmed`/`listConfirmed`/`listWaitlist`/`findActiveByOwner`/`findActiveProxy`/`findActiveProxyByName`/`pickWaitlistForPromotion`）；不得自行拼 SQL 或以含已取消列的集合計數/顯示。（D-001 G10）
- **G7（去重持久化）**：有副作用指令（signup/cancel）不得在未經 `processedRepo.markProcessed`（且與副作用同交易）下寫入；不得僅靠記憶體去重。（NFR-2、D-001 G6）
- **G8（遞補守恆／FIFO；B2 errata 修訂）**：遞補數不得超過**鎖內重算的剩餘名額** `promotionQuota = capacity − 有效正取數`（**不得**改用 `freedConfirmed`＝本次釋出數，該值看不到 G1 整批候補留下的擱置空位）；`capacity` 與正取數皆須於同一 `runImmediate` 交易內取得（`fresh.capacity` / `countConfirmed`），不得用交易外快照。遞補一律 `pickWaitlistForPromotion`（最小 seq 有效候補優先）→ `promoteByIds`，不得跳序或超額致有效正取數 > `capacity`。
- **G9（快照不回溯）**：不得修改既有 `registrations.display_name`；代報名 `owner_user_id` 一律為傳訊人 user.id，`display_name` 為輸入名字（沿用 D-001 G5、定案 #4）。
- **G10（不直接下 SQL）**：`src/domain/` 不得出現任何 SQL 字串或直接存取 `db`；一律透過 repository 原語（D-001 §9）。
- **G11（禁 any）**：`src/domain/` 與改寫後 `handler.ts` 不得使用 `any`；domain 結果與 mention 描述子皆具名定型。

---

## 三、Acceptance Checks（每條可轉測試；條件 → 預期 → 驗證方式）

- [ ] **AC-1（+N 名單與後綴）**：空 open 活動（capacity=16），王小明 `+3` → 產生 3 列 `confirmed`；名單顯示 `1. 王小明 / 2. 王小明(2) / 3. 王小明(3)`，剩餘名額 13。（驗證：unit test，registration-service + roster / 成功條件 #1、旅程 #1）
- [ ] **AC-2（併發不超賣，outcome-based）**：capacity 使有效正取剩 1，兩筆 `+1` 相繼進入 `signup` → 結束後有效正取數 ≤ capacity；一筆 `confirmed`、另一筆整批 `waitlist`；無兩列同時有效 confirmed 超出容量。（驗證：outcome-based unit/整合測試，序列化交易 / 成功條件 #2、旅程 #2）
- [ ] **AC-3（不部分接受）**：`available=1`，某人 `+2` → 產生 2 列**皆 `waitlist`**（非 1 confirmed + 1 waitlist），回覆為整批候補 + 候補序位。（驗證：unit test / 定案 #1、G1）
- [ ] **AC-4（取消觸發最小 seq 遞補）**：正取滿 + 有有效候補，某人 `-1`（取消 1 正取）→ 釋出 1 名額，**最小 seq 的有效候補列**被 `promoteByIds`（seq 不變）為 confirmed；已取消候補不被遞補；回覆含遞補通知。（驗證：unit test / 定案 #2、G8）
- [ ] **AC-5（取消順序：先候補後正取）**：某 owner 持有 2 confirmed + 1 waitlist，`-1` → 被取消的是其 **waitlist** 列（高 seq 先），confirmed 計數不變、**不觸發遞補**。（驗證：unit test / §3 定案、取捨）
- [ ] **AC-6（代報名報名）**：王小明 `+1 陳大哥` → 產生 1 列 `kind='proxy'`、`display_name='陳大哥'`、`owner_user_id=王小明.id`；名單顯示「陳大哥」。（驗證：unit test / 定案 #4、對接 D-001 AC-5）
- [ ] **AC-7（非主辦人代取消權限）**：王小明 `-1 陳大哥`（本人代報）→ 該 proxy 列 soft-delete；**非主辦成員 B**（`B.id !== event.host_user_id`）`-1 陳大哥`（王小明代報的名額）→ `findActiveProxy(B.id,...)` owner-scoped 回 0 列 → 拒絕（`nothing_to_cancel`）、不取消。（驗證：unit test / G4、定案 #4）
- [ ] **AC-8（名單格式）**：3 位正取、每人 2200 → `名單` 回覆含依序名單（序號 + 後綴）、`（3/16）`、`剩餘名額：13`、`預估總金額：3 × 2200 = 6600 元`。（驗證：unit test，list-formatter / FR-2、OP-3）
- [ ] **AC-9（無 open 活動）**：無 status='open' 活動時（含 closed），`+1` / `-1` / `名單` → 皆回「目前沒有開放報名的活動」。（驗證：unit test / FR-2 定型句、§7、OP-4）
- [ ] **AC-10（unknown 不回覆）**：`parseCommand` 回 `unknown`（如閒聊）→ handler 回空訊息陣列、不呼叫 replyMessage、不 markProcessed。（驗證：unit test，handler + mock client / FR-5、成功條件 #5、G5）
- [ ] **AC-11（冪等去重）**：相同 `message_id` 的 `+1` 連續處理兩次 → 第二次交易內 markProcessed 回 false 中止 → 只產生 1 列有效 registration、只回覆一次。（驗證：unit/整合測試 / NFR-2、G7）
- [ ] **AC-12（超取消 / 無可取消）**：owner 持 2 self，`-5` → 取消該 2 列（歸零移出、正常回覆）；owner 持 0，`-1` → 回「您目前沒有可取消的名額」。（驗證：unit test / §7、旅程 #3）
- [ ] **AC-13（後綴分組鍵）**：同一 owner 同名多列 → `名字`/`名字(2)`/`名字(3)`；**兩位不同 owner 同顯示名** → 各自不加後綴（皆顯示原名）。（驗證：unit test，roster / D-001 §3、§9）
- [ ] **AC-14（遞補 @ mention）**：取消釋出名額後，遞補通知 mention 描述子含被遞補列 owner 的 `line_user_id`；代報名列被遞補時 mention 代報者、文案標「（由 @代報者 代報）」；owner line_user_id 取不到時退化純文字 `@名字`。（驗證：unit test，list-formatter + handler / 定案 #2、§4）
- [ ] **AC-15（invalid 回覆政策）**：`+99`（`invalid(signup,count_out_of_range)`）→ handler 靜默不回覆；`create_event` 類 invalid 的政策為回格式提示（M3 實作，M2 no-op 不回覆）。（驗證：unit test，handler / §6）
- [ ] **AC-16（domain 不直接下 SQL）**：`src/domain/*.ts` 內無 SQL 字串、無 `db.prepare`/`db.transaction` 直接呼叫；所有存取經 repository。（驗證：靜態審查 / grep，G10）
- [ ] **AC-17（主辦人代取消他人代報名額）**：主辦人（`executor.id === event.host_user_id`）`-1 陳大哥`，其中「陳大哥」由**成員 A（A.id ≠ host）** 代報 → 以 `findActiveProxyByName` 跨 owner 定位該列 → soft-delete，`cancelled_by_user_id = 主辦人`；若該列為 `confirmed`，釋出名額後**觸發 FIFO 遞補**（與自取消一致，最小 seq 有效候補遞補）。（驗證：unit test / OP-2 裁決、定案 #4、G4、G8）
- [ ] **AC-18（主辦代取消多筆同名歧義）**：不同 owner 各代報一個「陳大哥」（共 2 列，seq 不同），主辦人 `-1 陳大哥` → 依「先候補後正取、組內高 seq 先」取 1 列（即較新者）soft-delete；另一「陳大哥」保留。（驗證：unit test / §3 多筆同名定案）
- [ ] **AC-19（群組取名，非 getProfile）**：新成員（未加 bot 好友）`+1` → handler 以 `getGroupMemberProfile(groupId, userId)` 取得其群組顯示名並存為快照（非 `getProfile` 而落入「使用者」佔位）；取名失敗時 fallback 既有 `users.display_name`→「使用者」。（驗證：unit test，handler + mock client / NFR-4、nit-2、§7）
- [ ] **AC-20（cancel 遞補不超賣：鎖內釋出數）**：capacity=2、confirmed=[r1,r2]、waitlist=[w1,w2]，兩則不同 messageId 的 cancel 於交易外皆定位到同一正取列 r2，各自 FOR UPDATE 交易（真並行）→ 序列化後第二者 `cancelByIds` 實取 0、`freedConfirmed=0` 不遞補；最終有效正取數 ≤ capacity（=2，非 3），只實際釋出的 1 個正取對應遞補 1 筆候補。（驗證：PG 真並行整合測試，d007-postgres / B1 errata、G8、ADR-002）
- [ ] **AC-21（遞補額度＝剩餘名額，回收擱置空位）**：capacity=10、confirmed=9、某人 `+2 陳先生` → 整批候補（正取仍 9，空 1 位）；此時任一正取者 `-1` → 鎖內 `promotionQuota = 10 − 8 = 2`，**兩列陳先生一併遞補**為 confirmed（有效正取 = 10、候補清空、遞補通知含 2 人），非只遞補 1 列。另：`promotionQuota` 上界為容量 → 遞補後有效正取數 ≤ capacity（不超賣）；正取已滿時（`promotionQuota = 0`）取消候補列不觸發遞補（與 AC-5 一致）。（驗證：unit test，registration-service / B2 errata、G8、定案 #2）

---

## 四、關鍵取捨與裁決

### 已定案（取捨說明）
- **取消順序＝先候補後正取（組內高 seq 先）**：使用者持混合名額 `-N` 時保留已定案的正取、先退未定案候補，符合「縮減同行人數」直覺，避免不必要地釋出正取名額觸發他人遞補又反覆變動名單。主辦人跨 owner 代取消多筆同名時沿用同順序（取較新者），定義明確。
- **`invalid` 回覆政策**：create_event 類回格式提示（值得引導）；signup/cancel 類（`+99`）靜默（防洗版）。
- **去重與副作用同交易**：markProcessed 置於 `runImmediate` 內第一步，換取崩潰/重送下的 exactly-once。代價：唯讀 list 另走交易外 markProcessed（可接受）。
- **@ mention 可行性**：LINE 文字訊息支援 `mention.mentionees`（`type:'user', userId`），M2 採用；被 mention 者需為群組成員（報名者/代報者本即群成員，成立）。代報名 mention 代報者本人 + 文案標名字。fallback 純文字。
- **主辦人身分認定（最小化）**：M2 主辦人 = 該 open 活動的 `event.host_user_id`；不讀 env 白名單（env 白名單決定「誰能開團」，屬 M3/M4）。
- **群組取名用 `getGroupMemberProfile`（nit-2）**：群組情境一律以 `getGroupMemberProfile(groupId, userId)` 取顯示名快照，非 `getProfile`——後者對未加 bot 好友的成員 404，會使新使用者落入佔位、劣化 AC-1／NFR-4。fallback：`users.display_name`→「使用者」佔位，不阻斷報名。
- **遞補列數防禦性斷言（nit-5）**：採納。§3 交易內以 `promotedN === picks.length` 斷言（同步交易內恆相等）；不等則記異常並以回讀為準，避免通知/資料不一致。
- **B1 errata（cancel 遞補超賣競態，2026-08-01，T-012）**：cancel 的 `freedConfirmed` 必須於 FOR UPDATE 交易內由 `cancelByIds` 之 `RETURNING status`（本次實際取消的 confirmed 列數）得出，**非**交易外快照 `toCancel.filter(r=>r.status==='confirmed').length`。起因：D-007 sync→async 移植（T-012）在「交易外定位 candidates／toCancel」與「交易內 runImmediate」之間引入 await 讓點；當同一列被兩則不同 messageId 的 cancel 鎖定（同人雙擊、或主辦跨 owner 代取消 + owner 自取消同名）時，`cancelByIds` 的 `AND cancelled_at IS NULL` 守衛使第二者實取 0，但陳舊快照仍計 `freedConfirmed=1` → 多遞補 1 個候補 → 有效正取數 > capacity（超賣，破 G8 / ADR-002）。SQLite 同步版無此窗（定位＋runImmediate 單執行緒原子），故 T-006 nit-2（交易外快照）當時安全；async 化後激活，本次修正。回歸測試：`[D-003 AC-20]`（PG 真並行）。

### 開放問題裁決留痕（2026-07-23，使用者裁決）
- **OP-1（風險等級）→ R1（標準）**：併發防超賣已於 T-004 資料層測試覆蓋，本文件為組合層。（原 backend 建議 R2，使用者定 R1；Guardrails 保留 11 條無妨。）
- **OP-2（主辦人代取消他人代報名額）→ 納入 M2**：host = `event.host_user_id`；新增跨 owner 定位原語 `findActiveProxyByName`。已落實於 §3 定位/權限、G4、AC-17/AC-18、§7 邊界、範圍內。
- **OP-3（名單是否顯示候補）→ 顯示**：`名單` 於有候補時附「候補名單」段落（§8(E)）。
- **OP-4（closed 活動可否取消）→ 僅 open 可操作**：signup/cancel/list 皆要求 `status='open'`，其餘（含 closed）回「目前沒有開放報名的活動」。

> 本次修訂後無新增開放問題。architect-reviewer 審查（2026-07-23）：建議 APPROVED，repository 原語簽名全數相符、零卡點；nit-2（getGroupMemberProfile）已採納、nit-5（遞補斷言）已採納；nit-1/3/4 由 Orchestrator 另記（R1 維持、handler DI/async 接線屬 T-006 實作、`-N` 只取消本人 self 名額之收斂解讀保留）。

### 需新增的 repository 方法清單（供 T-006 實作階段在 D-001 資料層補上）
- **【M2 實作必需，D-001 未提供，需新增】** `RegistrationRepository.findActiveProxyByName(eventId: number, displayName: string): RegistrationRow[]`
  - 語意：跨 owner 定位某 event 下 `kind='proxy' AND display_name = ? AND cancelled_at IS NULL` 的**所有有效代報列**，依 `seq` 排序（升冪；取消順序由 domain 再排）。
  - 用途：主辦人（`executor.id === event.host_user_id`）以 `-N 名字` 代取消任一 owner 代報的名額（OP-2）。
  - 註：與既有 owner-scoped `findActiveProxy(eventId, ownerUserId, displayName)` 的差別＝**不限 owner**；純查詢原語（唯讀，不涉寫入交易）。實作屬 D-001 資料層（`registration-repository.ts`），本文件僅提出需求與簽名。
- **【可選、非必要】** `EventRepository.findOpenByGroup(groupId): EventRow | undefined`：直接取 `status='open'` 活動，省去 domain 對 `findActiveByGroup` 結果過濾 status。非必要（domain 過濾 `status==='open'` 即可，非 SQL、不違 G10）。

> 除上述 `findActiveProxyByName`（M2 必需，需新增）與可選的 `findOpenByGroup` 外，D-001 既有原語（`runImmediate`/`countConfirmed`/`listConfirmed`/`listWaitlist`/`findActiveByOwner`/`findActiveProxy`/`insertSlots`/`cancelByIds`/`pickWaitlistForPromotion`/`promoteByIds`/`getById`、`UserRepository.upsert`/`getById`、`EventRepository.findActiveByGroup`、`ProcessedEventRepository.markProcessed`）**已足以實作 M2 其餘核心路徑**。

---

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-07-23 | OP-1 風險等級 | R1（標準；併發已於資料層測試覆蓋） |
| 2026-07-23 | OP-2 主辦代取消 | 納入 M2；host=event.host_user_id，新增 findActiveProxyByName 跨 owner 定位 |
| 2026-07-23 | OP-3 名單候補段落 | 顯示候補名單 |
| 2026-07-23 | OP-4 closed 取消 | 僅 open 可 signup/cancel，closed 回定型句 |
| 2026-07-23 | architect-reviewer 審查 | 建議 APPROVED；nit-2 採納（群組取名改 getGroupMemberProfile，新增 AC-19）、nit-5 採納（遞補列數防禦性斷言）；nit-1/3/4 另記 task-board |
| 2026-07-31 | 使用者最終 APPROVED | D-003 狀態 → APPROVED，T-006 派工實作 |
| 2026-07-31 | T-006 實作後 architect-reviewer 複審 | 建議 APPROVED（零 blocker，G1~G11 逐條 PASS）；裁決 (A) LINE mention 改 TextMessageV2+substitution 可接受（已補 §4 errata，不需 ADR）、(B) ownerDisplayName→subjectDisplayName + ListResult 增 duplicate 語意等價可接受（已補 §1.1 errata）；nit-2（freedConfirmed 取交易外快照，MVP 單實例安全，多實例才需改）、nit-3（no_open_event 時 list 有 mark、signup/cancel 未 mark 之行為不對稱）、nit-4（display_name 含字面 `{`/`}` 極低風險）記 task-board 備查 |
| 2026-07-31 | T-006 unit-tester 獨立覆核 | 124 tests 全綠、AC 58/58、未揪出實作 bug；補 11 個真覆蓋測試（整批候補分支、AC-2 大批併發、AC-5 組內高 seq、AC-11 cancel 冪等、AC-14 多筆遞補 index 位移等）。提醒 better-sqlite3 首次冷跑一次性 flake（環境層，記 Backlog） |
| 2026-08-01 | T-012 architect-reviewer R2 blocker B1（cancel 遞補超賣競態） | 已修：freedConfirmed 改由 `cancelByIds` 之 RETURNING（鎖內實際取消 confirmed 數）得出，取代交易外快照；新增 `[D-003 AC-20]` 回歸（PG 真並行）；§3 step 2/3 與「已定案／errata」補記。待 architect-reviewer 複審封閉 |
| 2026-08-02 | **errata B2（遞補額度算錯，使用者回報 bug）**：`freedConfirmed` → `promotionQuota` | 現象：capacity=10、confirmed=9、`+2 陳先生` 整批候補後，某人 `-1` 只遞補 1 位、仍空 1 位。根因＝G8 以 `freedConfirmed`（本次釋出數）為遞補額度，看不到 G1 整批候補留下的**擱置空位**。修正：§3 step 4 / G8 改為鎖內重算 `promotionQuota = fresh.capacity − countConfirmed()`，觸發條件由 `freedConfirmed > 0` 放寬為 `promotionQuota > 0`；新增 AC-21。**使用者裁決**：整批原子遞補（避免 quota < 批次人數時拆批）先允許拆批，列後續優化（需 `batch_id`，R2），記 task-board Backlog |
| 2026-08-02 | **errata（D-008 T-014 套用）**：findOpenEvent 拆分 + 鎖內 re-check + 名單 phase | `findOpenEvent` → `findOpenEventForSignup`（open ∧ 未過期，否則 `event_ended`/`no_open_event`）+ `findEventForDisplay`（`findLatestDisplayable`，顯示集 {draft,open,closed}，回 `phase`）；signup/cancel 新增 `event_ended`、`runImmediate` **鎖內以 `getById(event.id)` 重讀最新列** re-check（非 stale，nit-2/AC-9）；`getListView` 帶 `phase`；list-formatter `eventHeader` 日期改衍生 `event_datetime`、`feeLine` phase 化、ended/closed 去「剩餘名額」與「暫估/預估」、新增 closed/ended 標題。既有 AC 於 live（未過期 open）下仍成立。來源：D-008 §五 D-003（APPROVED）。 |
