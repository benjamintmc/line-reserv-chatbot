# 審查包（Review Packet）— T-033a

- 任務：**T-033a**（解除單場限制 + 消歧義全鏈路 + `名單` 回退）
  ／設計：**D-021、D-022、D-023、D-024、D-026**（umbrella D-020）／風險：**R2**
- 分支：`feat/t-033a-multi-event-unlock`（自 `d876afc`）；未 push、未開 PR
- 變更檔案清單（`git diff --stat` + 新檔）：**43 檔／+678 −313**（不含新檔內容）

**新增（8）**
| 檔案 | 內容 |
|---|---|
| `src/db/migrations/0006_multi_event_per_group.sql` | D-021 §1 逐字：DROP 舊索引、建 `ux_events_active_group_venue_time`、`message_event_map` + `ix_message_event_map_event` |
| `src/commands/selector.ts` | `splitSelector` + `SELECTOR_STOP_KEYWORDS`（D-024 §4.2） |
| `src/domain/event-disambiguation.ts` | `resolveTargetEvent` + `matchSelector`（D-023 §4.3） |
| `src/domain/disambiguation-formatter.ts` | 四個 formatter + `truncateForDisplay`（使用者 2026-09-02 裁決之新檔） |
| `src/commands/__tests__/selector.test.ts` | splitSelector 單測 + `[D-024 AC-29]` |
| `src/domain/event-disambiguation.test.ts` | 純函式單測 + `[D-024 AC-24]`、`[D-024 AC-30]` |
| `src/db/__tests__/d021-schema-unlock.test.ts` | `[D-021 AC-1]`、`[D-021 AC-2]` |
| `src/webhook/handler.disambiguation.test.ts` | 全鏈路 12 條 AC |

**修改（生產碼 9）**：`src/db/repositories/event-repository.ts`（`EventReader` 換介面）、
`src/db/schema.ts`／`src/db/tx.ts`（僅過時註解）、`src/domain/event-service.ts`（8 呼叫端 + G8 窄捕捉）、
`src/domain/grouping-service.ts`（2）、`src/domain/registration-service.ts`（2 + G9 回退）、
`src/webhook/handler.ts`（D-026 §5.2 管線）、`src/server.ts`（注入 `events`）、`scripts/seed-open-event.ts`。

**修改（測試/夾具 26）**：D-020 §一 窮舉表 7 處（舊索引名／fixture 語意）＋因介面變更而必須帶
`eventId` 的 domain 層測試呼叫端（新增共用 helper `activeEventId`，見 §5 第 1 點）。

## 1. 變更摘要（≤ 5 行）
0006 移除「同群至多一場 active」的 DB 硬限制，換上「同群 active 內場地+時間唯一」並建 `message_event_map`（本批只建表、不寫入）。
`EventReader.findActiveByGroup` **整個移除**，改為 `listActiveByGroup`（`ORDER BY id ASC`）；12 個呼叫端中 9 處改走
「handler 解出 `eventId` → service `getById(eventId)`」通用模式，開團側 3 處依 D-021 §1 過渡條文內聯 `actives.at(-1)`。
`handler.ts` 依 D-026 §5.2 插入 `splitSelector → parseCommand → listActiveByGroup → resolveTargetEvent` 管線，四種拒絕直接回覆。
`getListView` 依 D-022 改為「候選 ≥1 用 `eventId`、只有 ===0 才回退 `findLatestDisplayable`」。

## 2. Guardrails 自檢表

| Guardrail 條目 | 遵守？ | 證據（檔案:行） |
|---|---|---|
| **G1** `EventReader` 不得留 `findActiveByGroup` 或任何回傳單一活動的預設路徑；唯一例外＝開團側三處內聯 `actives.at(-1)` | ✓ | 介面只剩 `getById`/`listActiveByGroup`/`findLatestDisplayable`：`src/db/repositories/event-repository.ts:34-43`。全 repo 生產碼 `grep -rn "findActiveByGroup" src --include=*.ts` 僅命中**註解**。D-021 §1 clause 3 的驗收 grep `grep -n "at(-1)\|length - 1" src/domain/event-service.ts` → 恰 3 個 code 命中：`:360`（`startCreation`）、`:389`（`handleOneline`）、`:515`（`confirm`），無第四處、未抽成共用函式/方法 |
| **G2** `resolveTargetEvent` 判斷順序不得重排；`candidates.length <= 1` 必須最先判斷且完全略過 selector／quote 的解析與驗證 | ✓ | `src/domain/event-disambiguation.ts:148-155`（`length===0`／`===1` 為函式第一段，`matchSelector` 只在 `>1` 分支才被呼叫）。反向驗證：`event-disambiguation.test.ts`「候選 0 → none；候選 1 → single」——帶錯 selector、帶不相干 quote 皆仍回 `single` |
| **G5** `splitSelector` 只動白名單字元（本次新增 `＠→@`），不做整串 NFKC | ✓ | `src/commands/normalize.ts:41-42`（併入既有 `normalizeWhitelist` 同一張表，非新開規則）；`src/commands/selector.ts:82` 只呼叫 `normalizeWhitelist`。測試：`selector.test.ts`「全形 ＠…；不做整串 NFKC」（全形括號原樣保留） |
| **G6** `splitSelector` 不觸 DB、不判候選、不決定回覆；`resolveTargetEvent`／`matchSelector` 不收 `groupId`、不查 DB | ✓ | 兩檔皆無 `await`／無 repository import（`[D-024 AC-24]` 內含靜態 import 稽核，`event-disambiguation.test.ts` 末段）。簽名無 `groupId`：`event-disambiguation.ts:96-100,140-145` |
| **G8** `confirm()` 窄捕捉必須比對**新**約束名，不得寬鬆判 23505 | ✓ | `src/domain/event-service.ts:279-289`：`e.code === '23505' && e.constraint === 'ux_events_active_group_venue_time'`。既有 `[D-004 AC-12]` 兩處＋`[D-007 AC-9]` 已同步改為新索引名，且保留「23505 但別的 constraint → re-throw」反向案例 |
| **G9** `getListView` 不得在候選數未知時直接呼叫 `findLatestDisplayable` | ✓ | `src/domain/registration-service.ts` `findEventForDisplay`：`eventId !== undefined`（＝dispatch 已判定候選 ≥1）走 `getById`；**只有** `undefined`（＝`resolution.kind==='none'`＝候選 0）才回退。ambiguous/conflict/not_found/too_many 於 dispatch 短路、根本到不了 service（`handler.ts` `resolveEventForCommand`）。測試 `[D-022 AC-18]`／`[D-022 AC-19]` |
| **G11** `下一輪` 不得跑消歧義 | ✓ | `NEEDS_EVENT_SET` **不含** `group_next`（`src/webhook/handler.ts:133-152`）；`NextRoundInput` 刻意不加 `eventId`（`src/domain/grouping-service.ts` 該介面 doc-comment）。測試 `[D-026 AC-21]` |
| **G12** 批次第 2 行以後不得用新的 `@` 切換活動 | ✓ | `handleEvent` 對整段原文呼叫 `splitSelector` **一次**、且在 `\r?\n` 拆行**之前**（`handler.ts:1195-1204`）；`handleBatch` 只解一次 `eventId` 並套用整批迴圈。測試 `[D-026 AC-20]` |
| **G14** 跨群校驗只設在 dispatch 層一處；service 內 `getById(eventId)` 不重複比對 `group_id` | ✓ | 唯一實作 `resolveQuotedEventInGroup`（`handler.ts` 模組層）；三個 service 的 `getById(eventId)` 後皆無 `group_id` 比對（`grep -n "group_id" src/domain/*-service.ts` 無新增比對） |
| **`closeEvent`／`cancelEvent` 雙層授權模式維持不變**（交易外 early-return + 交易內 `FOR UPDATE` 權威重讀，兩次查詢都保留，不得合併） | ✓ | `event-service.ts` `closeEvent`：交易外 `this.events.getById(eventId)` → `canManageEvent` → 交易內 `repos.events.getById(eventId)`；`cancelEvent` 同構。兩處各自保留 `isExpired`／status 重檢 |
| **G10**（不動 `conversation_states`）| ✓ | migration 0006 未觸及該表；`handler.ts` 的 conversation 攔截區塊零改動，`splitSelector` 置於其**之後** |
| 不加回 AC 豁免行、不改設計文件 | ✓ | `git diff --stat -- design/ harness/` 空輸出 |

## 3. Acceptance Checks 對照

| AC | 測試位置（含標記） | 狀態 |
|---|---|---|
| D-021 AC-1（migration 結構） | `src/db/__tests__/d021-schema-unlock.test.ts` `[D-021 AC-1]` | PASS |
| D-021 AC-2（同群多場並存 + id 升冪） | 同上 `[D-021 AC-2]`（**repository 層**連續 `events.create`，非開團流程） | PASS |
| D-022 AC-18（`名單` 不被較新 closed 蓋掉） | `src/webhook/handler.disambiguation.test.ts` `[D-022 AC-18]` | PASS |
| D-022 AC-19（0 候選回退不變） | 同上 `[D-022 AC-19]` | PASS |
| D-023 AC-6（單場零回歸：裸 `+1`／亂打 selector／引用無關訊息） | 同上 `[D-023 AC-6]` | PASS |
| D-023 AC-8（`@selector` 命中恰一場） | 同上 `[D-023 AC-8]` | PASS |
| D-023 AC-11（場地+日期組合） | 同上 `[D-023 AC-11]` | PASS |
| D-023 AC-12（日期不夠精準 → 補時間窄化） | 同上 `[D-023 AC-12]` | PASS |
| D-024 AC-9（命中 0 場文案） | 同上 `[D-024 AC-9]` | PASS |
| D-024 AC-10（命中 >1 場文案） | 同上 `[D-024 AC-10]` | PASS |
| D-024 AC-24（三函式純函式性 + 靜態 import 稽核） | `src/domain/event-disambiguation.test.ts` `[D-024 AC-24]` | PASS |
| D-024 AC-29（停止詞 ⊇ `parse.ts` 關鍵字，且斷言具偵測力） | `src/commands/__tests__/selector.test.ts` `[D-024 AC-29]` | PASS |
| D-024 AC-30（selectorRaw 超長截斷 20 + `…`，邊界零截斷） | `src/domain/event-disambiguation.test.ts` `[D-024 AC-30]` | PASS |
| D-026 AC-7（多場裸 `+1` → 提示、不呼叫 service、不 mark） | `src/webhook/handler.disambiguation.test.ts` `[D-026 AC-7]` | PASS |
| D-026 AC-20（批次僅認第一行 selector） | 同上 `[D-026 AC-20]` | PASS |
| D-026 AC-21（`下一輪` 不需 selector） | 同上 `[D-026 AC-21]` | PASS |
| D-026 AC-23（授權作用於已解析活動） | 同上 `[D-026 AC-23]` | PASS |

**AC-29 的偵測力證明（非恆真斷言）**：斷言抽成 `assertSubsetOfStopWords(keywords)`；測試先以真實
`COMMAND_HEAD_KEYWORDS` 呼叫（通過），再以 `[...COMMAND_HEAD_KEYWORDS, '報到']`（`'報到'` 已先斷言
**不在**停止詞集合內）呼叫並 `expect(...).toThrow()` ——若該斷言恆真，這一行會因「未拋出」而讓測試紅燈。
另附一條**防漂移**測試：靜態掃描 `parse.ts` 的 dispatch 字面（`s === '…'`／`head === '…'`／
`equalsIgnoreAsciiCase(s, '…')`／`CREATE_KEYWORDS`）與 `COMMAND_HEAD_KEYWORDS` 逐字相等，
使「新增指令關鍵字卻只改一處」在兩個方向都會被抓到。

## 3.5 diff 範圍自檢（實作者交付前必做）
- [x] §3 AC 對照表點名的每一個檔案，都在本包所附 diff / 新檔清單中（4 個測試檔皆列於「新增」表）
- [x] R2 任務已附**全部受影響檔案**的 diff：`git diff` + untracked 8 檔；未以「與他任務共用」為由省略任何 hunk
- [x] 產 diff 用目錄層級路徑（`git diff --stat`／`git status --short` 全域，未逐檔列舉）
- [x] 凍結區核對：`src/db/tx.ts` 僅**註解**一行（舊索引名 → 新索引名），交易 runner 邏輯零改動；
      `src/db/migrations/0001~0005` 零改動（只新增 0006）

## 4. 機器關卡結果
- [x] `npm run lint` → **0 problems**
- [x] `npm run typecheck`（`tsc -p tsconfig.test.json`）→ **exit 0**
- [x] `npm run build` → 綠（postbuild 已複製 0006 至 `dist/db/migrations`）
- [x] `npm test` → **522 passed / 522（66 files）**；基線 488 → 522（**+34**，零回歸、零 skip）
- [x] `npm run harness:check --strict` → 全過；`check_ac_coverage` **266/266**
      （施工前為刻意的 249/266；**未**以加回豁免行的方式轉綠）
- ℹ `check_doc_budget` 對 D-020（146 行）／D-021（143 行）印 ℹ —— R2 依規則四不設上限、不判失敗，
  依派工單指示**不據此建議再拆文件**

## 5. 需要 reviewer 特別留意的地方（≤ 3 點）

1. **測試側新增共用 helper `activeEventId(t, groupId)`（`src/db/__tests__/test-db.ts`），並被 149 個
   既有 domain 層測試呼叫端使用**。原因：`findActiveByGroup` 移除後 service 改吃 `eventId`，而 domain
   層測試直接呼叫 service（沒有 handler），若不補這一步全部會落 `no_open_event`。helper 實作為
   `(await t.events.listActiveByGroup(g)).at(-1)?.id`，等義重現 dispatch 在「候選 ≤ 1」時的結果。
   **它只存在於 `__tests__` 目錄、不被生產碼 import**，因此不是 G1 所禁止的 wrapper；但請 reviewer
   確認這個判斷。（替代方案是逐條硬寫 `eventId: event.id`，會讓「無 active」類測試失去等義性。）

2. **`close/cancel/edit` 的交易外查詢由「保證是 active 列」變成「`getById` 可能回任何 status」**。
   本批 `eventId` 只可能來自 `listActiveByGroup` 候選（quote 恆 `undefined`），故 status 必為
   `draft|open`，行為與現況等價；但 T-033b 機制 A 落地後，quote 可能指向已 `closed`/`cancelled` 的活動，
   屆時交易外的 `canManageEvent` 會在「非授權者對已關閉活動下 `關閉報名`」時回 `not_authorized`
   而非 `no_active`（交易內重讀仍會正確回 `already_closed`/`no_active`）。這是 D-023 附註「交給各指令
   自身既有狀態判斷」的直接後果，我**未**自行加新的 status 過濾（那會是設計外的發明）；列此供
   T-033b 時一併確認是否需要在 D-025 補一條。

3. **`matchSelector(candidates, selectorRaw, now)` 的 `now` 參數目前不參與任何判斷**（函式內
   `void now;` 並附註）。理由：D-023 §4.3 比對規則步驟 4 明定「月日 token 只比對 `MM-DD` 後兩段、
   **忽略年份**」⇒ 不需要讀取現在的年份；但簽名為設計釘死值，故保留參數與透傳。若 reviewer 認為
   步驟 2 的「用今年份比對」應優先於步驟 4（＝跨年活動不該被 `8/15` 命中），這是設計文字的歧義，
   我不自行改，請裁決。
