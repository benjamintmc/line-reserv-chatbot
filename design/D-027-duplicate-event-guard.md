# D-027: 開團查重（取代舊的「已有 active 就拒絕」）

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §3 **逐字**切出，未改動任何已核可決定。
- AC 覆蓋：**待動工豁免**（**T-033c** 尚未動工；**動工時必須移除本行**，否則本檔 3 條 AC 不受檢＝假綠）。
- 風險等級：**R2（高）**——本檔移除開團入口的 `already_active` 拒絕，是多場並行**對使用者開燈**的那一步；動 `src/domain/event-service.ts`（CLAUDE.md §4.5 高風險模組）。
- 來源：D-020 §3；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。同屬 T-033c 的並行文件：D-028（同批落地，不得只上其一）。

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
