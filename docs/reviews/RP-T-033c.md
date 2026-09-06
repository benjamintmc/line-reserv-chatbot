# 審查包 — T-033c（開團查重 + 同群 open 上限 3 場）

- 任務：**T-033c** ／ 設計：**D-027 + D-028**（同批落地，不得只上其一）／ 風險：**R2**
- 分支：`feat/t-033c-duplicate-guard-and-limit`；實作 commit `66352f5` + 修正 commit `806bec4`
  + **R2 雙審 blocker 修正 commit `82bd449`**
  （基線 `ced4a86`；中間的 `ecad5cd`／`50502a0`／`108e298` 為 orchestrator 落的 D-027／D-028／D-029
  errata，非我的變更）
- **狀態**：已 push；**PR #26 已合併**（採 **merge** 非 squash，merge commit **`ac25ce4`**，CI 綠）；
  **尚未部署**——PROD 仍是 `:v10`／revision `00014-npk`（不含本批）。
- **審查請看 `git diff ced4a86..ac25ce4 -- src/`**（三個 commit 合併後的淨效果）；
  雙審後的增量單獨看 `git show 82bd449`。
- 變更檔案清單（12 檔）：

| 檔案 | 內容 |
|---|---|
| src/domain/event-service.ts | 三處入口/confirm 判定改寫 + 常數 + 型別改名；`82bd449`：`duplicate_event` 加選填 `event`、假鎖註解更正 |
| src/domain/event-formatter.ts | +15：`formatGroupCapacityReached()`；`82bd449`：`formatAlreadyActiveEntry` → `formatDuplicateEventEntry`（改名 + (I) 文案改句 + 刪指引句） |
| src/webhook/handler.ts | 3 case 改名 + 3 新 case + `duplicate_event` 錨點；`82bd449`：`renderContinue`／`renderConfirm` 依有無 `event` 分流 (I)／(L) |
| src/db/repositories/event-repository.ts | `82bd449` N-1：`ORDER BY id ASC` docstring 改述為介面排序契約（不再指涉已刪除的 `actives.at(-1)` 條文） |
| src/domain/event-duplicate-limit.test.ts | 新檔 +379：6 條新 AC + 4 條過期相位回歸鎖；`82bd449`：AC-3／AC-4／AC-5／AC-26 補逐字文案斷言 |
| src/webhook/event-handler.test.ts | +64：端到端文案接線；`82bd449`：新增 `[D-027 AC-4]` 端到端「`確認` 撞查重 → (I) 非 (L)」 |
| src/webhook/d029-emit-points.test.ts | +19：§5.3 新增列 + 「明確不附」清單 |
| src/domain/event-service.test.ts | AC-11 語意重寫 |
| src/domain/d008-auto-release.test.ts | AC-3 語意重寫、AC-6 排序 |
| src/domain/event-formatter.billing.test.ts | `82bd449`：`[D-005 AC-14]` 改用新函式名 + 補首句／指引句釘死 |
| src/domain/event-service.strengthen.test.ts / src/db/\_\_tests\_\_/d007-postgres.test.ts | 純改名 |

## 1. 變更摘要（≤ 5 行）

1. **D-027 查重**：`startCreation` 移除查重入口早退；`handleOneline` 入口應用層快速失敗（`location` 且 `event_datetime === taipeiToUtcIso(date,time)`）；`confirm` 交易內權威重讀候選集合再判一次；INSERT 撞 `ux_events_active_group_venue_time` 的 `23505` 窄捕捉**原樣保留**，只改回傳 kind。
2. **D-028 上限**：新增具名常數 `MAX_OPEN_EVENTS_PER_GROUP = 3`；`startCreation`／`handleOneline` 入口與 `confirm` 交易內三處皆以**應用層 COUNT** 即時判定 → `group_open_limit`。
3. **計數集合＝「未過期的 active」**（使用者裁決 2026-09-02，修正 `806bec4`）：入口以 `filter(!isExpired)` 取 `live`；`confirm` 交易內**先 flip 全部過期候選**再判上限/查重。詳見 §3(C)。
4. **型別**：三個 result 的 `already_active` → `duplicate_event`（`CreateEntryResult` 保留 `event`），三者各自新增 `group_open_limit`；順序固定**先上限、後查重**。
5. **文案／handler**：新增純函式 `formatGroupCapacityReached()`（逐字釘死、零明細）；(I) 查重文案的 formatter **已更名為 `formatDuplicateEventEntry`（不留 alias）**，首句改為設計指定的「**已有相同時間地點的球敘：**」+ 日期／場地／費用明細、**末行指引句整行刪除**（`event-formatter.ts:244-253`）；`renderCreateEntry/duplicate_event` 依 D-029 errata E1 補 `relatedEventId = result.event.id`。

> 註：本節第 5 點在 `bdeacf7` 版本原寫「`duplicate_event` 沿用既有 formatter 未動」——**那正是
> design-reviewer B-1 的成因描述**（把 (L) 的沿用豁免誤套到 (I)）。已於 `82bd449` 修正，敘述同步改為現況。

## 1.5 R2 雙審的兩個 blocker 與修法（修正 commit `82bd449`）

本包首版（停在 `bdeacf7`）送 R2 雙審後，**design-reviewer 與 architect-reviewer 各提一個 blocker，
經 orchestrator 逐條查證後兩條皆成立**（本專案第 2、3 次「BLOCK 屬實」）。兩者已於 `82bd449` 修畢。

**B-1（design-reviewer）：(I) 文案未依設計改句，且 `[D-027 AC-4]` 實際未被滿足。**

- `design/D-004-event-creation.md:73`／`design/D-020-multi-event-per-group.md:173`／
  `docs/00-project-brief.md:45`（FR-8）**三處明文**
  要求：(I) 的「已有進行中活動」文案**改為**「已有相同時間地點的球敘」，(L) race-lost **沿用**。
  首版把 (L) 的沿用豁免**誤套到 (I)**，且新測試把**舊文案釘死**（等於把錯誤鎖進回歸網）。
- **orchestrator 另查出 reviewer 沒提、但更嚴重的一點：`[D-027 AC-4]` 原本根本沒被滿足**——
  逐步問答 `確認` 撞到的是應用層的**確定性**查重（手上就有衝突列），卻被渲染成 (L)
  「手腳慢了一步！剛剛已有另一場活動成立」；而 AC-3／AC-4 的測試**只驗 `kind`、零文案斷言**
  ⇒ **AC 對照表上是 ✓、實際要求沒做到**。這是本包首版最該自我檢討的一點：AC 表的「✓」當時
  只證明了 kind，沒證明「回的是設計指定的那則訊息」。

**B-2（architect-reviewer B-1）：`confirm` 的新註解宣稱「鎖內權威重讀」，但根本沒有鎖。**

- `this.tx` 是 **DEFERRED runner**：`src/db/tx.ts:44` 明寫**不鎖 event**，`tx.ts:89` 的 `begin`
  是 `async () => {}`（不下任何 `LOCK`／`SELECT … FOR UPDATE`）。
- 比對 `git show ced4a86:src/domain/event-service.ts` 可確認「**鎖內**」二字是**本批新加**的誤述，
  非既有文字。
- **這是承 T-033a `FOR UPDATE` 誤述的同型第 2 次**（上一份交接 §3.2 已明文警告過仍然復發）。
  已回寫 `harness/LESSONS.md`（由 orchestrator 於 `108e298` 落筆）。

**修法（`82bd449`）：**

| 項目 | 修法 | 現況位置 |
|---|---|---|
| (I) formatter | `formatAlreadyActiveEntry` → **`formatDuplicateEventEntry`（不留 alias）**；首句改為「已有相同時間地點的球敘：」，保留 日期／場地／費用列，**刪除**末行指引句 | `event-formatter.ts:244-253`（doc-comment `:229-243`） |
| AC-4 走 (I) 而非 (L) | `ConfirmResult`／`ContinueFlowResult` 的 `duplicate_event` 改帶**選填** `event`：**應用層查重帶值** ⇒ handler 走 (I) + `relatedEventId` 錨點；**DB race-lost 不帶** ⇒ 走 (L)、**文案一字未動** | 型別 `event-service.ts:129`／`:142`；confirm 帶值 `:630-633`；race-lost 不帶 `:677`；轉傳 `:539-543`；handler 分流 `handler.ts:624-631`／`:646-650` |
| 假鎖註解 | 「鎖內權威重讀」→「**交易內權威重讀（DEFERRED runner，不鎖 event；`tx.ts:44`）**：查重殘餘 race 由 `ux_events_active_group_venue_time` 兜底；上限無 DB 約束，race window 依 D-028 由應用層承擔」，並加一句「**不得**寫成鎖內或宣稱任何併發保證」 | `event-service.ts:589-595`（已掃過本批全部新增註解，**無第二處**） |
| N-1（architect） | `event-repository.ts` 的 `ORDER BY id ASC` docstring 不再指涉已刪除的 `actives.at(-1)` 過渡條文，改述為**介面排序契約**、由 `[D-021 AC-2]` 鎖定 | `event-repository.ts:113-123` |
| 測試（把 AC 表的 ✓ 補實） | AC-3／AC-4 補**逐字**文案斷言；AC-5 釘死 race-lost 路徑**不帶** `event`；AC-26 改為證明「查重那則就是設計指定的那則」且**三則文案兩兩不同**；`event-handler.test.ts` 新增端到端「`確認` 撞查重 → (I) 非 (L)」；修掉三處釘死舊文案的斷言 | 見 §3 對照表 |

**`git show 82bd449` 已逐項核對，與上表一致**（該 commit 只動 7 檔：`event-repository.ts`、
`event-formatter.ts`、`event-service.ts`、`handler.ts` + 3 個測試檔，+134/−31）。

## 2. Guardrails 自檢表

> **行號基準：working tree 現況（含 `82bd449`）**。`bdeacf7` 版本的行號已因該 commit 位移，
> 下表全部重新 grep 過，不沿用舊值。

| Guardrail 條目 | 遵守？ | 證據（檔案:行） |
|---|---|---|
| **G7（D-027，查重兩層防護）**：應用層快速失敗 **與** DB 唯一索引安全網缺一不可 | ✓ | 應用層：`event-service.ts:451-464`（一行式入口 `live` filter + `entryDup` find）、`:596-608` + `:626-634`（confirm 交易內重讀 → flip → `live` → 查重）；DB 安全網：`:642` INSERT + `:668-677` catch 窄捕捉 |
| **G8（窄捕捉限定新索引名）**：必須比對 `ux_events_active_group_venue_time`，不得放寬為「任何 23505」 | ✓ | `event-service.ts:339-343`（`isActiveGroupUniqueViolation`，本批**全程未改動**，仍同時比對 `code==='23505'` **與** `constraint`）；回歸測試 `event-service.strengthen.test.ts:53`（其他 constraint 必 re-throw）、`:74`（目標 constraint 仍窄捕捉） |
| **G7 下半不得因應用層已擋而移除** | ✓ | `event-duplicate-limit.test.ts:183-193`：spy 停用應用層 pre-check（`listActiveByGroup` mock 回空集合）後，重複仍被 DB 擋下並窄捕捉為 `duplicate_event`；`82bd449` 另於 `:191` 釘死該路徑**不帶** `event`（⇒ handler 必走 (L)） |
| **G13（D-028，上限與查重各自獨立）**：獨立判斷／獨立 kind／獨立文案，固定「先上限、後查重」 | ✓ | 獨立 kind：`event-service.ts:103-104`（`CreateEntryResult`）、`:129-131`（`ContinueFlowResult`）、`:142-144`（`ConfirmResult`）；固定順序：`:451-464`（handleOneline）、`:610-634`（confirm）；獨立文案：`event-formatter.ts:266-268`（上限）vs `:244-253`（查重 (I)）vs `:307`（race-lost (L)）；順序證明測試：`event-duplicate-limit.test.ts:205-213`（第 4 場**刻意與既有場次同場地+時間**，仍必須回 `group_open_limit`） |
| **G1（D-021，無單值介面殘留，現無任何例外）** | ✓ | `grep -n "at(-1)\|length - 1" src/domain/event-service.ts` → **無命中**（§4 附實際輸出）；flip 改為走訪整個候選集合（`:604-606`），入口以 `filter` 取 `live`（`:412-415`／`:452-454`），未新增任何「回傳單一活動」的 wrapper；`82bd449` 並把 `event-repository.ts:113-123` 的 docstring 由「供 `actives.at(-1)` 取末列」改述為介面排序契約（N-1） |
| **CLAUDE.md §4 去重政策（`markProcessed` 位置）** | 入口＝例外 (b)（**orchestrator 已於 `50502a0` errata E2 明列並補進 §4**）；confirm＝預設消費 | 入口拒絕：`event-service.ts:416-418`（`startCreation` 上限）、`:455-457`（`handleOneline` 上限）、`:462-464`（`handleOneline` 查重）——三者皆在 `this.tx` 之前（`:420`／`:477`）、未 mark；confirm 內拒絕：`:587` 先 mark 且會一併提交 `:604-606` 的 flip 寫入 ⇒ 走預設政策（註記於 `:613-615`）。詳見 §3(A) |
| **球種中性** | ✓ | 兩則新／改文案僅用既有中性詞「球敘」（`event-formatter.ts:247` (I) 首句、`:267` 上限句）；未引入任何特定球種用語。`82bd449` 刪除的指引句亦無球種用語 |
| **不用 `any`、不吞例外** | ✓ | 全檔無 `any`（`event` 改為**選填**而非 `any`／型別放寬）；非目標 constraint 的 23505 與所有其他錯誤一律 re-throw（`event-service.ts:671`） |

## 3. Acceptance Checks 對照

> **行號基準同 §2：working tree 現況（含 `82bd449`）**，逐條重新 grep。
> **AC-3／AC-4 在首版只驗 `kind`（見 §1.5 B-1）；`82bd449` 後已有逐字文案斷言**，下表據實更新。

| AC | 測試位置（含 `[D-xxx AC-n]` 標記） | 斷言內容（`82bd449` 後） | 狀態 |
|---|---|---|---|
| [D-027 AC-3] 一行式快速失敗、不寫 `conversation_states` | `src/domain/event-duplicate-limit.test.ts:95`（`it` 起始） | `:104` `kind==='duplicate_event'`；`:106` 帶 `r.event.id === existing.id`；**`:109` 首行 `=== '已有相同時間地點的球敘：'`（`DUP_HEADLINE`，`:107-111` 逐字）**、`:110` 含 `場地：東方球場`、`:111` 含 `日期：2999-08-15 07:30`；`:113` **不含**「目前已有進行中的活動」、`:114` **不含**「取消活動」（指引句已刪）；`:116` **≠** `formatRaceLost().text`；零副作用 `:118-120`；`:122-135` 另驗「同場地不同時間／同時間不同場地皆放行」 | ✓ |
| [D-027 AC-4] 逐步問答於 `確認` 失敗、清該列、不 INSERT、**回同上訊息** | `src/domain/event-duplicate-limit.test.ts:137`；端到端 `src/webhook/event-handler.test.ts:146` | `:151` kind；`:155` `r.event?.id === existing.id`（應用層查重**必帶**衝突列）；**`:157` 首行 === `DUP_HEADLINE`**；**`:158` `confirmText === formatDuplicateEventEntry(existing).text`（逐字證明「與一行式同一則訊息」）**；`:159` ≠ race-lost；`:161-164` 清 conversation、不 INSERT。端到端 `event-handler.test.ts:162` 首行逐字、`:163` 含 `場地：東方球場`、**`:164` 不含「手腳慢了一步」（(L) 不得替代 (I)）**、`:165-166` 清流程且未新增第二場 | ✓ |
| [D-027 AC-5] DB 安全網：並發 `確認` 僅一成功，另一窄捕捉（非未捕捉例外） | `src/domain/event-duplicate-limit.test.ts:167` | `:189` kind；**`:191` race-lost 路徑 `r3.event` 必為 `undefined`**（⇒ handler 走 (L)、不附錨點）；`:192-193` 只有 1 場 active、落敗流程被清 | ✓ |
| [D-028 AC-25] 3 場時第 4 場被拒：(a) 一行式、(b) 逐步問答 | `src/domain/event-duplicate-limit.test.ts:198`；端到端 `src/webhook/event-handler.test.ts:107` | `:213`／`:220` 皆 `group_open_limit`（(a) 刻意同場地+時間 ⇒ 同時證明 G13 順序）；`:214-215`／`:221-222` 不寫 conversation、未 mark；端到端 `event-handler.test.ts:122`／`:129` 逐字 `=== LIMIT_TEXT` | ✓ |
| [D-028 AC-26] 上限文案逐字、不含明細、與查重文案不互相替代 | `src/domain/event-duplicate-limit.test.ts:228` | `:230` 上限句逐字；`:232-234` 七種明細字樣皆不出現；**`:244` 查重首行 === `DUP_HEADLINE`（改為證明「查重那則就是設計指定的那則」，不再只是「與上限不同」）**；`:249` **三則文案（上限／(I)／(L)）兩兩不同**（`Set.size === 3`）；`:250` 上限句不含 (I) 首句 | ✓ |
| [D-028 AC-27] 上限動態計算（`關閉報名`／`取消活動` 後降為 2 → 一行式與逐步問答各成功一次） | `src/domain/event-duplicate-limit.test.ts:253` | 降為 2 後兩入口各成功一次 | ✓ |
| [D-028 AC-27]（**過期相位**——AC-27 原文括號的「或自然過期被下次開團 flip 為 `done`」；修正 `806bec4` 新增 4 條） | `event-duplicate-limit.test.ts:305`（3 場全過期 → 兩入口皆放行＝**死鎖回歸鎖**）、`:327`（`確認` 後**三場皆** flip done 且新活動建立）、`:344`（2 未過期 + 1 過期 → 放行）、`:363`（3 場**未過期** → 仍 `group_open_limit`，確保上限沒被改鬆） | 見左欄各條 | ✓ |

**回歸測試處置（改名後仍具斷言力的說明）**：

- `[D-008 AC-3]`（`d008-auto-release.test.ts:123`）：舊版驗「未過期 open 就擋團」。改名後若只換字串會**失去斷言力**（新語意下該 fixture 的場地+時間與 draft 不同 ⇒ 根本不該擋）。故改以**與 draft 相同的場地+時間**構造，並把入口早退的驗證點由 `startCreation` 換成 `handleOneline`（`startCreation` 的查重早退已依 D-027 §3 移除）。仍驗「不 flip、不建立、清 conversation」。
- `[D-004 AC-11]`（`event-service.test.ts:251`）：同理改為「同場地+時間 → `duplicate_event`；場地不同或時間不同 → 放行」，斷言力**強於**舊版（舊版只證明會擋，未證明擋的是正確的那一種）。
- `[D-008 AC-6]`（`d008-auto-release.test.ts:190`）：`.sort()` 後字典序因改名由 `['already_active','created']` 變 `['created','duplicate_event']`，僅更新期望值。
- `[D-004 AC-12]`（`event-service.test.ts:306`／`:332`、`event-service.strengthen.test.ts:53`／`:74`）／`[D-007 AC-9]`：純字面改名，斷言標的（窄捕捉 constraint 判別）未變。
- `[D-005 AC-14]`（`event-formatter.billing.test.ts:107`，**`82bd449` 追加**）：原本把 (I) 舊文案間接釘死。改用 `formatDuplicateEventEntry`，**費用列 mode-aware 的斷言語意未變**（`:110-111`），另補 `:112` 首行逐字 `'已有相同時間地點的球敘：'` 與 `:113` 不含「取消活動」，避免文案再度漂移。
- `[D-029 AC-17]`（`d029-emit-points.test.ts:229` 新增 `renderCreateEntry/duplicate_event` 一列＝ errata E1 要求的錨點；`:343-348` 於「明確不附」清單補 `group_open_limit`）。

### 需 reviewer 裁定的取捨（§3 必列項）

**(A) 去重政策（`markProcessed` 位置）——我的判定：兩個「入口」的拒絕歸 CLAUDE.md §4 例外 (b)；`confirm` 內的同名拒絕走預設政策。兩者請分開看。**

- 入口事實：`startCreation`（`event-service.ts:416-418`）／`handleOneline`（`:455-457`）的 `group_open_limit` 與 `handleOneline` 的 `duplicate_event`（`:462-464`）都在 `this.tx(...)` 之前 early-return（交易分別起於 `:420`／`:477`），**查了 DB（`listActiveByGroup`）但零寫入副作用**（測試已釘：`event-duplicate-limit.test.ts:120`、`:215`、`:222` 斷言 `processed.has(mid) === false`）。
- 理由 1（設計明文）：D-027 AC-3 要求「**不寫 `conversation_states`**（**無 DB 副作用**）」、D-028 AC-25 同樣要求；`markProcessed` 是 DB 寫入，拒絕前 mark 會直接違反該 AC 字面。
- 理由 2（既有先例同型）：例外 (b) 現行成員 `closeEvent`／`cancelEvent` 的交易外 `not_authorized`（`event-service.ts:712`／`:756`）同樣**讀 DB（`getById` + `getByLineUserId`）而不寫**，本次兩種分支與其形狀一致，不是新型態。
- 代價（已知並接受，與 D-026 四種消歧義拒絕同款）：LINE 重送會重複回覆同一則提示；兩則皆純提示、無狀態變化。
- **程序要求已滿足（本包首版列為未滿足，現況已補）**：CLAUDE.md §4 要求「新增此類分支須在該設計文件明列」。orchestrator 已於 `50502a0` 落 D-027／D-028 **errata E2** 明列這三個分支，並同步把它們補進 CLAUDE.md §4 去重政策的窮舉清單（第 ③ 類「開團入口的早退拒絕」）。**裁定結果：歸例外 (b)，維持不 mark。**
- **`confirm` 內的兩種拒絕不屬於例外 (b)**，且修正 `806bec4` 後理由更強：它們位於帶 `markProcessed` 的同一交易內（`event-service.ts:587`），**且會一併提交上方過期 flip 的寫入**（`:604-606`）⇒ 明確走 §4 **預設**政策（拒絕回覆一律消費 message.id）。此區別已註記於程式碼（`:613-615`）。

**(B) `confirm` 的過期 flip 如何一般化——已由使用者裁決定案（2026-09-02），非待決項。** 舊碼是「取末列 active，過期則 flip done」。移除 `at(-1)` 後改為**走訪候選集合、逐一 flip 所有過期 active**（`event-service.ts:604-606`），且位置移到上限／查重**之前**（見 (C)）。依據：D-028 §3.5 明文把「過期被下次開團 flip 為 done」列為候選數下降途徑之一 ⇒ flip 不可刪除；多場並行後「那一場」已無定義，逐一 flip 是唯一不重新引入單場假設的一般化。`[D-008 AC-2]`（`d008-auto-release.test.ts:96`）綠佐證行為未退化，`event-duplicate-limit.test.ts:327` 直接釘死「**三場**過期候選皆 flip」。

**(C) ✅ 已修（blocker，修正 commit `806bec4`）：3 場「過期但未關閉」的 open 曾會讓群組永久鎖死。**

- 首版（`66352f5`）的上限計數用 `listActiveByGroup` 且**不濾過期**，而唯一的 flip 點在 `confirm` 交易內、排在上限**之後** ⇒ 候選數一到 3，兩個入口都在 `confirm` 之前擋下，flip 永不可達＝該群組再也開不了團；回的還是「已有 3 場**進行中**的球敘，請等其中一場**結束**」（三場其實都結束了）。成因是 T-033c 把 T-033a~b 入口條件裡的 `!isExpired(active, nowIso())` 整個拿掉，而首版測試自陳「日期一律用遠未來」⇒ 過期相位零覆蓋。由 orchestrator 驗收時實測發現。
- **使用者裁決（2026-09-02）**：①**過期活動不計入上限**；②**flip 全部過期候選**（維持既有實作，不退回「只 flip 最新一場」）。orchestrator 已據此落 D-027／D-028 errata E1（`ecad5cd`）。
- **落地**：入口 `startCreation`（`event-service.ts:412-418`）／`handleOneline`（`:451-464`）先 `filter((e) => !isExpired(e, now))` 取 `live` 再判上限；`handleOneline` 的**查重也只比對 `live`**（對一場已結束的活動回 `duplicate_event` 是同一種與事實不符的話）。入口**不 flip**（D-008 §1b）。`confirm` 交易內把 flip 迴圈移到上限**之前**，順序為 **flip 過期（`:604-606`）→（1）上限（`:618-621`）→（2）查重（`:626-634`）**，其後的 `conversation.delete`／INSERT 全部改吃 `live`（`:596-642`）。**G13 的「先上限、後查重」不變**，只是在它們之前多了 flip。
- **回歸鎖已驗證有效**（R2 慣例，比照 T-033b；行號為 `806bec4` 當時值，`82bd449` 後對應 `:305`／`:327`／`:344`／`:363`）：`git stash push -- src/domain/event-service.ts` 移除修正後重跑該測試檔 ⇒ **恰 3 條轉紅**（3 場全過期期望 `flow_started` 得 `group_open_limit`、`確認` 期望 `created` 得 `group_open_limit`、混合相位期望 `flow_started` 得 `group_open_limit`），其餘維持綠；第 4 條新測試（「3 場未過期仍 `group_open_limit`」）**刻意在兩版皆綠**——它驗的是「上限沒被改鬆」，若它也轉紅代表修正過頭。`git stash pop` 還原後全綠。

**(D) 文案中的「3」刻意寫死、不內插 `MAX_OPEN_EVENTS_PER_GROUP`**（`event-formatter.ts:262-264` 附理由）：文案是逐字釘死的使用者裁決，內插會讓常數一改就悄悄改動已釘死句子；且 formatter 維持零 domain 耦合。上限值若日後調整，屬需重新裁決文案的變更，兩處一併改。

**(E) 派工單的檔案路徑筆誤**：`formatGroupCapacityReached()` 落點寫的是 `src/line/event-formatter.ts`，該檔不存在；既有開團 formatter 實際在 **`src/domain/event-formatter.ts`**（`src/line/` 只有 LINE client）。已依實際慣例落在 domain 層。

**(F) D-029 §5.3 表與實作的對照結果（`82bd449` 後已由 orchestrator 以 errata E3 更新表格，見 `108e298`）。** `renderCreateEntry / duplicate_event` → `result.event.id`（已補，`handler.ts:578`）；`group_open_limit` 在「明確不附」清單內（`handler.ts:581`／`:633`／`:652`）。**`82bd449` 新增的分流**：`renderContinue`（`handler.ts:624-631`）與 `renderConfirm`（`:646-650`）的 `duplicate_event` 現在**二分**——帶 `event`（應用層確定性查重）⇒ (I) 文案 + `relatedEventId` 錨點；不帶（DB race-lost）⇒ (L) 文案、不附錨點。送出點的新增列由 orchestrator 落在 D-029 errata E3（設計文件不在我的寫入權範圍）。

## 3.5 diff 範圍自檢

- [x] §3 AC 對照表點名的每一個檔案都在本包 diff 中（`git diff ced4a86..ac25ce4 -- src/`，12 檔）
- [x] R2 已附全部受影響檔案的 diff，未以「與他任務共用」為由省略 hunk
- [x] 產 diff 用目錄層級路徑（`src/`）
- [x] 雙審後的增量（`82bd449`，7 檔 +134/−31）亦在同一區間內，可單獨以 `git show 82bd449` 複審

## 4. 機器關卡結果（本機實跑；**含 `82bd449` 的最終狀態**）

- [x] `npm run lint` → 0 problems
- [x] `npx tsc --noEmit` → 0 error；`npm run typecheck`（`tsconfig.test.json`，含測試檔）→ 0 error
- [x] `npm test` → **549 passed / 549（69 檔，零 skip）**；基線 537／68 ⇒ **+12 條**、+1 檔（首版 +7、`806bec4` 再 +4、`82bd449` 再 +1＝`[D-027 AC-4]` 端到端）
- [x] `npm run harness:check` → **AC 覆蓋 279/279**（基線 273/279）、doc_budget ✓、board_sync ✓
- [x] `bash harness/checks/check_commit_trace.sh` → ✓（三個 commit 皆寫 `T-033`，因 pattern `T-[0-9]+\)` 吃不下字母後綴）
- [x] **CI（PR #26）綠**；已合併為 merge commit `ac25ce4`（採 merge 非 squash，保留三個 commit 的可追溯性）
- [ ] **尚未部署**：PROD 仍是 `:v10`／revision `00014-npk`，不含本批

**D-021 errata E2 驗收硬指標（實際輸出）**：

```console
$ grep -n "at(-1)\|length - 1" src/domain/event-service.ts
$ echo $?
1
```

（無任何輸出、exit 1 = 無命中。註：`.at(-1)` 在測試輔助 `src/db/__tests__/test-db.ts:136` 等測試檔仍有使用，該條文射程限定 `src/domain/event-service.ts`。）

## 5. 需要 reviewer 特別留意的地方

1. **§1.5 的兩個 blocker 修法**（本輪複審主要標的）——請確認：(a) (I) 文案首句與明細列逐字符合設計、指引句確已整行刪除、`formatAlreadyActiveEntry` **無 alias 殘留**（`grep -rn "formatAlreadyActiveEntry" src/` 只剩 `event-formatter.ts:234` 一處**說明改名理由的註解**，零 export／零呼叫端）；(b) `duplicate_event` 的選填 `event` **只有** DB race-lost 路徑不帶（`event-service.ts:677`），其餘皆帶；(c) `confirm` 的註解不再有任何「鎖內」或併發保證的宣稱（`event-service.ts:589-595`）。
2. **§3(A) 去重政策歸類**——兩個**入口**的零寫入早退已由 orchestrator 以 errata E2（`50502a0`）裁定歸例外 (b) 並補進 CLAUDE.md §4 窮舉清單（第 ③ 類）。`confirm` 內的同名拒絕**不屬於**例外 (b)（走預設消費），兩者請分開看。
3. **§3(C) 的死鎖修正**——請確認「入口只數未過期 + `confirm` 先 flip 再判上限」沒有留下新的縫：入口與 `confirm` 對 `live` 的定義一致（皆 `!isExpired(e, now)`），且 `confirm` 的 `now` 取一次、flip 與 `live` 共用同一個時鐘值（`event-service.ts:597`），不會出現「已 flip 卻仍算進 live」或反之。
4. **§3(B) flip 的一般化**已由使用者裁決定案（flip 全部過期候選），列此僅供知悉判準來源，非待決項。
