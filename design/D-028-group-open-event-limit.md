# D-028: 同群 open 活動數上限 3 場

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §3.5 **逐字**切出，未改動任何已核可決定。
- AC 覆蓋：**待動工豁免**（**T-033c** 尚未動工；**動工時必須移除本行**，否則本檔 3 條 AC 不受檢＝假綠）。
- 風險等級：**R2（高）**——與 D-027 同批對使用者開燈；動 `src/domain/event-service.ts`（CLAUDE.md §4.5 高風險模組）。
- 來源：D-020 §3.5；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。同屬 T-033c 的並行文件：D-027（同批落地，不得只上其一）。

## 一、設計內容

> **〔切檔新增〕脈絡交叉引用**：本檔「不以 DB 約束加固上限、接受 race window」的論證，與 D-021
> §1「同群 open 數上限不在 0006 新增任何索引/約束」是同一個決定的兩面；兩份文件必須一起讀，
> 單讀本檔會以為 DB 層有遺漏。

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

## 二、Guardrails（Must NOT）

- **G13（上限與查重為獨立判斷，不可誤判為同一種拒絕）**：`group_open_limit`（§3.5 同群 open 數
  上限）與 `duplicate_event`（§3 場地+時間查重）**必須各自獨立判斷、各自獨立的 result kind、
  各自獨立的訊息文案**；不得共用同一個 result kind、不得在同一次判斷中把兩者合併為單一布林
  旗標、不得讓其中一種拒絕的判斷邏輯間接掩蓋另一種（例如上限已達卻仍先跑查重邏輯而回錯誤
  訊息，或反之）。`confirm`／`handleOneline` 皆須依 §3.5 定義的固定順序（**先上限、後查重**）
  判斷，不得任意調換、不得平行判斷後隨意取一結果。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-028 AC-25] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-25]` 會對不上）。

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
