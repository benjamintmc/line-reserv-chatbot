# D-020: 同群組多場並行活動（解除單場限制 + 訊息消歧義）

> **ID 衝突已解決（2026-08-31，orchestrator）**：本文件原由 architect 暫編為 `D-014`，
> 但該編號已被 `design/D-014-db-tls-verification.md` 占用（DB 連線 TLS 顯式化，APPROVED、
> 已於 T-027 實作並部署，AC-1~AC-7 已被 `src/db/__tests__/pool-ssl.test.ts` 與多份文件引用）。
> 已依 architect 建議改號為 `D-020`（`D-019` 為當時最大在用編號），檔案已搬移為
> `design/D-020-multi-event-per-group.md`，文件內部所有 `D-014` 引用已同步改為 `D-020`。
> `D-014-db-tls-verification.md` 維持不動、不受影響。

- 狀態：**APPROVED（2026-09-01）**——R2 雙審通過（design-reviewer 1 blocker 已依使用者裁決修正 + 3 nit 採納；architect-reviewer 1 blocker〔B1，跨群引言防禦缺口〕經 dispatch 層單點驗證修正並複審 PASS + 2 nit 採納）+ 使用者最終核可。解鎖 T-033
- AC 覆蓋：**待動工豁免**（任務 T-033 尚未開始，30 條 AC 暫不計入 `check_ac_coverage`；**動工時必須移除本行**，否則 AC 將不受檢查＝假綠）
- 撰寫者：architect
- 風險等級：**R2（高）**——`src/db/migrations/`、`src/domain/event-service.ts`、
  `src/domain/registration-service.ts`、`src/domain/grouping-service.ts`（授權判定入口）皆屬
  CLAUDE.md §4.5 預設高風險模組；且為資料 migration。
- 關聯：`docs/00-project-brief.md` FR-8 / 決策紀錄 #9（權威需求來源，已裁決完畢，本文件不重新徵詢）；
  取代決策 #3（同群限一場）。2026-08-31 使用者追加裁決：同群同時最多 3 場 open 活動（§3.5）。
- 相依（只復用、不私改）：D-001（schema 原語）、D-002（指令解析、正規化風格）、D-004（開團狀態機、
  兩層防護模式）、D-007（client-bound tx）、D-008（`event_datetime`／惰性過期）、D-010/D-011/D-012（加開／
  分組／批次，三者皆呼叫 `findActiveByGroup`）、D-013（`conversation_states` PK，正交、不改動）。

---

## 一、設計內容

### 0. 現況問題與本設計的兩個獨立關注點

1. **解除限制**：`ux_events_active_group`（`events(group_id) WHERE status IN ('draft','open')`）
   強制同群至多一場 active，且 `EventReader.findActiveByGroup(groupId)` 回傳**單一列**，
   `event-service.ts`／`registration-service.ts`／`grouping-service.ts` 全部呼叫點皆假設「群組只有
   一場活動」。解除限制後，這個假設不成立，凡是原本「查 groupId 就能唯一決定活動」的地方都要
   換成「查 groupId 得到候選集合，再決定要操作哪一場」。
2. **消歧義**：candidates 數 > 1 時，指令需要額外資訊才能決定目標活動——機制 A（quote-reply）
   與機制 B（`@selector`）。這是全新的一層，**與 D-013 的 `conversation_states` PK 問題正交**：
   D-013 解決「這個人在回答哪個流程的問題」，本設計解決「這個指令要作用在哪一場活動」；
   兩者互不影響，本設計不改動 `conversation_states` 的鍵值或攔截邏輯（G10）。

   > 另有第三個獨立關注點：**同群 open 活動數上限**（§3.5，2026-08-31 使用者追加裁決）。
   > 與「解除限制」和「消歧義」皆正交——解除限制決定「能不能同時有多場」，上限決定
   > 「最多能同時有幾場」，兩者一硬解一硬擋，不衝突。

### 1. Schema 變更（migration `0006_multi_event_per_group.sql`）

`0001~0005` 為既有／凍結區，只新增不改寫。

```sql
SET LOCAL lock_timeout = '3s';  -- events 為熱表，ALTER/INDEX 需 ACCESS EXCLUSIVE，比照 D-013 防守

-- (1) 解除「同群至多一場 active」：drop 舊單欄索引。
DROP INDEX ux_events_active_group;

-- (2) 新安全網：同群 active 集合內，場地+時間不得重複（decision #9 查重防護的 DB 層）。
--     以 (group_id, location, event_datetime) 唯一，取代原 (group_id) 唯一。
CREATE UNIQUE INDEX ux_events_active_group_venue_time ON events (group_id, location, event_datetime)
  WHERE status IN ('draft', 'open');

-- (3) 機制 A：bot 訊息 → 活動 映射表。
CREATE TABLE message_event_map (
  message_id  TEXT PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_message_event_map_event ON message_event_map (event_id);
```

- 索引改名（非沿用 `ux_events_active_group`）：舊名語意是「同群同時只能一場」，新名語意是
  「同群同時不能有兩場場地+時間相同」，語意不同不得共用名字（否則窄捕捉 catch 邏輯會誤判，G8）。
  **同群 open 數上限（§3.5）不在此新增任何索引/約束**——理由見 §3.5，屬應用層計數判斷。
- `message_event_map` 不設 `ON DELETE CASCADE`——events 從不物理刪除（狀態機終態即可，D-004 G6/G10），
  無需處理刪除連動。`ix_message_event_map_event` 供 Backlog 的「每週清除已結束活動關聯資料」日後使用
  （本輪不實作清除排程，見 §6）。**刻意不存 `group_id`**——B1 修復（見 §4.1／§4.3／G14）已論證
  跨群校驗改在讀取時以 `events.getById` 比對即可，不需要在寫入時多存一個冗餘欄位。
- 風險評估（比照 D-013）：`events` 為熱表但索引變更是**新增/替換索引**，不鎖資料列本身的讀寫路徑
  太久（`lock_timeout` 兜底、逾時即整檔 ROLLBACK、重跑即可）；`message_event_map` 是純新增表，
  零風險。

### 2. `EventReader` 介面變更

```ts
export interface EventReader {
  getById(id: number): Promise<EventRow | undefined>;
  /** 取代 findActiveByGroup：回該群 status ∈ {draft,open} 的「全部」列（依 id 升冪）。 */
  listActiveByGroup(groupId: string): Promise<EventRow[]>;
  findLatestDisplayable(groupId: string): Promise<EventRow | undefined>; // 不變（D-008）
}
```

**`findActiveByGroup` 整個移除**（不保留 wrapper、不留 deprecated 別名，G1）：它「回傳單一列」的
介面形狀本身就是「同群只有一場」假設的化身，留著就會被日後新代碼誤用而悄悄退回單場語意。
所有原呼叫點改寫為：`listActiveByGroup(groupId)` 取得候選集合 → 消歧義（§4）解出 `eventId` →
`getById(eventId)` 做鎖內權威重讀（既有模式，`getById` 不必新增)。

### 3. 開團查重（取代舊的「已有 active 就拒絕」）

**`startCreation`（逐步問答入口）**：移除原本「已有 active 就拒絕」的早退檢查——多場並行下，
`開團` 永遠可以開始一段新的問答流程（不查詢任何候選活動）。查重只能在欄位齊備時做，故本路徑的
查重延後到 `確認`（見下）。**此段僅描述「查重」的早退移除；「同群 open 數上限」的早退檢查是
獨立新增項目，不受本段影響，見 §3.5。**

**`handleOneline`（一行式，欄位在解析當下即齊備）**：入口先做**應用層快速失敗**——

```
candidates = listActiveByGroup(groupId)
proposedDatetime = taipeiToUtcIso(date, time)
dup = candidates.find(e => e.location === location && e.event_datetime === proposedDatetime)
if dup !== undefined → return { kind: 'duplicate_event', event: dup }   // 不寫 conversation_states
```

（實際執行順序：§3.5 的上限檢查先於本段查重檢查，見 §3.5「判斷順序」。此處為聚焦查重邏輯本身，
故先單獨列出。）

**`confirm`（兩路徑最終匯流點，唯一權威判定 + DB 安全網）**：交易內、INSERT 前重做同一查重
（鎖內權威重讀候選集合，比照既有「入口查 + 交易內再查」兩層模式，D-004 §4/§6）；INSERT 仍可能撞
`ux_events_active_group_venue_time`（跨行程競態）→ 窄捕捉該**新**約束名 → 回 `duplicate_event`、
清除 conversation（沿用既有 nit-2 落敗者清理邏輯）。

`CreateEntryResult`／`ConfirmResult` 的 `already_active` 成員**改名**為 `duplicate_event`
（語意改變：不再是「已有任何 active 就擋」，而是「已有場地+時間相同的 active 就擋」）；
`ContinueFlowResult` 的 race-lost 分支維持 `{ kind: 'duplicate_event' }`（DB catch 路徑不易得知
具體衝突列，沿用既有「不帶 event 明細」的簡化，formatter 文案不變）。

### 3.5 同群 open 活動數上限（獨立於開團查重；2026-08-31 使用者追加裁決）

**規則（權威）**：同群同時最多 **3 場** `status='open'` 活動（`MAX_OPEN_EVENTS_PER_GROUP = 3`，
沿用 `listActiveByGroup` 候選集合；MVP `draft` 不物化，`{draft,open}` 實務等同 `{open}`，同 D-008
OP-5）。這是與 §3 開團查重**正交**的第二道關卡：查重問「這場活動是否已經存在」，上限問「這個
群組還能不能再開一場」，兩者判斷內容不同、觸發條件不同、拒絕訊息不同，**不得合併為同一個
result kind 或同一次布林判斷**（見 G13）。

**兩層把關，套用到一行式與逐步問答兩個入口（比照 §3 查重的入口快速失敗 + `確認` 交易內權威重讀
模式）**：

- **`handleOneline`（一行式）入口**：先 `candidates = listActiveByGroup(groupId)`；
  `candidates.length >= 3` → 回 `{ kind: 'group_open_limit' }`（快速失敗，不寫
  `conversation_states`，且**先於**查重判斷——見下方判斷順序）。
- **`startCreation`（逐步問答）入口**：§3 已移除逐步問答的「已有 active 就拒絕」早退檢查——**但
  那指的是查重**（查重需要齊備欄位才能比對場地+時間，逐步問答一開始欄位皆空，無法比對）。**上限
  檢查不需要任何欄位**，可以且應該在問答第一步就做，否則使用者會被迫答完五題才在 `確認` 被拒。
  故 `startCreation` **新增**入口早退檢查（本設計唯一一處 `startCreation` 仍做入口早退）：
  `candidates.length >= 3` → 回 `{ kind: 'group_open_limit' }`，不進入 `awaiting_date`、不寫
  `conversation_states`。此即使用者裁決原文「開團（一行式與逐步問答皆同）回覆固定文案」的落地
  方式——兩個入口都在**最早可能的時機**擋下，而非等到 `確認`。
- **`confirm`（兩路徑最終匯流點，交易內權威判定）**：INSERT 前，於**同一交易**內重新
  `candidates = listActiveByGroup(groupId)`（鎖內權威重讀，防入口查驗之後、`確認` 之前的 race
  window 內候選數已變）；`candidates.length >= 3` → 回 `{ kind: 'group_open_limit' }`，
  `conversation.delete(...)` 清除該落敗流程（沿用既有 nit-2 落敗者清理邏輯，D-004 §4），
  **不 INSERT**。因**不設 DB 唯一索引**（見下），此分支必須由**應用層 COUNT** 產生，不是
  DB 例外 catch。

**`confirm` 內判斷順序（固定，避免與查重交錯誤判）**：**先判上限、後判查重**——即先
`candidates.length >= 3` → `group_open_limit`；未達上限才繼續 §3 的場地+時間查重判斷 →
`duplicate_event`。`handleOneline` 入口亦同序（先上限、後查重）。理由：「群組滿了」是比「這場
活動重複了」更根本的拒絕理由，且固定順序讓兩種拒絕不會因判斷順序不同而在邊界情況給出不一致的
訊息（reviewer 可用固定順序驗證，見 G13）。

**不設 DB 唯一索引 / CHECK constraint 硬擋（刻意，附理由）**：§3 查重需要 DB 安全網，因為兩場
「場地+時間相同」的活動若真的並存，屬**資料語意損壞**（現實中不可能同時空出現兩場球敘，且
`(group_id, location, event_datetime)` 唯一性未來可能被其他查詢倚賴）。上限則本質不同：即便
race window 下有數個並發 `確認` 同時通過各自的鎖前 COUNT 檢查（**超出幅度視同時並發的請求數而定，
非嚴格上界**——因各交易皆各自於鎖前 COUNT、非同一列鎖序列化，理論上 N 個並發請求皆可能各自
COUNT 到未達上限而同時通過），後果只是「這個群組短暫多開了數場」——不違反任何資料完整性不變式、不
影響超賣防護、消歧義機制（§4）一樣正常運作（`listActiveByGroup` 就地回實際筆數，選擇邏輯不受影響）。
用 Postgres 原生機制對「COUNT ≥ 3」設唯一約束/CHECK 需要額外的 serializable 交易或觸發器，
複雜度與這個極窄、極輕後果的邊界不成比例（不過度設計）。若使用者日後實測發現超出情形頻繁或
後果比預期嚴重，再評估加固（登記 Backlog，見 §6）。

**動態計算，非寫死**：上限判斷永遠是即時 `listActiveByGroup(groupId).length >= 3`，不快取候選數、
不記錄「這是第幾場」；故某場 open 活動 `關閉報名`／`取消活動`／過期被下次開團 flip 為 `done` 後，
候選數立即減少，下一次開團請求（一行式或逐步問答）即可通過（AC-27）。

**訊息（固定文案，逐字釘死，2026-08-31 使用者裁決）**：

```
此群組已有 3 場進行中的球敘，請等其中一場結束後再開新團
```

一行式與逐步問答入口、以及 `確認` 的權威拒絕，三處**共用同一句**，**不帶任何活動明細**（純上限
拒絕，無單一衝突列可指涉，與 `duplicate_event` 會帶 `event` 不同）。新增純函式
`formatGroupCapacityReached()`（比照既有 event-formatter 慣例，零 DB/LINE 耦合）。

**型別新增**：`CreateEntryResult`／`ConfirmResult`／`ContinueFlowResult` 三者皆新增
`{ kind: 'group_open_limit' }` 成員——與 `duplicate_event` 並列、**不合併、不共用**：

- `CreateEntryResult`：`handleOneline`／`startCreation` 入口快速失敗用。
- `ConfirmResult`：無進行中流程外的獨立 `確認` 分派路徑用（沿用 §3 既有的 `ConfirmResult` 成員
  慣例）。
- `ContinueFlowResult`：`確認` 於 `awaiting_confirm` 觸發、經 `continueFlow` 分派時的交易內權威
  判定用（此分支**不是** DB catch，是應用層 COUNT 判斷，區別於 `duplicate_event` 在
  `ContinueFlowResult` 內是 DB race-lost catch 產生——兩者觸發機制不同，勿混淆）。

### 4. 消歧義機制（機制 A + 機制 B + 判斷順序）

#### 4.1 機制 A：quote-reply → `message_event_map`

- **寫入時機（唯一正確時機）**：`server.ts` 呼叫 `replyClient.replyMessage(...)` 拿到回應後，
  用回應的 `sentMessages[].id`（真正送出的 LINE message id，而非我方組的暫時物件）逐一寫入
  `message_event_map`（G3：不得提前用「即將送出的訊息陣列長度」猜測寫入，reply 可能整則失敗、
  `sentMessages` 的數量/id 以 LINE 回應為準）。
- **`relatedEventId` 如何從 handler 傳到 server**：`WebhookHandler.handleEvent` 回傳型別改為

  ```ts
  export interface HandleEventResult {
    messages: messagingApi.Message[];
    /** 這次回覆若與某一場具體活動相關，其 id；undefined = 不寫入 message_event_map。 */
    relatedEventId?: number;
  }
  export interface WebhookHandler {
    handleEvent(event: WebhookEvent): Promise<HandleEventResult>;
  }
  ```

  `server.ts` 收到後：若 `messages.length>0` 且 reply 成功且 `relatedEventId !== undefined`，
  對 `res.sentMessages` 每個 `id` 呼叫 `messageEventMap.record(id, relatedEventId)`。
- **`ReplyClient.replyMessage` 回傳型別**須從 `Promise<unknown>` 改為 SDK 真型別
  `Promise<messagingApi.ReplyMessageResponse>`（`lineClient` 本就是這個型別，先前只是介面沒宣告，
  現在需要讀 `sentMessages`，補上型別而非新增行為）。
- **哪些送出點要附 `relatedEventId`**：見 §5.3 的完整枚舉表（G4）。
- **讀取（消費 quote）**：`event.message.quotedMessageId`（webhook 文字訊息事件既有欄位，使用者若
  引用了過去某則訊息即帶此值）存在時，`await deps.messageEventMap.getEventId(quotedMessageId)`
  取得 `rawQuotedEventId`（查無 → `undefined`，等同沒有引言）。`MessageEventMapReader`／`Repository`
  加入 `WebhookHandlerDeps`（**必填**，理由同 D-018 §1「選填會讓功能靜默失效」的先例）。
- **讀取後的跨群安全校驗（B1 修復，2026-09-01，architect-reviewer 要求）**：`rawQuotedEventId`
  **尚不可信任**——`message_event_map` 未存 `group_id`，理論上只要某使用者能對一則 bot 訊息引言
  （即便 LINE 用戶端實務上使用者無法跨群引言，本設計此前從未把這個限制明講、也從未被任何
  Guardrail 或 AC 釘死），`rawQuotedEventId` 就可能指向別群的活動。因此在傳入 §4.3
  `resolveTargetEvent` 之前，**必須**於 dispatch 層（§5.2）以 `events.getById(rawQuotedEventId)`
  取得該列，比對 `row.group_id === groupId`：
  - 相符 → `quotedEventId = rawQuotedEventId`（正常往下走既有 §4.3 邏輯）。
  - 不符，或 `row === undefined` → `quotedEventId = undefined`（**視為使用者沒有引言**，不建立任何
    專屬錯誤分支、不回覆任何提及別群活動的文字），交由 §4.3 既有的 none/single/ambiguous/
    `@selector` 分支之一正常決定結果——確保「別群活動是否存在」這件事完全不會透過任何訊息內容
    洩漏（AC-28）。
  - 此校驗**只在 dispatch 層做一次**，`resolveTargetEvent`／`matchSelector` 維持純函式、**不**
    接受 `groupId` 參數、**不**查 DB（G6 不變）；service 層因此**不需要**（也不應該）重複驗證
    `eventId` 所屬 group（見 §5.1 附註、G14）。

#### 4.2 機制 B：`@selector` 前綴（`src/commands/selector.ts`，擴充 D-002）

**語法切分為純函式**，與 `parseCommand` 同層、同風格（G5/G6：只動白名單字元、不做 NFKC、
不觸 DB、不判斷候選活動）：

```ts
export interface SelectorSplit {
  /** 選擇器原文（trim；跨多 token 以原始間距切出，非重新 join）。undefined = 無 @ 前綴。 */
  selectorRaw: string | undefined;
  /** 供 parseCommand 使用的剩餘文字，**保留原始換行**（供 D-012 多行批次沿用既有拆行）。 */
  rest: string;
}
export function splitSelector(text: string): SelectorSplit;
```

演算法：

1. 先跑 D-002 §5 白名單正規化（`normalizeWhitelist`，**新增一項**：全形 `＠`(U+FF20) → 半形 `@`，
   與既有 `＋`/`－`/`：` 同一風格併入同一張表，非新開一條規則）。
2. 用 `\S+` 逐一取出 token 與其**字元位移**（换行也視為分隔，允許「選擇器獨佔第一行、指令在第二行」
   的批次寫法，例：`@旭陽\n+1\n-1 陳先生`）。
3. 第一個 token 不以 `@` 開頭 → `{ selectorRaw: undefined, rest: text }`（原樣不動）。
4. 否則，去掉 `@` 後若該 token 只剩空字串（即 `@` 後緊接空白或到此為止）→ 視為無效前綴，
   同上原樣不動（不硬吃掉這個 `@`，讓它按舊行為落入 `unknown`）。
5. 否則從該 token（去 `@` 後）開始累積為候選 selector 文字，逐一檢查後續 token，直到命中
   **停止 token**（累積中止，該 token 起算為 `rest`）：
   - 符合 `^[+-]\d` （`+N`/`-N` 起手）；或
   - 精確等於（大小寫規則與 D-002 §3 dispatch 表一致）下列**指令頭關鍵字**之一：
     `名單`、`list`（case-fold）、`確認`、`取消活動`、`取消`、`關閉報名`、`下一輪`、`我的id`
     （case-fold）、`開團`、`新活動`、`分組`、`加開`、`編輯`。
   - 若掃到文字結尾仍未命中停止 token（selector 佔滿剩餘全部文字、無指令可解）→ selector 為
     掃到的全部內容，`rest` 為空字串（多行批次時，代表第一行整行是 selector，指令在下一行；
     單行時代表這則訊息只有 selector 沒有指令 → 之後 `parseCommand('')` 得 `unknown`，無害）。
6. `selectorRaw` = 步驟 5 累積片段（依原文字元切出，trim 首尾）；`rest` = 原文自停止 token
   起始位置之後的子字串（**字元切片，不重組**，保留原始空白/換行給 D-012 拆行用）。

**停止關鍵字集合須與 `parse.ts` 的分派關鍵字保持同步**：新增任何指令首字關鍵字（例如日後的
`XX`）時**必須**同步加入本清單，否則該關鍵字會被誤吞進 selector 文字（G-selector-sync，見
Guardrails；**必須**新增測試斷言，見 AC-29）。

**判斷時機**：`splitSelector` 只在 `dispatchSingle`／`handleBatch` 前呼叫一次（在 D-004 §3.3 的
conversation 攔截**之後**——開團問答/分組 session 的答案不吃 `@selector` 語法，避免使用者填日期
欄位時剛好帶 `@` 被誤判）。

#### 4.3 語意解析（`src/domain/event-disambiguation.ts`，純函式）

```ts
export type TargetResolution =
  | { kind: 'none' }                        // candidates.length === 0
  | { kind: 'single'; eventId: number }     // candidates.length === 1（忽略 quote/selector）
  | { kind: 'resolved'; eventId: number }   // >1 候選，quote 或 selector 命中恰一場
  | { kind: 'ambiguous' }                   // >1 候選，無 quote 也無 selector
  | { kind: 'conflict' }                    // quote 與 selector 都給了，指向不同活動
  | { kind: 'not_found'; selectorRaw: string } // selector 命中 0 場
  | { kind: 'too_many'; selectorRaw: string }; // selector 命中 >1 場

export function resolveTargetEvent(
  candidates: EventRow[],
  quotedEventId: number | undefined,
  selectorRaw: string | undefined,
  now: string,
): TargetResolution;

/** 供 resolveTargetEvent 內部使用，亦單獨導出供測試：selector 對候選集合的比對。 */
export function matchSelector(
  candidates: EventRow[],
  selectorRaw: string,
  now: string,
): EventRow[]; // 回傳所有命中的列（0/1/多）
```

**`resolveTargetEvent` 判斷順序（逐字對應 decision #9 §步驟 1–6，G2 不得重排）**：

1. `candidates.length <= 1` → `candidates.length===0` 回 `none`；`===1` 回 `single`（**完全不看**
   quote/selector，即便使用者剛好帶了、或帶錯了，也不驗證——單場時的既有行為零回歸）。
2. `candidates.length > 1`：
   a. 若 `quotedEventId !== undefined` 且 `selectorRaw !== undefined`：先各自求值
      `quotedEventId`（直接視為候選之一，不再二次過濾是否在 candidates 內——見下方附註）與
      `matchSelector(candidates, selectorRaw, now)` 命中結果；若兩者不是同一個活動（selector
      命中非恰一場，或命中的那場 id ≠ quotedEventId）→ `conflict`。
   b. 否則若只有 `quotedEventId` → `resolved(quotedEventId)`。
   c. 否則若只有 `selectorRaw` → 依 `matchSelector` 命中數：0 → `not_found`；>1 → `too_many`；
      恰 1 → `resolved`。
   d. 兩者都無 → `ambiguous`。

**附註（quote 解析範圍的刻意取捨）**：`quotedEventId` 來自 `message_event_map`，其值**不限於**
目前仍在 `candidates`（active）內的活動——使用者可能引用一則指向已關閉/已取消活動的舊訊息。
本設計**不**在此處過濾，理由：多場並行下唯一需要消歧義的情境就是 candidates>1，只要
`quotedEventId` 有值就代表使用者明確指了某一場（即便那場已非 active），後續交給該指令自身既有的
「這場活動還能不能做這件事」判斷（如 `no_open_event`/`event_ended`/`closed_not_editable`）處理，
不在消歧義層重複這層邏輯（分工單一）。

**與跨群校驗的分工邊界**：本附註談的是「同群內、非 active 的舊活動」是否要被過濾——答案是不過濾
（分工單一，交給各指令自身狀態判斷）。這與 B1 修復的「跨群」校驗是兩件不同的事：**跨群校驗在
`resolveTargetEvent` 被呼叫之前、於 §5.2 dispatch 層就已完成**（見 §4.1）；傳入本函式的
`quotedEventId` 保證**若非 `undefined`，必屬於當前 `groupId`**——`resolveTargetEvent` 本身因此
不需要、也沒有 `groupId` 參數可用來重複這層檢查。

**`matchSelector` 比對規則**：

1. 以空白切分 `selectorRaw` 為 tokens。
2. 逐 token 分類：符合 `^\d{4}[/-]\d{1,2}[/-]\d{1,2}$` → 完整日期；符合 `^\d{1,2}[/-]\d{1,2}$`
   → 月日（無年，用今年份比對台灣本地日期的 `MM-DD`）；符合 `^\d{1,2}:\d{2}$` → 時間；
   其餘 → 場地文字 token。
3. 場地查詢字串 = 場地文字 tokens 以單一空白 join；非空時，先以 `event.location.includes(query)`
   （子字串，區分大小寫）過濾候選集合。
4. 若有日期 token，再以 `utcIsoToTaipei(event.event_datetime)` 的 `date` 過濾（完整日期精確比對；
   月日 token 只比對 `MM-DD` 後兩段，忽略年份）。
5. **時間 token 僅在「場地+日期過濾後仍 >1 場」時才進一步套用**（decision #9：「時間可先比對日期、
   不夠精準再加時間」——時間是次要窄化條件，非必要條件）。
6. 回傳最終過濾後的集合（可能 0/1/多筆）。

**顯示截斷（NIT-2 修復，2026-09-01）**：`not_found`/`too_many` 訊息中的 `{xxx}` 為 `selectorRaw`
原文回顯；若使用者輸入超長文字（例如整段貼上一大串文字後接 `@`），逐字回顯會造成訊息過長、體驗
不佳。**僅在 formatter 層**截斷（不改 `TargetResolution` 型別本身，`selectorRaw` 欄位仍存原始
未截斷值，供測試/除錯用）：新增純函式 `truncateForDisplay(s: string, max = 20): string`（比照既有
`MAX_PROXY_NAME_LEN=20`／`MAX_LOCATION_LEN=40` 量級，取較嚴格的 20），超過 `max` 字元 → 取前
`max` 字元 + `…`。`formatNotFound(selectorRaw)`／`formatTooMany(selectorRaw)` 呼叫前先過此函式
（AC-30）。

**已知限制（Backlog，非本輪必解）**：場地名稱若本身含空白（如「東方 A 場」），使用者以
`@東方 A場 +1` 這類 selector 輸入時，token 切分與比對可能不夠精準；MVP 先以子字串比對 + 使用者
可用完整場地名或唯一片段自行避開歧義的方式因應，不做進階模糊比對。

### 5. Service 層改動

#### 5.1 通用模式

`EventReader.findActiveByGroup(groupId)` 的每個原呼叫點，改為：**handler 層先解出 `eventId?`
（見 §5.2），再把 `eventId` 放進各 service 的 Input，service 內以 `events.getById(eventId)` 取代
`events.findActiveByGroup(groupId)`**。`eventId === undefined` 語意 = 消歧義判定「候選數為 0」，
service 內沿用各自原本「查無 active」的既有分支（`no_open_event`/`no_active` 等），**行為零改變**。

**跨群防線只設一處（B1 修復，避免文件前後矛盾）**：§4.1／§5.2 已在 dispatch 層對 quote 解出的
`eventId` 做過 `group_id` 校驗（不符即視為未引言），故此處『service 內以 `events.getById(eventId)`
取代 `findActiveByGroup(groupId)`』**不需要再重複比對 `group_id`**——`getById` 單純信任 dispatch
層傳入的 `eventId` 已經過群組範圍過濾（見 G14）。`@selector` 路徑本就安全：`matchSelector` 只在
`listActiveByGroup(groupId)` 回傳的候選集合內比對，天然被 group 限定，不需要額外檢查。

**`closeEvent`／`cancelEvent` 的雙層授權模式維持不變**：現行「交易外 early-return 授權檢查（讀一次
`event` 判 `canManageEvent`）+ 交易內權威重讀（`FOR UPDATE` 再讀一次）」雙層模式
（`src/domain/event-service.ts:563,572,603,612`）**兩次查詢都保留**，只是查詢方式從
`findActiveByGroup(groupId)` 換成 `getById(eventId)`（`eventId` 由消歧義解出）——**不得**因為改成
`getById` 就合併成一次查詢，兩層各自的鎖前/鎖內重讀語意（TOCTOU 防護）不變。

受影響的 Input 型別（新增欄位，其餘既有欄位不變）：

| Input | 新欄位 | 备注 |
|---|---|---|
| `SignupInput` / `CancelInput` | `eventId?: number` | `findOpenEventForSignup` 改吃 `eventId` |
| `ListInput` | `eventId?: number` | `undefined` 時沿用既有 `findLatestDisplayable` 回退（見 §5.4，**不可**與其他 Input 統一處理） |
| `AddCapacityInput` | `eventId?: number` | |
| `LifecycleInput`（close/cancel） | `eventId?: number` | |
| `EditEventInput` | `eventId?: number` | `undefined` 時沿用既有 `findLatestDisplayable` 回退（editEvent 原邏輯本就只在 0 候選時查 closed，不受 §5.4 那個 bug 影響，見附註） |
| `BalancedInput` / `StartRoundsInput` | `eventId?: number` | |

`NextRoundInput`（`下一輪`）**不變**——decision #9 判斷順序清單未列 `下一輪`；它由既有
`conversation_states` 的 grouping session 鎖定活動，session 本身即是消歧義結果，不需重跑（G11）。

#### 5.2 handler.ts 的消歧義插入點

```
dispatchSingle(groupId, userId, messageId, text):
  1. { selectorRaw, rest } = splitSelector(text)
  2. cmd = parseCommand(rest)
  3. 若 cmd.type ∉ NEEDS_EVENT_SET → 照舊分派（不查候選、不消歧義；my_id/confirm/abort/
     create_event_*/group_next/unknown/非 edit_event 的 invalid 皆屬此類）
  4. 否則：
     candidates = events.listActiveByGroup(groupId)
     rawQuotedEventId = event.message.quotedMessageId 存在 ? await messageEventMap.getEventId(...) : undefined
     quotedEventId = await resolveQuotedEventInGroup(rawQuotedEventId, groupId, events)  // B1：跨群校驗，見 §4.1
     resolution = resolveTargetEvent(candidates, quotedEventId, selectorRaw, nowIso())
     依 resolution.kind 短路（ambiguous/conflict/not_found/too_many → 對應的 4 個新 formatter，
       直接回覆，**不呼叫任何 service**，不 markProcessed——這些是純判斷、無副作用的拒絕，
       比照既有「非授權早退不 mark」的精神；見 AC 對應項）；
     none → eventId = undefined；single/resolved → eventId = resolution.eventId
     5. 呼叫對應 service，Input 帶上 eventId
```

```ts
/** B1 修復：quote 解出的 eventId 必須先確認屬於當前群組，才可交給 resolveTargetEvent。
 *  不符/查無 → 視為未引言（undefined），不建立專屬錯誤訊息、不洩漏別群任何資訊。 */
async function resolveQuotedEventInGroup(
  rawEventId: number | undefined,
  groupId: string,
  events: EventReader,
): Promise<number | undefined> {
  if (rawEventId === undefined) return undefined;
  const row = await events.getById(rawEventId);
  return row !== undefined && row.group_id === groupId ? rawEventId : undefined;
}
```

`NEEDS_EVENT_SET = { signup, cancel, list, add_capacity, group, close_event, cancel_event,
edit_event, edit_help }`。

`handleBatch`（D-012）：`splitSelector` 對整段原文呼叫**一次**（在 D-012 既有的 `\r?\n` 拆行**之前**），
故「第一行 selector」的既定語意（decision #9）由 `splitSelector` 本身的換行穿越規則自然滿足
（見 §4.2 演算法步驟 2 的換行說明）；`resolveTargetEvent` 針對整批只解一次，解出的 `eventId`
套用到批次內每一行（G12：不支援批次內以第 2 行以後的 `@` 切換活動——若某行仍以 `@` 開頭，
`parseCommand` 對該行仍走既有 dispatch，多半落 `unknown`/`invalid`，因 D-012 既有規則本就只認
`signup`/`cancel` 為可執行行，非法/非預期型別一律忽略，零新增行為）。

#### 5.3 `relatedEventId` 送出點枚舉（G4：新增/修改任何回覆分支時對照本表）

| 分支（函式／case） | eventId 來源 |
|---|---|
| `renderSignup` / `ok` | `result.view.event.id` |
| `renderCancel` / `ok` | `result.view.event.id` |
| `renderList` / `ok` | `result.view.event.id` |
| `renderAddCapacity` / `ok` | `result.view.event.id` |
| `renderBalanced` / `balanced` | 消歧義解出的 `eventId`（`BalancedResult` 本身不帶 event，由呼叫端在 `dispatchSingle` 內附加） |
| `renderStartRounds` / `round` | 同上，且需寫入 `GroupingState.eventId`（新增欄位，供 `下一輪` 沿用） |
| `renderNextRound` / `round` | 讀 `JSON.parse(conv.payload).eventId`（見 §5.5） |
| `renderCreateEntry` / `duplicate_event` | `result.event.id`（既存衝突活動） |
| `renderContinue` / `created` | `result.event.id`（**新建活動的公告訊息，最重要的錨點**） |
| `renderConfirm` / `created` | `result.event.id` |
| `renderClose` / `ok` | `result.event.id` |
| `renderCancelEvent` / `ok` | `result.event.id` |
| `renderEdit` / `ok` | `result.eventId`（**`EditEventResult.ok` 需新增此欄位**，現行只有 field/before/after 等） |
| `handleBatch` 成功路徑 | `lastView.event.id` |

**明確不附（無單一具體活動、或該分支本就無 DB 副作用可言）**：`no_open_event`/`event_ended`/
`nothing_to_cancel`/`duplicate`(去重)/`not_authorized`/`no_active`/`already_closed`/`over_limit`/
`insufficient`/`no_session`/`exhausted`/`format_error`/`help`/`capacity` 導向/`bad_fee`/
`past_datetime`/`closed_not_editable`/`my_id`/`invalid`(非 edit_event)/`unknown`/四個新消歧義錯誤
（ambiguous/conflict/not_found/too_many）/`flow_started`/`awaiting_confirm`（draft 尚未成為 event
列）/**`group_open_limit`（§3.5 同群 open 數上限，無單一衝突列可指涉）**。**新增任何回覆活動相關
內容的分支時，必須在此表補一列，不得只改程式碼不改本表**（reviewer 逐條核對用）。

#### 5.4 `名單`（list）的 0-候選回退——不可直接套用通用模式的原因

多場並行下，`findLatestDisplayable(groupId)`（`{draft,open,closed}` 依 id 取最新）**不再安全**
當作「候選數 ≤ 1」的通用回退：群組可能同時有一場**仍 open** 的活動（id 較小、較早建立）與一場
**較晚建立且已 closed** 的活動（id 較大）——舊碼在單場限制下這兩者不可能共存，新碼下可以。
若沿用「latest by id」，`名單` 會顯示錯誤的（已結束的）那場，蓋掉仍在報名中的那場。

**修正**：`getListView` 的候選數判斷**必須先跑 §5.2 的消歧義流程**（`listActiveByGroup` 為準）：
`candidates.length>=1` 時一律用消歧義解出的 `eventId`（`getById`，必為 open/draft，天然正確）；
只有 `candidates.length===0`（群組完全沒有 active 活動）才退回 `findLatestDisplayable`
（此時只剩 closed/cancelled 可選，不存在「蓋掉仍開放活動」的風險，行為零回歸）。

**`編輯`（editEvent）不受此問題影響**：其既有「0 候選 → `findLatestDisplayable` 判斷是否
`closed_not_editable`」分支，本就只在 candidates.length===0 時執行（editEvent 從未在有 active
活動時去查 closed 事件），無需修正、直接沿用（附註於 §5.1 表格）。

#### 5.5 `GroupingState` 新增 `eventId`

`src/domain/grouping.ts` 的 `GroupingState` 介面新增 `eventId: number`（session 綁定的活動）。
`startRounds` 寫入時填入消歧義解出的 `eventId`；`nextRound` 讀出後原樣寫回（不變更）；
handler 的 `renderNextRound`/`renderStartRounds` 用它作為 `relatedEventId`（§5.3）。
**`下一輪` 本身仍不跑 `splitSelector`/`resolveTargetEvent`**（G11）——這只是讓它的訊息也能被
quote，不代表它參與消歧義判斷。

### 6. Backlog（本輪不做，登記供後續評估）

- `message_event_map` 隨時間增長的清除：規劃「每週清除已結束活動的關聯資料」，需要排程機制
  （本專案 Cloud Run `min-instances=0` 無背景 cron，比照既有「開球前提醒」的結論，需另開 ADR 評估
  排程方案）與保留期限，**不在本次實作範圍**，`ix_message_event_map_event` 已預先建好供未來
  清除查詢使用。
- `matchSelector` 對含空白場地名的精確度限制（§4.3 已知限制）。
- 名單查詢在 candidates.length===0 但同群有**多場**closed 事件時，仍只顯示 latest-by-id 那一場
  （未消歧義歷史 closed 事件），維持既有行為，不擴大範圍。
- 若同群 open 數上限（§3.5）的 race window 超出情形在實測中發現頻繁或後果比預期嚴重，評估是否需要
  以 serializable 交易或觸發器加固為 DB 層約束（目前判斷不需要，見 §3.5）。

---

## 二、Guardrails（Must NOT）

- **G1（無單值介面殘留）**：`EventReader` 不得保留 `findActiveByGroup` 或任何「回傳單一活動」
  當作預設路徑的方法；所有原呼叫點改用 `listActiveByGroup` + 明確消歧義/查重邏輯，不得以
  wrapper（如 `listActiveByGroup(groupId)[0]`）掩蓋、變相恢復單場假設。
- **G2（判斷順序不可重排）**：`resolveTargetEvent` 必須逐字依 §4.3 步驟 1–6（= decision #9 判斷
  順序）實作；`candidates.length<=1` 必須**最先**判斷且完全略過 quote/selector 的解析與驗證
  （即便解析了也不使用），不得先解析/驗證 selector 再判活動數——否則單場時仍可能因 selector
  格式錯誤而誤判為需要消歧義。
- **G3（message_event_map 寫入時機）**：只能在 `server.ts` 取得 `replyMessage` 的
  `sentMessages[].id`（真實回應）之後寫入；不得依「即將送出的 `messages` 陣列」預先寫入
  （reply 可能整則失敗、`sentMessages` 的數量/id 以 API 回應為準，不得假設兩者一一對應）。
- **G4（送出點枚舉完整性）**：§5.3 表為完整清單；新增/修改任何會產生「與某活動相關」訊息的
  render 分支時，**必須**同步更新該表並判斷是否附 `relatedEventId`，不得只改程式碼。
- **G5（selector 切分不逾越正規化風格）**：`splitSelector` 的正規化僅限沿用/擴充 D-002 §5
  白名單字元類（本次新增 `＠→@` 一項），不得對整串做無差別 `NFKC`／全形標點轉換。
- **G6（selector 切分為純函式、不越界）**：`splitSelector` 不得存取 DB、不得判斷候選活動集合、
  不得決定要不要回覆錯誤訊息——語意解析（是否命中哪一場）一律留給 `resolveTargetEvent`/
  `matchSelector`（domain 層），此為 D-002 G5「不越界」原則的延伸適用。**`resolveTargetEvent`／
  `matchSelector` 同樣不得接受 `groupId` 參數或查 DB**——跨群校驗是 dispatch 層的職責（G14），
  不得為了 B1 修復而讓這兩個函式失去純函式特性。
- **G7（查重兩層防護）**：開團查重必須同時具備**應用層快速失敗**（一行式入口 / 逐步問答
  `確認` 前查詢）與 **DB 唯一索引安全網**（`ux_events_active_group_venue_time` 撞唯一違反時
  窄捕捉），不得只做其中一層（比照 D-004 §4/§6 既有模式）。
- **G8（窄捕捉限定新索引名）**：`confirm()` 的窄捕捉判斷式必須比對**新**約束名
  `ux_events_active_group_venue_time`；不得用「任何 `23505` 皆視為重複活動」的寬鬆判斷
  （會誤吞其他未來新增的唯一索引違反，掩蓋真正的錯誤）。
- **G9（`名單` 0-候選回退的正確順序）**：`getListView` 不得在候選數未知的情況下直接呼叫
  `findLatestDisplayable`；必須先以 `listActiveByGroup` 判斷候選數，`>=1` 時一律使用消歧義解出
  的 `eventId`（`getById`），**只有** `===0` 時才退回 `findLatestDisplayable`（見 §5.4，防止較新
  的 closed 活動蓋掉仍 open 的較舊活動）。
- **G10（不動 conversation_states）**：本設計不得修改 `conversation_states` 的 PK、攔截邏輯或
  開團問答/分組 session 的互斥語意（D-013 既有）；本設計與 D-013 為正交關注點。
- **G11（`下一輪` 不跑消歧義）**：`nextRound`／`GroupingService.nextRound` 不得呼叫
  `splitSelector`/`resolveTargetEvent`；其目標活動完全由既有 grouping session 決定
  （decision #9 判斷順序清單未列 `下一輪`，擴大範圍即偏離裁決）。
- **G12（批次僅認第一行 selector）**：`handleBatch` 不得允許第 2 行以後以新的 `@selector`
  切換目標活動；整批訊息共用 `dispatchSingle`/`handleBatch` 前一次性解出的 `eventId`。
- **G-selector-sync（關鍵字同步）**：`splitSelector` 的停止 token 關鍵字集合（§4.2 步驟 5）與
  `src/commands/parse.ts` 的指令頭關鍵字**必須保持一致**；新增任何指令首字關鍵字時，兩處須同步
  更新，不得只改一處；**必須**新增至少一條測試斷言驗證 `splitSelector` 停止詞集合是 `parse.ts`
  指令頭關鍵字集合的超集（即後者 ⊆ 前者），兩者不同步時該測試須失敗——此為強制要求，非建議事項
  （對應 AC-29）。
- **G13（上限與查重為獨立判斷，不可誤判為同一種拒絕）**：`group_open_limit`（§3.5 同群 open 數
  上限）與 `duplicate_event`（§3 場地+時間查重）**必須各自獨立判斷、各自獨立的 result kind、
  各自獨立的訊息文案**；不得共用同一個 result kind、不得在同一次判斷中把兩者合併為單一布林
  旗標、不得讓其中一種拒絕的判斷邏輯間接掩蓋另一種（例如上限已達卻仍先跑查重邏輯而回錯誤
  訊息，或反之）。`confirm`／`handleOneline` 皆須依 §3.5 定義的固定順序（**先上限、後查重**）
  判斷，不得任意調換、不得平行判斷後隨意取一結果。
- **G14（quote 解出的 eventId 須驗證屬於當前群組，B1 修復）**：`message_event_map` 未存
  `group_id`，quote 解出的 `rawQuotedEventId` 不可信任來源；dispatch 層（§5.2）**必須**於呼叫
  `resolveTargetEvent` 之前以 `events.getById(rawQuotedEventId)` 驗證 `row.group_id === groupId`，
  不符或查無 → 視為未引言（`quotedEventId = undefined`），不得直接信任 `message_event_map` 的
  查詢結果、不得建立任何會洩漏別群活動資訊（活動名稱/場地/時間/是否存在）的專屬錯誤分支——結果
  一律落入既有 none/single/ambiguous/`@selector` 分支之一。此驗證只在 dispatch 層做**一次**，
  `resolveTargetEvent`／`matchSelector` 維持純函式（見 G6）；service 層因此**不需要**（也不應該）
  重複驗證 `eventId` 所屬 group（見 §5.1 附註）。

---

## 三、Acceptance Checks

- [ ] **[D-020 AC-1]（migration 結構）**：套用 0006 後，`ux_events_active_group` 不存在；
  `ux_events_active_group_venue_time` 存在且 `pg_get_indexdef` 顯示 predicate 為
  `status IN ('draft','open')`、欄位為 `(group_id, location, event_datetime)`；`message_event_map`
  表存在且 `message_id` 為 PK、`event_id` 有 FK 指向 `events(id)`、`ix_message_event_map_event` 存在。
- [ ] **[D-020 AC-2]（同群多場並存）**：同群連續開兩場「場地或時間不同」的活動皆成功
  （`status='open'` 各一列並存）；`listActiveByGroup` 回傳兩列。
- [ ] **[D-020 AC-3]（開團查重：一行式快速失敗）**：群組已有一場 open「東方球場 2026-08-15
  07:30」，再次 `開團 2026/08/15 07:30 東方球場 …` → 回「已有相同時間地點的球敘」、
  **不寫 `conversation_states`**（無 DB 副作用）。
- [ ] **[D-020 AC-4]（開團查重：逐步問答於確認時失敗）**：逐步問答填完與現有活動場地+時間相同
  的欄位、輸入 `確認` → 回同上訊息、`conversation_states` 該列被清除、不 INSERT 新 event。
- [ ] **[D-020 AC-5]（查重 DB 安全網）**：兩個使用者並發完成「場地+時間相同」的逐步問答並同時
  `確認` → 僅一人成功 INSERT，另一人捕捉 `ux_events_active_group_venue_time` 違反並回
  `duplicate_event`（非未捕捉例外）。
- [ ] **[D-020 AC-6]（單場時零回歸）**：群組只有 1 場 open 活動時，`+1`（無 selector、無引言）、
  `@隨便打的文字 +1`（selector 存在但與該場地不符）、引用一則與該活動無關訊息的 `+1`，
  三者皆**照常成功報名該場**（`resolveTargetEvent` 回 `single`，完全不驗證 selector/quote 內容）。
- [ ] **[D-020 AC-7]（多場、無 selector/引言 → 提示）**：群組有 2 場 open 活動，`+1`（無 `@`、
  非引言）→ 回「群組內有多場球敘進行中，請回覆或標註 @場地/@時間 以指定要操作的球敘」，
  不呼叫任何 service、不 markProcessed。
- [ ] **[D-020 AC-8]（`@selector` 命中恰一場）**：2 場 open，場地分別為「旭陽」「東方」，
  `@旭陽 +1` → 報名到旭陽那場。
- [ ] **[D-020 AC-9]（`@selector` 命中 0 場）**：`@不存在的場地 +1` → 回「找不到符合 不存在的場地
  的球敘，請確認後再試」（`{xxx}` 為原文）。
- [ ] **[D-020 AC-10]（`@selector` 命中 >1 場）**：3 場 open 皆含「球場」子字串，`@球場 +1` → 回
  「有超過一場 球場 的球敘，請修正再試」。
- [ ] **[D-020 AC-11]（`@selector` 場地+日期組合）**：2 場 open 同場地「旭陽」但日期不同，
  `@旭陽 8/15 +1` → 精準命中該日期那場。
- [ ] **[D-020 AC-12]（日期不夠精準時加時間窄化）**：2 場 open 同場地同日期、時間不同，
  `@旭陽 8/15 +1` 命中 >1 場，但同一 selector 若補上時間如 `@旭陽 8/15 07:30 +1` → 命中恰一場。
- [ ] **[D-020 AC-13]（quote 命中恰一場）**：使用者引用先前一則屬於活動 B 的 bot 訊息並回覆
  `+1`（無 `@selector`）→ 報名到活動 B。
- [ ] **[D-020 AC-14]（quote 與 selector 衝突）**：使用者引用活動 A 的訊息，但文字帶
  `@活動B場地 +1` → 回「回覆與內文球敘資訊不符，請修正再試」，不執行任何報名。
- [ ] **[D-020 AC-15]（quote 與 selector 一致時不視為衝突）**：引用活動 A 的訊息且 `@selector`
  也命中活動 A → 正常執行（不誤判 conflict）。
- [ ] **[D-020 AC-16]（`message_event_map` 寫入：開團公告）**：`確認` 建立新活動成功後，
  該次 reply 的 `sentMessages[0].id` 被寫入 `message_event_map`，`event_id` = 新建活動 id。
- [ ] **[D-020 AC-17]（送出點枚舉覆蓋）**：對 §5.3 表列的每一個分支各構造一次觸發，斷言
  `messageEventMap.record` 被以正確 `eventId` 呼叫一次；對「明確不附」清單中任一分支，斷言
  完全不呼叫 `record`。
- [ ] **[D-020 AC-18]（`名單` 不被較新 closed 活動蓋掉）**：群組同時有活動 A（id 較小、仍 open）
  與活動 B（id 較大、已 closed），`名單`（無 selector/引言，因 candidates.length===1 只有 A）
  → 顯示活動 A 的即時名單，**不是** B 的截止名單。
- [ ] **[D-020 AC-19]（0 候選時 `名單` 回退不變）**：群組目前 0 場 active、僅有 1 場歷史 closed
  活動 → `名單` 顯示該 closed 活動（`findLatestDisplayable` 回退，既有行為零回歸）。
- [ ] **[D-020 AC-20]（批次僅認第一行 selector）**：多場並行時，訊息 `@旭陽\n+1\n-1 陳先生`
  → 兩行皆作用於旭陽那場（單次消歧義，套用整批）。
- [ ] **[D-020 AC-21]（`下一輪` 不需 selector 即可用）**：多場並行、其中一場已啟動分組 session，
  該場主辦人於同群直接輸入 `下一輪`（無 `@selector`、無引言）→ 正常推進該場的分組（§5.5，
  不因 candidates>1 而要求消歧義）。
- [ ] **[D-020 AC-22]（`分組` 訊息可被 quote 且映射到正確活動）**：`分組`／`下一輪` 產生的訊息，
  其 `sentMessages[].id` 對映到 `GroupingState.eventId`（session 綁定的那場），非其他候選活動。
- [ ] **[D-020 AC-23]（授權判定作用於正確的已解析活動）**：多場並行，A 場 host 為甲、B 場 host
  為乙；甲於 `@B場地 取消活動` → 依 B 場的 `host_user_id` 判定甲非授權（`not_authorized`），
  不得誤用 A 場的授權放行。
- [ ] **[D-020 AC-24]（純函式性）**：`splitSelector`／`resolveTargetEvent`／`matchSelector` 對同一
  輸入呼叫兩次結果 deep-equal；三者皆不拋例外、不觸 DB（可靜態審查 import）。
- [ ] **[D-020 AC-25]（上限：剛好 3 場時第 4 場被拒，一行式與逐步問答皆同）**：群組已有 3 場
  `open` 活動。(a) 一行式 `開團 2026/09/01 08:00 某球場 10人 100元` → 回「此群組已有 3 場進行中
  的球敘，請等其中一場結束後再開新團」（逐字），**不寫 `conversation_states`**、不做任何查重
  判斷；(b) 逐步問答 `開團`（無參數）→ 回同一句，**不進入 `awaiting_date`**、不寫
  `conversation_states`。
- [ ] **[D-020 AC-26]（上限拒絕文案逐字比對，且不與查重訊息混用）**：`group_open_limit` 的回覆
  逐字等於「此群組已有 3 場進行中的球敘，請等其中一場結束後再開新團」、**不含**任何活動明細
  （日期／場地／時間皆不出現）；與 §3 查重訊息「已有相同時間地點的球敘」（`duplicate_event`）
  為兩則**不同**文案，測試須各自比對，不得互相替代。
- [ ] **[D-020 AC-27]（上限為動態計算，非寫死）**：群組有 3 場 `open` 活動達上限、第 4 次開團
  被 `group_open_limit` 擋下；其中一場經 `關閉報名`／`取消活動`（或自然過期被下次開團 flip 為
  `done`）後，候選數降為 2 → 之後的開團請求（一行式與逐步問答皆驗一次）**成功建立**、不再被
  `group_open_limit` 擋下（證明上限判斷即時依 `listActiveByGroup` 計數，非鎖定特定 event id 或
  固定次數）。
- [ ] **[D-020 AC-28]（跨群 quote 被安全拒絕，B1）**：群組 X 有 2 場 open 活動（需要消歧義的
  情境）；攻擊情境以直接寫入 `message_event_map` 模擬（因 LINE 用戶端實務上使用者無法跨群引言，
  測試不依賴該限制、直接構造資料層情境）一列 `event_id` 指向**群組 Y** 的某活動。群組 X 內使用者
  引用該筆 `message_id` 並回覆 `+1`（無 `@selector`）→ `quotedEventId` 被判定為未引言
  （`undefined`），行為等同「群組 X 有 2 場、無引言、無 selector」→ 回既有 `ambiguous` 提示
  （「群組內有多場球敘進行中...」），**訊息內容不含群組 Y 任一活動的場地／時間／id**；不呼叫
  任何 service、不誤判定到群組 Y 的活動、不 markProcessed。
- [ ] **[D-020 AC-29]（selector 停止詞與指令關鍵字同步，NIT-1）**：存在至少一條測試斷言
  `src/commands/parse.ts` 的全部指令頭關鍵字皆為 `splitSelector` 停止詞集合的子集；刻意在測試中
  新增一個不在停止詞集合內的假關鍵字時，該斷言必須失敗（證明測試確實有偵測力，非恆真斷言）。
- [ ] **[D-020 AC-30]（selectorRaw 超長回顯截斷，NIT-2）**：`selectorRaw` 長度 25 字元時，
  `not_found`/`too_many` 訊息中的 `{xxx}` 顯示為前 20 字元 + `…`（非原文 25 字元全文）；長度 ≤20
  時原樣顯示、不加 `…`（邊界零截斷）。

---

## 四、對既有文件的建議 errata（不直接修改，交 orchestrator 裁決）

| 文件 | 建議修改 |
|---|---|
| `docs/01-architecture.md` | 資料模型表：`ux_events_active_group` 一列改為兩列索引語意
  （新增 `ux_events_active_group_venue_time` 與 `message_event_map`）；併發章節可補一句
  「多場並行後，鎖定粒度仍是單一 event（`FOR UPDATE` 鎖該 event 列），group 層級不再有隱含互斥」；
  可補一句「同群 open 數上限（3 場）為應用層計數判斷，非 DB 約束（D-020 §3.5）」。 |
| `docs/02-api-contract.md` | 通用約定新增「`@selector` 前綴」一節（語法、判斷順序、四個新拒絕
  文案）；`關閉報名`/`取消活動`/`編輯`/`加開`/`分組`/`名單`/`+N`/`-N` 各列補充「多場並行時需消歧義」
  的備註；`開團` 列補充「同群同時最多 3 場 open，達上限回固定文案（不帶活動明細）」；REST 面不受影響。 |
| `design/D-001-data-model.md` | errata：§2「同一 `group_id` 同時最多一場 active 活動」、G3、
  §7 狀態機「active 集合...受 §2 partial unique index 約束（同 group 至多一場）」、AC-9 皆基於
  舊約束——D-020 已移除 `ux_events_active_group`，改以兩道獨立機制取代原「同群至多一場」角色：
  (a) `ux_events_active_group_venue_time`（場地+時間查重，DB 層安全網）(b) 同群 open 數上限 3 場
  （應用層計數，D-020 §3.5，非 DB 約束）。建議 §2/G3/§7/AC-9 各加註「已由 D-020 取代，詳見
  D-020 §1/§3.5」，不另改動本文件既有 DDL 文字（沿用既有 errata 慣例：不改 APPROVED 狀態、只加註）。 |
| `design/D-002-command-parser.md` | errata：新增 `splitSelector`（新檔 `selector.ts`）、
  白名單表新增 `＠→@`；註明 `parseCommand` 本身不變，`splitSelector` 是**前置**於它的獨立純函式。 |
| `design/D-004-event-creation.md` | errata：§4/§6「同群一場 active 約束」段落改寫為「開團查重
  （場地+時間）」；`CreateEntryResult`/`ConfirmResult` 的 `already_active` 更名 `duplicate_event`；
  訊息 (I)「已有進行中活動」文案改為「已有相同時間地點的球敘」；`startCreation` 移除入口早退檢查
  （**僅指查重**——上限早退檢查為新增例外，見下）。另新增獨立的 `group_open_limit`（同群 open
  數上限，D-020 §3.5）：`startCreation` **新增**入口早退檢查（本設計新增的例外，非移除）；
  `CreateEntryResult`/`ConfirmResult`/`ContinueFlowResult` 三者均新增此成員，與 `duplicate_event`
  並列不合併；固定文案「此群組已有 3 場進行中的球敘，請等其中一場結束後再開新團」逐字釘死、
  不帶活動明細。 |
| `design/D-006-admin-claiming.md` | errata：§1.1「唯一守門仍是同群單場（`findActiveByGroup`
  入口拒絕 + `確認` 撞 `ux_events_active_group` 安全網）」與 §1.2「授權需先 `findActiveByGroup`
  讀出 event 以取 `host_user_id`」兩處措辭已隨 D-020 過時——`findActiveByGroup` 已移除（G1），
  「同群單場」不再是開團的唯一守門（改為 D-020 §3.5 的 open 數上限 3 場 + §3 場地時間查重兩道
  機制）；`canManageEvent` 判定改讀 `events.getById(eventId)`（`eventId` 由 D-020 消歧義解出）。
  `canManageEvent` 謂詞本身（比對 `host_user_id`/super-admin）語意不變，僅資料讀取方式改變。 |
| `design/D-008-auto-release-slot.md` | errata：`findActiveByGroup` 相關敘述改為
  `listActiveByGroup` + 消歧義後 `getById`；「同群僅一場」相關措辭需標註「已由 D-020 取代」。 |
| `design/D-010-add-capacity.md` / `D-011-grouping.md` / `D-012-multiline-signup.md` | errata：
  三者呼叫 `findActiveByGroup` 之處改為消歧義後帶入 `eventId`；D-012 補充「`@selector` 僅認第一行」
  已由 D-002/D-020 承接，行為與原設計一致（批次選定活動後套用全批，語意未變，只是「選定」的
  方式從「唯一 active」變成「消歧義結果」）。 |
| `design/D-015-edit-event.md` | errata：`EditEventInput` 新增 `eventId?`；`EditEventResult.ok`
  新增 `eventId` 欄位（供 `message_event_map` 寫入）。 |

**為何 D-001／D-006 先前未列入本表（design-reviewer NIT-3 回應，2026-09-01）**：初版盤點聚焦於
直接呼叫 `findActiveByGroup` 的三份 service 設計文件（D-010/D-011/D-012）與直接受 schema/流程
變動影響的文件，遺漏了 D-001（schema 權威文件本身也描述「同群至多一場」規則，§2/G3/§7/AC-9）與
D-006（§1.1/§1.2 明文提及 `findActiveByGroup`／`ux_events_active_group` 作為開團守門角色）。經
review 提醒後已補齊上表兩列。**本表現涵蓋 9 個 row、11 份文件**（`01-architecture.md`、
`02-api-contract.md`、D-001、D-002、D-004、D-006、D-008、D-010、D-011、D-012、D-015）。

---

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 狀態 |
|---|---|---|
| 2026-08-31 | FR-8 / 決策 #9 逐項裁決（使用者） | 已定案，見 `docs/00-project-brief.md` |
| 2026-08-31 | D-014 ID 與既有 TLS 設計衝突 | 已裁決：本文件改號為 D-020，檔案搬移並同步內部引用（見文件頂端） |
| 2026-08-31 | 同群同時最多 3 場 open 活動（追加裁決） | 使用者裁決：新增獨立上限檢查（§3.5），與查重（§3）
  分開判斷（不同 result kind、不同訊息）；固定文案「此群組已有 3 場進行中的球敘，請等其中一場
  結束後再開新團」；不設 DB 唯一索引/CHECK（architect 評估後判定不需要，理由見 §3.5）；
  Guardrails 13→14（新增 G13）、AC 24→27（新增 AC-25~27）。 |
| 2026-09-01 | R2 雙審回覆（architect-reviewer B1 blocker + 2 nit；design-reviewer 文案 blocker
  + 3 nit） | architect 修訂本文件。**B1（跨群 quote 未驗證 group_id，唯一 blocker）**：採「dispatch
  層一次性校驗」方案（新增 G14、AC-28）——quote 解出的 `eventId` 於呼叫 `resolveTargetEvent` 之前
  先以 `events.getById` 比對 `group_id`，不符即視為未引言（落入既有 none/single/ambiguous 分支，
  不洩漏別群資訊）；`resolveTargetEvent`／`matchSelector` 維持純函式不變、service 層不需重複檢查
  （§5.1 已加註避免文件前後矛盾）。**architect-reviewer 2 nit 已採納**：§3.5「僅可能超出 1 場」
  改為「視同時並發請求數而定，非嚴格上界」；§5.1 補充 `closeEvent`/`cancelEvent` 雙層授權模式
  （交易外 early-return + 交易內權威重讀）明確保留、不得合併為一次查詢。**design-reviewer 文案
  blocker**：使用者已裁決保留原「有超過一場 {xxx} 的球敘，請修正再試」文案，本輪確認 §4.3/AC-10
  用字一致，無需修改內容，僅為確認。**design-reviewer 3 nit 全採納**：G-selector-sync「建議」
  改「必須」+ 新增 AC-29；`selectorRaw` 超長回顯新增截斷規則（20 字 + `…`）+ 新增 AC-30；§四
  errata 表補齊 D-001／D-006 兩份遺漏文件（原表 7 rows/9 docs → 現 9 rows/11 docs，並加註說明
  為何先前遺漏）。**Guardrails 14→15（新增 G14）；AC 27→30（新增 AC-28~30）**。狀態維持 DRAFT，
  待重新送雙審。 |
