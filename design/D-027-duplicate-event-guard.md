# D-027: 開團查重（取代舊的「已有 active 就拒絕」）

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §3 **逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——本檔移除開團入口的 `already_active` 拒絕，是多場並行**對使用者開燈**的那一步；動 `src/domain/event-service.ts`（CLAUDE.md §4.5 高風險模組）。
- 來源：D-020 §3；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。同屬 T-033c 的並行文件：D-028（同批落地，不得只上其一）。

## errata E1（2026-09-02，T-033c 驗收發現；隨 D-028 errata E1 同批生效）

> **查重的候選範圍同樣排除「已過期但仍為 `open`」的活動。** §3 的
> `candidates = listActiveByGroup(groupId)` 於 `handleOneline` 入口與 `confirm` 交易內，
> 一律先濾掉 `isExpired` 者再比對場地+時間——理由與 D-028 errata E1 同源：對一場**已結束**的活動
> 回「已有相同時間地點的球敘」是同一種不實陳述。
>
> `confirm` 內的過期候選會在判斷前先 flip 為 `done`（見 D-028 errata E1 的順序：
> **flip 過期 → 判上限 → 判查重**），故該路徑濾除與 flip 的結果一致。
>
> **G7 的兩層防護不受影響**：`ux_events_active_group_venue_time` 的 predicate 為
> `status IN ('draft','open')`，過期候選 flip 為 `done` 後即退出索引範圍，DB 安全網那一層
> （G7 下半 / G8 窄捕捉）**維持原樣、不得移除或放寬**。
>
> **本節由 orchestrator 落筆，尚未經原設計 agent 確認。**

## errata E2（2026-09-02，去重政策明列；依 CLAUDE.md §4「新增此類分支須在該設計文件明列」）

> **`handleOneline` 入口的 `duplicate_event` 歸 CLAUDE.md §4 去重政策的例外 (b)；`確認` 交易內與
> DB 窄捕捉路徑的 `duplicate_event` 走預設政策（消費 `message.id`）。** 由 orchestrator 裁定，
> 判準與 D-028 errata E2 同源，該表為權威，此處不重複。
>
> **本分支不是新增的例外，是既有成員的改名**：T-033c 之前，`startCreation`／`handleOneline` 入口的
> `already_active` 早退同樣位於 `this.tx` 之前、零寫入 ⇒ 早已屬例外 (b)。**惟 CLAUDE.md §4 的
> 「現況為…」枚舉從未列入它**——該枚舉在 T-033c 之前即已不完整，非本任務造成，已登記 Backlog。
>
> AC-3 明文要求本分支「**不寫 `conversation_states`**（**無 DB 副作用**）」，與上述分類一致。
>
> **本節由 orchestrator 落筆。**

## errata E3（2026-09-06，R2 複審 design-reviewer N-1；**假鎖宣稱更正，本節取代 §3 對應敘述**）

> **§3 `confirm` 段落的「（鎖內權威重讀候選集合…）」中的「鎖內」二字為誤述，本節更正為
> 「交易內權威重讀」。** `confirm` 走的是 `EventServiceDeps.runInTransaction`＝
> `tx.ts:87-90` 的 **DEFERRED runner**，其 `begin` 為 `async () => {}`，**不鎖任何列**
> （`tx.ts:44` docstring 明寫「不鎖 event」）。交易本身在 PG 預設 READ COMMITTED 下
> **不會**阻止另一個 session 做同樣的讀 ⇒ 兩個並行 `確認` 可能都讀到「無重複」。
>
> **真正提供保證的是 DB 唯一索引** `ux_events_active_group_venue_time`
> （`src/db/migrations/0006_multi_event_per_group.sql:21`）：INSERT 撞 23505 → 窄捕捉 →
> 回 (L) race-lost。交易內重讀的作用是**縮小 race window 並給出帶明細的 (I) 文案**，
> **不是**消除競態。兩層缺一不可（G7）。
>
> **對照**：全專案唯一真的有列鎖的路徑是 `editEvent`，走 `createImmediateRunner`
> （`tx.ts:93-101`，begin 下 `SELECT id FROM events WHERE id=$1 FOR UPDATE`）。
> `confirm`／`closeEvent`／`cancelEvent` 三者**皆無列鎖**。
>
> **為何列為 errata 而非筆誤**：本專案已因「對不存在的鎖做併發保證宣稱」犯錯 **3 次**
> （T-033a 誤述 `FOR UPDATE`；T-033c `confirm` 註解，`82bd449` 已修；本節）。
> 程式碼 `event-service.ts:589-595` 現已明寫「**不得**把這次重讀寫成『鎖內』或宣稱任何併發保證」
> ——**設計文件不同步更正，下一位實作者會照著設計把正確的註解改回去**。
> 已回寫 `harness/LESSONS.md`，並於 `.claude/agents/architect-reviewer.md` 增列固定檢查項
> （使用者裁決 2026-09-06）。
>
> **附帶更正（同 N-2）**：本檔如有以 `formatAlreadyActiveEntry` 指涉 (I) 文案者，該函式已於
> `82bd449` 更名為 **`formatDuplicateEventEntry`**（不留 alias）。
>
> **附帶更正（errata E2 的狀態）**：E2 末段稱 CLAUDE.md §4 的「現況為…」枚舉不完整、
> 「已登記 Backlog」——該枚舉**已於 2026-09-06 由使用者裁決補列**（開團入口早退與批次 G6 皆已入列，
> 並修正了「不呼叫任何 service」這句與現況不符的判準）。E2 其餘內容不變。
>
> **本節由 orchestrator 落筆。**

## 一、設計內容

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

## 二、Guardrails（Must NOT）

- **G7（查重兩層防護）**：開團查重必須同時具備**應用層快速失敗**（一行式入口 / 逐步問答
  `確認` 前查詢）與 **DB 唯一索引安全網**（`ux_events_active_group_venue_time` 撞唯一違反時
  窄捕捉），不得只做其中一層（比照 D-004 §4/§6 既有模式）。
- **G8（〔切檔新增〕引用繼承，不重新定義）**：G8「窄捕捉限定新索引名」的完整條文見 D-021，已隨
  T-033a 與 0006 一併落地。本任務新增的應用層查重**不得**取代、放寬或繞過 `confirm()` 對
  `ux_events_active_group_venue_time` 的窄捕捉——G7 所要求的「DB 唯一索引安全網」那一層即由該窄
  捕捉實現，兩者是同一道防護的上下半，不得因應用層已擋就移除下半。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-027 AC-3] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-3]` 會對不上）。

- [ ] **[D-020 AC-3]（開團查重：一行式快速失敗）**：群組已有一場 open「東方球場 2026-08-15
  07:30」，再次 `開團 2026/08/15 07:30 東方球場 …` → 回「已有相同時間地點的球敘」、
  **不寫 `conversation_states`**（無 DB 副作用）。
- [ ] **[D-020 AC-4]（開團查重：逐步問答於確認時失敗）**：逐步問答填完與現有活動場地+時間相同
  的欄位、輸入 `確認` → 回同上訊息、`conversation_states` 該列被清除、不 INSERT 新 event。
- [ ] **[D-020 AC-5]（查重 DB 安全網）**：兩個使用者並發完成「場地+時間相同」的逐步問答並同時
  `確認` → 僅一人成功 INSERT，另一人捕捉 `ux_events_active_group_venue_time` 違反並回
  `duplicate_event`（非未捕捉例外）。
