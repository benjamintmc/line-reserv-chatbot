# 審查包 — T-033c（開團查重 + 同群 open 上限 3 場）

- 任務：**T-033c** ／ 設計：**D-027 + D-028**（同批落地，不得只上其一）／ 風險：**R2**
- 分支：`feat/t-033c-duplicate-guard-and-limit`；實作 commit `66352f5` + 修正 commit `806bec4`
  （基線 `ced4a86`；中間的 `ecad5cd` 為 orchestrator 落的 D-027／D-028 errata E1，非我的變更）
- **審查請看 `git diff ced4a86..HEAD -- src/`**（兩個 commit 合併後的淨效果）
- 變更檔案清單（10 檔）：

| 檔案 | 內容 |
|---|---|
| src/domain/event-service.ts | 三處入口/confirm 判定改寫 + 常數 + 型別改名 |
| src/domain/event-formatter.ts | +15：`formatGroupCapacityReached()` |
| src/webhook/handler.ts | 3 case 改名 + 3 新 case + `duplicate_event` 錨點 |
| src/domain/event-duplicate-limit.test.ts | 新檔 +345：6 條新 AC + 4 條過期相位回歸鎖 |
| src/webhook/event-handler.test.ts | +38：端到端文案接線 |
| src/webhook/d029-emit-points.test.ts | +19：§5.3 新增列 + 「明確不附」清單 |
| src/domain/event-service.test.ts | AC-11 語意重寫 |
| src/domain/d008-auto-release.test.ts | AC-3 語意重寫、AC-6 排序 |
| src/domain/event-service.strengthen.test.ts / src/db/\_\_tests\_\_/d007-postgres.test.ts | 純改名 |

## 1. 變更摘要（≤ 5 行）

1. **D-027 查重**：`startCreation` 移除查重入口早退；`handleOneline` 入口應用層快速失敗（`location` 且 `event_datetime === taipeiToUtcIso(date,time)`）；`confirm` 交易內權威重讀候選集合再判一次；INSERT 撞 `ux_events_active_group_venue_time` 的 `23505` 窄捕捉**原樣保留**，只改回傳 kind。
2. **D-028 上限**：新增具名常數 `MAX_OPEN_EVENTS_PER_GROUP = 3`；`startCreation`／`handleOneline` 入口與 `confirm` 交易內三處皆以**應用層 COUNT** 即時判定 → `group_open_limit`。
3. **計數集合＝「未過期的 active」**（使用者裁決 2026-09-02，修正 `806bec4`）：入口以 `filter(!isExpired)` 取 `live`；`confirm` 交易內**先 flip 全部過期候選**再判上限/查重。詳見 §3(C)。
4. **型別**：三個 result 的 `already_active` → `duplicate_event`（`CreateEntryResult` 保留 `event`），三者各自新增 `group_open_limit`；順序固定**先上限、後查重**。
5. **文案／handler**：新增純函式 `formatGroupCapacityReached()`（逐字釘死、零明細）；`duplicate_event` 沿用既有 formatter 未動；`renderCreateEntry/duplicate_event` 依 D-029 errata E1 補 `relatedEventId = result.event.id`。

## 2. Guardrails 自檢表

| Guardrail 條目 | 遵守？ | 證據（檔案:行） |
|---|---|---|
| **G7（D-027，查重兩層防護）**：應用層快速失敗 **與** DB 唯一索引安全網缺一不可 | ✓ | 應用層：`event-service.ts:450-456`（一行式入口）、`:610-616`（confirm 交易內）；DB 安全網：`:624` INSERT + `:653` 窄捕捉 |
| **G8（窄捕捉限定新索引名）**：必須比對 `ux_events_active_group_venue_time`，不得放寬為「任何 23505」 | ✓ | `event-service.ts:332-336`（`isActiveGroupUniqueViolation` **未改動**，仍同時比對 `code==='23505'` **與** `constraint`）；回歸測試 `event-service.strengthen.test.ts:53`（其他 constraint 必 re-throw） |
| **G7 下半不得因應用層已擋而移除** | ✓ | `event-duplicate-limit.test.ts:163-171`：spy 停用應用層 pre-check 後，重複仍被 DB 擋下並窄捕捉為 `duplicate_event` |
| **G13（D-028，上限與查重各自獨立）**：獨立判斷／獨立 kind／獨立文案，固定「先上限、後查重」 | ✓ | 獨立 kind：`event-service.ts:103-104`、`:125-137`；固定順序：`:448-456`（handleOneline）、`:601-616`（confirm）；獨立文案：`event-formatter.ts:254` vs `:231`；順序證明測試：`event-duplicate-limit.test.ts:181-190`（第 4 場**刻意與既有場次同場地+時間**，仍必須回 `group_open_limit`） |
| **G1（D-021，無單值介面殘留，現無任何例外）** | ✓ | `grep -n "at(-1)\|length - 1" src/domain/event-service.ts` → **無命中**（§4 附實際輸出）；flip 改為走訪整個候選集合（`:586-589`），入口以 `filter` 取 `live`（`:406-408`／`:445-447`），未新增任何「回傳單一活動」的 wrapper |
| **CLAUDE.md §4 去重政策（`markProcessed` 位置）** | 入口＝例外 (b)（請裁定）；confirm＝預設消費 | 入口拒絕：`event-service.ts:409-410`、`:448-456`（皆在 `this.tx` 之前，未 mark）；confirm 內拒絕：`:575` 先 mark 且提交 flip 寫入 ⇒ 走預設政策。詳見 §3(A) |
| **球種中性** | ✓ | 新文案僅用既有中性詞「球敘」（`event-formatter.ts:255`）；未引入任何特定球種用語 |
| **不用 `any`、不吞例外** | ✓ | 全檔無 `any`；非目標 constraint 的 23505 與所有其他錯誤一律 re-throw（`event-service.ts:653`） |

## 3. Acceptance Checks 對照

| AC | 測試位置（含 `[D-xxx AC-n]` 標記） | 狀態 |
|---|---|---|
| [D-027 AC-3] 一行式快速失敗、不寫 `conversation_states` | `src/domain/event-duplicate-limit.test.ts:90`（另驗「同場地不同時間／同時間不同場地皆放行」） | ✓ |
| [D-027 AC-4] 逐步問答於 `確認` 失敗、清該列、不 INSERT | `src/domain/event-duplicate-limit.test.ts:122` | ✓ |
| [D-027 AC-5] DB 安全網：並發 `確認` 僅一成功，另一窄捕捉（非未捕捉例外） | `src/domain/event-duplicate-limit.test.ts:144` | ✓ |
| [D-028 AC-25] 3 場時第 4 場被拒：(a) 一行式、(b) 逐步問答 | `src/domain/event-duplicate-limit.test.ts:173`；端到端另有 `src/webhook/event-handler.test.ts:107` | ✓ |
| [D-028 AC-26] 上限文案逐字、不含明細、與查重文案不互相替代 | `src/domain/event-duplicate-limit.test.ts:203` | ✓ |
| [D-028 AC-27] 上限動態計算（`關閉報名`／`取消活動` 後降為 2 → 一行式與逐步問答各成功一次） | `src/domain/event-duplicate-limit.test.ts:223` | ✓ |
| [D-028 AC-27]（**過期相位**——AC-27 原文括號的「或自然過期被下次開團 flip 為 `done`」；修正 `806bec4` 新增 4 條） | `event-duplicate-limit.test.ts:275`（3 場全過期 → 兩入口皆放行＝**死鎖回歸鎖**）、`:297`（`確認` 後**三場皆** flip done 且新活動建立）、`:314`（2 未過期 + 1 過期 → 放行）、`:333`（3 場**未過期** → 仍 `group_open_limit`，確保上限沒被改鬆） | ✓ |

**回歸測試處置（改名後仍具斷言力的說明）**：

- `[D-008 AC-3]`（`d008-auto-release.test.ts:123`）：舊版驗「未過期 open 就擋團」。改名後若只換字串會**失去斷言力**（新語意下該 fixture 的場地+時間與 draft 不同 ⇒ 根本不該擋）。故改以**與 draft 相同的場地+時間**構造，並把入口早退的驗證點由 `startCreation` 換成 `handleOneline`（`startCreation` 的查重早退已依 D-027 §3 移除）。仍驗「不 flip、不建立、清 conversation」。
- `[D-004 AC-11]`（`event-service.test.ts:248`）：同理改為「同場地+時間 → `duplicate_event`；場地不同或時間不同 → 放行」，斷言力**強於**舊版（舊版只證明會擋，未證明擋的是正確的那一種）。
- `[D-008 AC-6]`：`.sort()` 後字典序因改名由 `['already_active','created']` 變 `['created','duplicate_event']`，僅更新期望值。
- `[D-004 AC-12]`／`[D-007 AC-9]`：純字面改名，斷言標的（窄捕捉 constraint 判別）未變。
- `[D-029 AC-17]`：新增 `renderCreateEntry/duplicate_event` 一列（errata E1 要求的錨點），並在「明確不附」清單補 `group_open_limit`。

### 需 reviewer 裁定的取捨（§3 必列項）

**(A) 去重政策（`markProcessed` 位置）——我的判定：兩個「入口」的拒絕歸 CLAUDE.md §4 例外 (b)；`confirm` 內的同名拒絕走預設政策。兩者請分開看。**

- 入口事實：`startCreation`／`handleOneline` 的 `group_open_limit` 與 `handleOneline` 的 `duplicate_event` 都在 `this.tx(...)` 之前 early-return，**查了 DB（`listActiveByGroup`）但零寫入副作用**（測試已釘：`event-duplicate-limit.test.ts:105`、`:190`、`:197` 斷言 `processed.has(mid) === false`）。
- 理由 1（設計明文）：D-027 AC-3 要求「**不寫 `conversation_states`**（**無 DB 副作用**）」、D-028 AC-25 同樣要求；`markProcessed` 是 DB 寫入，拒絕前 mark 會直接違反該 AC 字面。
- 理由 2（既有先例同型）：例外 (b) 現行成員 `closeEvent`／`cancelEvent` 的交易外 `not_authorized`（`event-service.ts:694`／`:738` 附近）同樣**讀 DB（`getById` + `getByLineUserId`）而不寫**，本次兩種分支與其形狀一致，不是新型態。
- 代價（已知並接受，與 D-026 四種消歧義拒絕同款）：LINE 重送會重複回覆同一則提示；兩則皆純提示、無狀態變化。
- **程序要求尚未滿足**：CLAUDE.md §4 要求「新增此類分支須在**該設計文件**明列」。D-027／D-028 目前沒有這段。設計文件不在我的寫入權範圍 ⇒ **請 orchestrator 補 errata 明列這三個分支**（或裁定改為「拒絕前先 mark」，但那與兩份文件的 AC 字面衝突，需一併改 AC）。已寫入我的 worklist。
- **`confirm` 內的兩種拒絕不屬於例外 (b)**，且修正 `806bec4` 後理由更強：它們位於帶 `markProcessed` 的同一交易內（`event-service.ts:575`），**且會一併提交上方過期 flip 的寫入**（`:586-589`）⇒ 明確走 §4 **預設**政策（拒絕回覆一律消費 message.id）。此區別已註記於程式碼（`:593-597`）。

**(B) `confirm` 的過期 flip 如何一般化——已由使用者裁決定案（2026-09-02），非待決項。** 舊碼是「取末列 active，過期則 flip done」。移除 `at(-1)` 後改為**走訪候選集合、逐一 flip 所有過期 active**（`event-service.ts:586-589`），且位置移到上限／查重**之前**（見 (C)）。依據：D-028 §3.5 明文把「過期被下次開團 flip 為 done」列為候選數下降途徑之一 ⇒ flip 不可刪除；多場並行後「那一場」已無定義，逐一 flip 是唯一不重新引入單場假設的一般化。`[D-008 AC-2]` 綠佐證行為未退化，`event-duplicate-limit.test.ts:297` 直接釘死「**三場**過期候選皆 flip」。

**(C) ✅ 已修（blocker，修正 commit `806bec4`）：3 場「過期但未關閉」的 open 曾會讓群組永久鎖死。**

- 首版（`66352f5`）的上限計數用 `listActiveByGroup` 且**不濾過期**，而唯一的 flip 點在 `confirm` 交易內、排在上限**之後** ⇒ 候選數一到 3，兩個入口都在 `confirm` 之前擋下，flip 永不可達＝該群組再也開不了團；回的還是「已有 3 場**進行中**的球敘，請等其中一場**結束**」（三場其實都結束了）。成因是 T-033c 把 T-033a~b 入口條件裡的 `!isExpired(active, nowIso())` 整個拿掉，而首版測試自陳「日期一律用遠未來」⇒ 過期相位零覆蓋。由 orchestrator 驗收時實測發現。
- **使用者裁決（2026-09-02）**：①**過期活動不計入上限**；②**flip 全部過期候選**（維持既有實作，不退回「只 flip 最新一場」）。orchestrator 已據此落 D-027／D-028 errata E1（`ecad5cd`）。
- **落地**：入口 `startCreation`（`event-service.ts:405-411`）／`handleOneline`（`:444-456`）先 `filter((e) => !isExpired(e, now))` 取 `live` 再判上限；`handleOneline` 的**查重也只比對 `live`**（對一場已結束的活動回 `duplicate_event` 是同一種與事實不符的話）。入口**不 flip**（D-008 §1b）。`confirm` 交易內把 flip 迴圈移到上限**之前**，順序為 **flip 過期 →（1）上限 →（2）查重**，其後的上限／查重／`conversation.delete`／INSERT 全部改吃 `live`（`:586-624`）。**G13 的「先上限、後查重」不變**，只是在它們之前多了 flip。
- **回歸鎖已驗證有效**（R2 慣例，比照 T-033b）：`git stash push -- src/domain/event-service.ts` 移除修正後重跑該測試檔 ⇒ **恰 3 條轉紅**（`:275` 期望 `flow_started` 得 `group_open_limit`、`:297` 期望 `created` 得 `group_open_limit`、`:314` 期望 `flow_started` 得 `group_open_limit`），其餘 7 條維持綠；第 4 條新測試（`:333`「3 場未過期仍 `group_open_limit`」）**刻意在兩版皆綠**——它驗的是「上限沒被改鬆」，若它也轉紅代表修正過頭。`git stash pop` 還原後 10/10 綠。

**(D) 文案中的「3」刻意寫死、不內插 `MAX_OPEN_EVENTS_PER_GROUP`**（`event-formatter.ts:250-253` 附理由）：文案是逐字釘死的使用者裁決，內插會讓常數一改就悄悄改動已釘死句子；且 formatter 維持零 domain 耦合。上限值若日後調整，屬需重新裁決文案的變更，兩處一併改。

**(E) 派工單的檔案路徑筆誤**：`formatGroupCapacityReached()` 落點寫的是 `src/line/event-formatter.ts`，該檔不存在；既有開團 formatter 實際在 **`src/domain/event-formatter.ts`**（`src/line/` 只有 LINE client）。已依實際慣例落在 domain 層。

**(F) D-029 §5.3 表與實作的對照結果：一致，無需修表。** `renderCreateEntry / duplicate_event` → `result.event.id`（已補）；`group_open_limit` 已在「明確不附」清單內；`renderContinue`／`renderConfirm` 的 `duplicate_event`（race-lost，不帶明細）維持不附錨點，與表列一致（表中本就無該兩列）。

## 3.5 diff 範圍自檢

- [x] §3 AC 對照表點名的每一個檔案都在本包 diff 中（`git diff ced4a86..HEAD -- src/`）
- [x] R2 已附全部受影響檔案的 diff，未以「與他任務共用」為由省略 hunk
- [x] 產 diff 用目錄層級路徑（`src/`）

## 4. 機器關卡結果（本機實跑，2026-09-02；修正 `806bec4` 後重跑）

- [x] `npm run lint` → 0 problems
- [x] `npx tsc --noEmit` → 0 error；`npm run typecheck`（`tsconfig.test.json`，含測試檔）→ 0 error
- [x] `npm test` → **548 passed / 548（69 檔，零 skip）**；基線 537／68 ⇒ **+11 條**、+1 檔（首版 +7、修正再 +4）
- [x] `npm run harness:check` → **AC 覆蓋 279/279**（基線 273/279）、doc_budget ✓、board_sync ✓
- [x] `bash harness/checks/check_commit_trace.sh` → ✓（兩個 commit 皆寫 `T-033`，因 pattern `T-[0-9]+\)` 吃不下字母後綴）

**D-021 errata E2 驗收硬指標（實際輸出）**：

```console
$ grep -n "at(-1)\|length - 1" src/domain/event-service.ts
$ echo $?
1
```

（無任何輸出、exit 1 = 無命中。註：`.at(-1)` 在測試輔助 `src/db/__tests__/test-db.ts:136` 等測試檔仍有使用，該條文射程限定 `src/domain/event-service.ts`。）

## 5. 需要 reviewer 特別留意的地方

1. **§3(A) 去重政策歸類**——兩個**入口**的零寫入早退我判定歸例外 (b)，請裁定；若成立需 orchestrator 在 D-027／D-028 補 errata 明列（我無設計文件寫入權）。`confirm` 內的同名拒絕**不屬於**例外 (b)（走預設消費），兩者請分開看。
2. **§3(C) 的死鎖修正**——請確認「入口只數未過期 + `confirm` 先 flip 再判上限」沒有留下新的縫：入口與 `confirm` 對 `live` 的定義一致（皆 `!isExpired(e, now)`），且 `confirm` 的 `now` 取一次、flip 與 `live` 共用同一個時鐘值（`event-service.ts:579`），不會出現「已 flip 卻仍算進 live」或反之。
3. **§3(B) flip 的一般化**已由使用者裁決定案（flip 全部過期候選），列此僅供知悉判準來源，非待決項。
