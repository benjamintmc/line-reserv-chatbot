# Worklist — backend-engineer

> 擁有者：backend-engineer（唯一可寫者）。Orchestrator 可讀不可寫，透過派工單指派任務。
> 這裡是你的工作區：佇列、筆記、疑問、提議。**狀態真相在 `docs/task-board.md`，以那裡為準。**

## 我的佇列（由 Orchestrator 指派）
| 任務 ID | 目標 | 風險 | 我的狀態 | 備註 |
|---|---|---|---|---|
| T-018 | 分組 review 缺陷修復 B1（`下一輪` 跨群外洩名單）／B2（策略A 未去重且輸出隨機） | R1 | 修復完成，待裁定 | 分支 `feat/D-011-grouping`；未 commit，變更留工作區 |
| T-020 | 批次摘要未依 D-012 §一.3 釘死字串聚合（B1） | R1 | 修復完成，待裁定 | 使用者已裁決「改實作、不改設計」；D-012 未動 |
| T-023 | 開團範例日期動態產生（4 處寫死 `2026/08/15` 已過期 → 今日（台灣）＋7 天；時鐘注入保純函式） | R0 | 實作完成，待裁定 | 審查包 `docs/reviews/RP-T-023.md`；未 commit（變更留工作區，後由 Orchestrator 以 `84b0a13` 收攏） |
| T-022 | D-013 實作（根治跨群）：migration 0004 複合 PK、repo 簽名 `(groupId, lineUserId)`、(N2) 收斂、D-004/D-011 errata、runbook 0004 段落 | **R2** | 實作完成，待裁定 | 分支 `feat/D-011-grouping`；未 commit、未 push，變更留工作區。審查包 `docs/reviews/RP-T-022.md` |
| T-025 | M7 容器強化：新增 `.dockerignore`＋runtime 階段 `USER node`（來源：`docs/security-review-2026-08-22.md` M7） | R0 | 實作完成，待裁定 | 審查包 `docs/reviews/RP-T-025.md`；AC-1/AC-2 為**手動實跑 docker** 之輸出（非 unit test）；未 commit，變更留工作區 |
| T-034 | D-019：`編輯 費用` 支援切換計費模式（per_person↔split_venue），反轉 D-015 決議⑥ | **R2** | 實作完成，**機器關卡未跑**（環境無 node/npm，亦無 docker） | 分支 `feat/t-032-edit-billing-mode`；未 commit，變更留工作區。詳見下方筆記 |

## 狀態提議（等待 Orchestrator 裁定）
| 任務 ID | 提議轉換 | 證據（審查包/測試結果/產出路徑） |
|---|---|---|
| T-018 | PROPOSE → DONE | B1/B2 已修：`src/domain/grouping-service.ts`（`NextRoundInput.groupId` + `conv.group_id` 比對 → `no_session`；`groupBalanced` 首步交易外 `markProcessed` → `duplicate`）、`src/webhook/handler.ts`（`group_next` 傳 groupId、`renderBalanced` 加 `duplicate` → `[]`）、`src/server.ts`（注入 `processed`）。測試：`src/domain/grouping-service.test.ts`（`[D-011 AC-23 errata 跨群]`、`[D-011 AC-24 errata 去重]`）＋`src/webhook/handler.test.ts` 兩條接線層測試。設計 errata：`design/D-011-grouping.md`（狀態行、AC-23/AC-24、討論紀錄）。機器關卡：lint 0／build 綠／**355 tests 全綠**（基線 343，新增 12，零回歸）／`harness:check --strict` 全過（AC 184/184） |
| T-020 | PROPOSE → DONE | B1 已修：`src/domain/list-formatter.ts` `formatBatchSummary` 改依類別聚合（`已報名：${names.join('、')}`、落候補者各自標「（候補）」；取消同理）。測試：新增 `src/domain/list-formatter.batch.test.ts`（5 案）＋更新 `src/webhook/handler.batch.test.ts` :113/:179 斷言。D-012 **未改**（依使用者裁決）。機器關卡同上 |
| T-022 | PROPOSE → DONE | 審查包 **`docs/reviews/RP-T-022.md`**（Guardrails G1–G8 自檢全 ✓、AC-1..9 對照全 PASS）。交付：`src/db/migrations/0004_conversation_scope_pk.sql`（新增；`lock_timeout` → `DELETE WHERE group_id IS NULL` → `SET NOT NULL` → `DROP CONSTRAINT conversation_states_pkey` → `ADD PRIMARY KEY (group_id, line_user_id)`）、`conversation-repository.ts`（`get`/`delete(groupId, lineUserId)`、`ON CONFLICT (group_id, line_user_id)`、`UpsertConversationInput.groupId: string`）、`event-service.ts`／`event-formatter.ts`（`AbandonedKind` 去 `'create'`、`detectAbandoned(prev)` 單行 body 去死參數、`withAbandonedNotice` 去參數、doc-comment 錯誤理由改正）、`grouping-service.ts`／`handler.ts`（查詢鍵改雙參數，五道守衛全留）；文件 `design/D-004`（errata 標註第 5/6 條被取代）、`design/D-011` §1 errata、`docs/deployment-runbook.md` §2.1（AC-8 四要素）。新增測試 3 檔＋改寫 3 處。機器關卡：**lint 0／build 綠／368 tests 全綠（基線 358＋10，零回歸）／`harness:check --strict` 全過（AC 覆蓋 193/193）** |
| T-023 | PROPOSE → DONE | 審查包 **`docs/reviews/RP-T-023.md`**（Guardrail 自檢全 ✓、[T-023 AC-1] 三條測試全 PASS）。交付：`src/domain/event-formatter.ts`（新增純函式 `exampleDate(nowIso)`＝`Date.parse` →＋7 天 → `utcIsoToTaipei` → `YYYY/MM/DD`；`formatFlowPrompt`／`formatFieldError`／`formatOnelineFormatHelp` 各加必填參數 `nowIso: string`）、`src/webhook/handler.ts`（4 處呼叫點改傳 `nowIso()`，import 自 `../db/time`）、`src/domain/event-formatter.billing.test.ts`（既有 4 處呼叫補基準 ISO ＋新增 3 條 `[T-023 AC-1]`）。實際輸出（真實時鐘 2026-08-22 台灣）：四處皆 `2026/08/29`。機器關卡：**lint 0／build 綠／371 tests 全綠（基線 368＋3，零回歸）／`harness:check` 全過（AC 193/193）** |
| T-025 | PROPOSE → DONE | 審查包 **`docs/reviews/RP-T-025.md`**（2 條 Guardrail 自檢全 ✓；[T-025 AC-1]／[T-025 AC-2] 皆 PASS，**含 docker 指令與原始輸出**）。交付：`.dockerignore`（新增 41 行，排除 `.env*`／`node_modules`／`dist`／`data`／`.git` 等）、`Dockerfile`（runtime 階段 `CMD` 前加 `USER node`＋3 行註解；`CMD`／base image／build 階段**零改動**）。實測：`id` = `uid=1000(node)`、`/health` HTTP 200 `{"status":"ok"}`、final image `find / -xdev -name ".env*"` 零命中、`--target build` 階段亦零命中。機器關卡：**lint 0／build 綠／371 tests 全綠（與 T-023 基線相同，本任務未改 TS，零回歸）／`npm run harness:check` 全過（AC 193/193）** |
| T-026 | PROPOSE → DONE | 審查包 **`docs/reviews/RP-T-026.md`**（D-015 **G1–G9 逐條自檢全 ✓**、AC-1..15 對照全 PASS）。交付：`src/commands/types.ts`（`edit_event`／`edit_help` union、`EditEventField`、`InvalidCommandKind+'edit_event'`、`InvalidReason+'bad_location'`、`InvalidDetail`、`MAX_LOCATION_LEN=40`）、`src/commands/parse.ts`（`parseEditEvent`：date/time compact→既有 validator、location `join(' ')` 保留空格且超長不截斷、fee **F2 compact**、`人數` 一律導向、缺值/未知欄位→`edit_help`）、`src/db/repositories/event-repository.ts`（四個**單欄**寫入原語 `updateEventDatetime`／`updateLocation`／`updatePricePerPerson`／`updateVenueFee`）、`src/domain/event-service.ts`（`editEvent()`＋`MAX_MENTIONS_PER_MESSAGE=20`＋`EditEventRequest`/`EditEventResult`；`runImmediate` 選填注入）、`src/domain/event-formatter.ts`（§3 釘死文案 9 支＋`formatEditOk` mention 組裝）、`src/webhook/handler.ts`（`renderEdit`＋`edit_event`/`edit_help`/`invalid(edit_event)` 三分支）、`src/server.ts`（注入 `runImmediate`）。**交付後依裁決兩項修正（2026-08-23，審查包 §6）**：①help 費用列去外層 `費用：`（D-015 §3 errata，去重複標籤）②`[D-010 AC-7]` 逾時改單測作用域、`vitest.config.ts` 還原（diff 0 行）。新增測試 5 檔 59 條。機器關卡：**lint 0 error／build 綠／430 tests 全綠（基線 371＋59，零回歸）／`npm run harness:check` 全過（AC 覆蓋 208/208，含 D-015 全 15 條）**。凍結區零改動（`src/db/tx.ts` 與 `migrations/` 皆不在 diff），**無新增 migration**；未 commit、未 push |

## 工作筆記（自由書寫，不進他人 context）
- **F1（使用者實測回報的 bug，尚無任務 ID，請 Orchestrator 編號）**：`conversation_states` PK 為
  `line_user_id`（跨群唯一），讀取端從不比對 `group_id` → 同一人在 A 群開團中，於 B 群的發言被當成
  A 群流程的答案。修法：`handler.ts` 攔截條件加 `conv.group_id === groupId`；domain 三處
  （`continueFlow`／`confirm`／`abort`）同步比對為權威防線。**`AbortInput` 因此新增 `groupId`**。
  errata 寫入 `design/D-004-event-creation.md`（新增「errata（2026-08-18，跨群語意）」5 條 + AC-15 語意擴充）。
  測試：`src/webhook/event-handler.test.ts` 三條 `[D-004 errata 跨群]`。零 migration（欄位早已存在）。
- **F1 連帶發現（本次一併修掉，非原派工單條列）**：只修 handler 攔截會產生**更嚴重**的新洩漏——
  未被攔截的 `確認` 會落到 `dispatchSingle` → `eventService.confirm({ groupId: B })`，把 A 群 draft
  **建立成 B 群的活動**；`取消` 則會放棄 A 群流程。故 `confirm`/`abort` 必須一併比對 `conv.group_id`。
- **F3 去重政策選擇**：沿用唯讀指令 `名單`（`getListView`）的既有政策——**交易外 `markProcessed` 作首步**，
  重送回 `duplicate`。與 `startRounds`（交易內 mark）不同是既有的政策不對稱（見 task-board T-017 第①項），
  本次**未新增第四種變體**。副作用：非主辦的 `分組` 也會消費 messageId（同 `名單` 語意）。
- 凍結區未動：`src/db/tx.ts`、`src/db/migrations/0001~0003` 皆零改動；**無新增 migration**。
- 未 commit、未 push；變更留在工作區待 Orchestrator 驗收。
- **T-022 筆記**：
  - **AC-3b 選作法 (i)**（可自動化，非降人工）：於獨立 schema `d013_ac3b` 以 `readFileSync` 重放
    0001–0003 → 插一列 NULL + 一列正常 → **自行 `BEGIN`/`COMMIT`** 套 0004 → 斷言只有 NULL 列被刪
    （`src/db/__tests__/d013-null-cleanup.test.ts`）。連線於 `finally` 先 `DROP SCHEMA` 再 `RESET search_path` 才歸還池。
  - **超出 D-013 明文的一項改動**：`src/db/schema.ts` 的 `ConversationStateRow.group_id` 由
    `string | null` 收斂為 `string`。理由：0004 已 `SET NOT NULL`，不改則 `grouping-service.nextRound`
    的 `groupId: conv.group_id` 型別不符而編譯失敗。已列入審查包 §5 第 1 點請 reviewer 裁示。
  - 既有硬編碼 migration 清單因新增 0004 而必須更新：`event-claiming-static.test.ts` 的
    `[D-006 AC-13]`、`migrate.test.ts` 的計數 3→4。屬機械式更新，非行為回歸。
  - 凍結區零改動：`src/db/tx.ts`、`src/db/migrations/0001~0003` 皆未出現在 diff。
- **T-023 筆記**：
  - **時鐘注入選「必填參數 `nowIso: string`」**：可選參數必須有預設值 → 預設值只能在 formatter 內讀時鐘 = 違反 Guardrail；
    塞進 `WebhookHandlerDeps` 則要改所有 handler 測試 fixture。必填參數讓 `tsc` 直接在生產呼叫端報錯，衝擊面最小。
  - **假綠防護（本專案第 3 次同型問題）**：`tsconfig` 排除 `*.test.ts`，build 綠不保證測試呼叫端都改對。
    已額外 grep 全部呼叫點（24 行命中：定義 3、handler 4、test 17），列於審查包 §3.5。`event-service.ts` 未用到這三個 formatter。
  - 時區沿用 `src/db/time.ts` `utcIsoToTaipei`，未自寫時區邏輯；`new Date(ms + …)` 為毫秒→Date 的確定性轉換，非讀系統時鐘。
  - 凍結區零改動；無新增 migration；未自行 commit（Orchestrator 於我跑關卡期間以 `84b0a13` 收攏工作區變更）。
- **T-025 筆記**：
  - **`USER node` 未遇到任何權限問題**。`/app` 與 `node_modules` 仍為 root 擁有、node 使用者唯讀，
    程式為 PG-only 不寫本機檔案系統（`better-sqlite3` 已於 T-012 移除），故無需 `chown`／`chmod`——
    Guardrail「不得放寬權限」自然滿足，不是靠繞過。若未來需寫檔，只能寫 `/tmp`（Cloud Run 唯一可寫處）。
  - **AC 只能手動驗**：兩條 AC 需要真實 `docker build`／`docker run`，`npm test` 無從覆蓋，
    故依 D-000 模板新規把**指令與原始輸出**逐字貼進審查包。`check_ac_coverage.py` 亦掃不到
    `[T-025 AC-n]`（R0 無 D 檔），這是預期，非漏測。
  - **Git Bash 陷阱（給後續同型任務）**：`docker run ... ls -a /app` 在 Git Bash 會被 MSYS 路徑轉換
    成 `C:/Program Files/Git/app` 而失敗；需 `export MSYS_NO_PATHCONV=1`。
  - **`.dockerignore` 排除範圍略大於任務單最低要求**（多排 `docs`/`design`/`harness`/`.github`/`.claude`），
    理由與影響評估已列於審查包 §5 第 1 點，供裁定時取捨。
  - 凍結區零改動（`src/db/tx.ts`、`src/db/migrations/*` 未出現在 diff）；**零 TypeScript 改動**；
    未夾帶同輪盤點的 H1/M2–M6 任一項；未 commit、未 `git add`，變更留工作區。

- **T-026 筆記**：
  - **AC-13 前置已解（有官方出處，非臆測）**：`MAX_MENTIONS_PER_MESSAGE = 20`。出處為 LINE Messaging API
    reference → Text message (v2) → **Mention object** 條列第 5 點「Up to 20 mentions can be substituted
    in a single message.」（`https://developers.line.biz/en/reference/messaging-api/#text-message-v2-mention-object`；
    機器可讀鏡像 `.../index.html.md`）。同時核實 D-015 §4 所述屬實——官方 OpenAPI（`line/line-openapi`
    `messaging-api.yml`）的 `TextMessageV2.substitution` 是開放 map、**無 `maxProperties`**，型別擋不住，
    只能在應用層守。**注意**：SDK `dist/webhook/model/mention.d.ts` 裡那句「Max: 20 mentions」是**收訊**
    （webhook event）方向的限制，不可直接當送訊依據；本次採用的是送訊方向的官方文件。
  - **AC-6 前置（N7）已實地核對，與 D-015 §1 F2 一致**：`validateVenueFee` 只去前綴 `場地費`/`均攤`＋尾綴 `元`、
    `validatePrice` 只去尾綴 `元`，**兩者都不吸收空白**（只有被 G6 禁用的 `validateFee` 會 `replace(/\s+/g,'')`）。
    故 `場地費 4000`／`2500 元` 不先 compact 必被誤拒 → F2 為必要，非贅述。設計無誤，未自行更動。
  - **§3 help 模板 `費用：{費用列}` 會出現重複標籤**（`feeLine` 自帶標籤 → 實際輸出 `費用：每人費用：2500 元`）。
    §3 同時釘死 `費用：` 前綴與「沿用 `feeLine`」、AC-10 又要求逐字相等 → **照字面實作並回報**，不自行改設計。
  - **對 §2 型別表的兩處唯讀補充**（無行為變更）：`ok` 增 `confirmedCount`（split 成功句的 K 是正取**列數**，
    與去重後 `tagOwnerIds.length` 不同，無法互相替代）；`help` 增 `confirmedCount` 與 `now`（`{費用列}` 與
    範例日期所需）。另 `ParsedCommand.invalid` 增選填 `detail?: {len}` 供 `bad_location` 顯示實際字數（AC-11 要求）
    ——這三處請 api-contract-designer 更新 `docs/02-api-contract.md` 時一併納入。
  - **domain 純度靜態檢查的字串陷阱**：`event-no-sql` / `billing-guardrails` / `event-claiming-static`
    三支測試以 `not.toMatch(/@line\/bot-sdk/)` 掃 `event-service.ts` **全文**，故連**註解**裡寫出套件名都會紅。
    引用 SDK 版本時改寫成「LINE 官方 SDK（v9.5.0）」。（給後續同型任務的地雷提示。）
  - **`[D-010 AC-7]` 逾時（orchestrator 裁決：改單測作用域，2026-08-23）**：既有該條以 `insertSlot` 逐列撐
    999 位正取（約 2000 次 DB 來回），本機 Windows/Docker 實測 4.5–5.5s，會隨機超過 vitest 預設 5s 而假紅。
    已確認與本次變更無關（清空變更後單檔執行亦可重現落在邊界）。
    **原本改全域 `vitest.config.ts` 的做法已撤回並還原（diff 0 行）**——orchestrator 指出全域放寬會讓
    任何真正掛住的測試都要等滿才失敗、降低整套診斷力。現改為該條 `it(..., 20_000)` 加三行成因註解，
    其餘 429 條仍受預設 5s 保護；未動任何斷言。（給後續同型任務：**逾時要就地放寬，別動全域**。）
  - **help 費用列重複標籤（orchestrator 裁決：修掉，D-015 §3 errata 2026-08-23）**：`feeLine()` 自帶標籤，
    外層再加 `費用：` 會輸出 `費用：每人費用：2500 元`。已改為直接用 `feeLine(...)`，輸出
    `每人費用：2500 元`／`場地費：3000 元，平均每人約 750 元（暫估，關閉報名後結算）`，與名單畫面一致。
    兩條 AC-10 逐字測試同步更新，並各加一行 `not.toContain('費用：每人費用')`／`not.toContain('費用：場地費')`
    回歸守門。**已核對**：architect errata 已落地於 `design/D-015-edit-event.md` §3 code block（`{費用列}`，
    無外層 `費用：`），與實作逐字一致；該設計檔由 architect／orchestrator 所改，我未動。
  - **AC-2/AC-3 需要「固定 now」**：本專案 domain 以 `nowIso()` 取時（D-015 §2 明定 service 取一次），
    故測試以 `vi.useFakeTimers({ toFake: ['Date'] })` 凍結——**只假造 Date**，不動 setTimeout，否則 pg 連線池
    計時器被凍住會卡死。時間欄皆 TEXT（migration 0001），pg 不反序列化為 Date，對 DB 無副作用。
  - **鎖內 K 的取得**：N6 字面寫 `countConfirmed()`，實作改由同一次 `listConfirmed()` 的列數推得
    （那批列本來就要拿來算 `tagOwnerIds`）。WHERE 述詞相同、同一交易快照 → 等價，且鎖內少一次查詢（N5 精神）。
  - 凍結區零改動：`src/db/tx.ts`、`src/db/migrations/*` 皆不在 diff；**未新增 migration**（日期與時間共用
    `event_datetime`，不新增欄位）。**未加回 AC 豁免、未改 check 腳本、未動 `EXEMPT` 清單。**
  - 未 commit、未 push；變更留在 `feat/t-026-edit-event` 工作區待 Orchestrator 驗收。

- **T-034 筆記**：
  - **環境限制比派工單描述的更嚴重**：派工單只提到「沒有 docker」，但這台機器**連 node/npm 都沒裝**
    （`which node npm` 找不到、全機找不到任何 node 執行檔，`dangerouslyDisableSandbox` 重試仍然一樣）。
    因此 `npm run lint`／`npm run build`／`npm run harness:check`／`npm test` **全部**沒能實際執行，
    不只是任務單預期會擋掉的 `npm test`。只做了逐檔手動閱讀＋型別走查（import 是否還用得到、
    `TxRepos.events` 是否曝露新原語、`switch`/`default: never` 窮舉是否仍成立等），**未經編譯器驗證**。
  - **`feeLabel` 依設計文件字面放在 `event-formatter.ts`（非 `event-service.ts`）**：D-019 §一.3 的
    pseudocode 直接在 domain 的 `case 'fee'` 內呼叫 `feeLabel(...)`，§一.5 又註明它是「formatter 內部
    helper」。這造成 domain（`event-service.ts`）新增一條指向 `event-formatter.ts` 的 value import；
    反向 `event-formatter.ts` 對 `event-service.ts` 原本就只有 `import type`（型別會被完全擦除），
    故不構成執行期循環依賴——但**這是本次唯一偏離「domain 不依賴 formatter」慣例的地方**，且是設計文件
    明文指定的做法，未自行擴權，僅回報供 reviewer 留意。
  - **`updatePricePerPerson`/`updateVenueFee` 已移除**（非僅新增 `updateBilling` 並存）：grep 全 repo
    確認呼叫點只有 `event-service.ts` case 'fee' 這一處（測試檔亦無直接呼叫），依 D-019 §一.4「除 fee
    路徑外無其他呼叫點後裁定」自行裁定移除，理由是留著兩個死方法會讓 reviewer 誤以為還有呼叫路徑。
  - **AC-7 的「未呼叫 updatePricePerPerson/updateVenueFee」**：因兩方法已整個從類別移除，呼叫端在型別
    層面已不可能呼叫到（改回去會編譯失敗），故測試只保留「`updateBilling` 恰呼叫一次（含切換與不切換
    兩案例、逐次累計 spy 次數）」的斷言；「未呼叫舊方法」這半句由方法不存在這件事本身保證，未另寫
    `expect(...).not.toHaveBeenCalled()`（該方法已不存在，寫了也無意義）。AC-7 另要求 reviewer 人工
    grep `updateBilling` 本體確認只有一條 `UPDATE` 陳述句——已在 repo 方法內以單一 `this.q.query(...)`
    呼叫實作（`src/db/repositories/event-repository.ts` 新 `updateBilling`），供審查時核對。
  - **`bad_fee` 兩則舊測試語意整條反轉**（非新增，是修正）：`event-service.edit.test.ts` 原「per_person
    收到 `場地費4000` → bad_fee」與 formatter 的「bad_fee 兩種模式文案」兩條測試，依 D-019 AC-1/AC-4
    直接**改寫**（非在旁新增一條並存），因為舊行為本身已被 errata 廢止，留著會與新行為互相矛盾。
  - 凍結區零改動：`src/db/tx.ts`、`src/db/migrations/*` 皆不在 diff；**未新增 migration**（三欄本已存在，
    D-005 建立時就有）。`docs/02-api-contract.md`／`docs/api/openapi.yaml` 依 D-019 §四交 api-contract-designer，
    本次未動。
  - 未 commit、未 push；變更留在 `feat/t-032-edit-billing-mode` 工作區待 Orchestrator 驗收。**未提議
    PROPOSE → DONE**：機器關卡（lint/build/harness:check/test）一項都沒能實際跑過，依 CLAUDE.md §6
    第 0 條「未全綠不得送模型審查」，這關必須先由具備 node 環境的人/機器補驗證。

## 我要回報給 Orchestrator 的事項
| 類型（阻塞/契約疑義/重複問題/建議） | 內容 |
|---|---|
| 建議（編號） | F1 是使用者實測回報的既有 bug（D-004 跨群語意），目前掛在 T-018 分支上但**不屬於 T-018 範圍**，建議另編任務 ID 以利追溯與 commit 訊息 `fix(D-004/T-xxx)` |
| 重複問題（LESSONS 候選） | 「conversation state 三件套」再犯一次：`conversation_states` 的**讀取端**未比對 `group_id`，且 `AbortInput` 當初就沒帶 `groupId`。建議把「凡以 `line_user_id` 為 PK 的狀態表，讀取端必須連同 scope 欄位一起比對」寫成 reviewer checklist 條目（現已累計：D-004 攔截、D-011 session 兩處同型） |
| 建議（既有取捨，未動） | 一人同時只能有一段進行中流程：在 A 群開團中又於 B 群 `開團` 仍會覆寫同一列（既有行為，本次未改，已記入 D-004 errata 第 5 條） |
| **阻塞（環境）** | T-034 執行環境**沒有安裝 node/npm**（不只是缺 docker）；`npm run lint`／`build`／`harness:check`／`test` 全部無法執行，需另一台有 node 的環境或本機補跑後才能判定是否過關。詳見 T-034 筆記。 |
