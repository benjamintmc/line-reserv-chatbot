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

## 狀態提議（等待 Orchestrator 裁定）
| 任務 ID | 提議轉換 | 證據（審查包/測試結果/產出路徑） |
|---|---|---|
| T-018 | PROPOSE → DONE | B1/B2 已修：`src/domain/grouping-service.ts`（`NextRoundInput.groupId` + `conv.group_id` 比對 → `no_session`；`groupBalanced` 首步交易外 `markProcessed` → `duplicate`）、`src/webhook/handler.ts`（`group_next` 傳 groupId、`renderBalanced` 加 `duplicate` → `[]`）、`src/server.ts`（注入 `processed`）。測試：`src/domain/grouping-service.test.ts`（`[D-011 AC-23 errata 跨群]`、`[D-011 AC-24 errata 去重]`）＋`src/webhook/handler.test.ts` 兩條接線層測試。設計 errata：`design/D-011-grouping.md`（狀態行、AC-23/AC-24、討論紀錄）。機器關卡：lint 0／build 綠／**355 tests 全綠**（基線 343，新增 12，零回歸）／`harness:check --strict` 全過（AC 184/184） |
| T-020 | PROPOSE → DONE | B1 已修：`src/domain/list-formatter.ts` `formatBatchSummary` 改依類別聚合（`已報名：${names.join('、')}`、落候補者各自標「（候補）」；取消同理）。測試：新增 `src/domain/list-formatter.batch.test.ts`（5 案）＋更新 `src/webhook/handler.batch.test.ts` :113/:179 斷言。D-012 **未改**（依使用者裁決）。機器關卡同上 |
| T-022 | PROPOSE → DONE | 審查包 **`docs/reviews/RP-T-022.md`**（Guardrails G1–G8 自檢全 ✓、AC-1..9 對照全 PASS）。交付：`src/db/migrations/0004_conversation_scope_pk.sql`（新增；`lock_timeout` → `DELETE WHERE group_id IS NULL` → `SET NOT NULL` → `DROP CONSTRAINT conversation_states_pkey` → `ADD PRIMARY KEY (group_id, line_user_id)`）、`conversation-repository.ts`（`get`/`delete(groupId, lineUserId)`、`ON CONFLICT (group_id, line_user_id)`、`UpsertConversationInput.groupId: string`）、`event-service.ts`／`event-formatter.ts`（`AbandonedKind` 去 `'create'`、`detectAbandoned(prev)` 單行 body 去死參數、`withAbandonedNotice` 去參數、doc-comment 錯誤理由改正）、`grouping-service.ts`／`handler.ts`（查詢鍵改雙參數，五道守衛全留）；文件 `design/D-004`（errata 標註第 5/6 條被取代）、`design/D-011` §1 errata、`docs/deployment-runbook.md` §2.1（AC-8 四要素）。新增測試 3 檔＋改寫 3 處。機器關卡：**lint 0／build 綠／368 tests 全綠（基線 358＋10，零回歸）／`harness:check --strict` 全過（AC 覆蓋 193/193）** |
| T-023 | PROPOSE → DONE | 審查包 **`docs/reviews/RP-T-023.md`**（Guardrail 自檢全 ✓、[T-023 AC-1] 三條測試全 PASS）。交付：`src/domain/event-formatter.ts`（新增純函式 `exampleDate(nowIso)`＝`Date.parse` →＋7 天 → `utcIsoToTaipei` → `YYYY/MM/DD`；`formatFlowPrompt`／`formatFieldError`／`formatOnelineFormatHelp` 各加必填參數 `nowIso: string`）、`src/webhook/handler.ts`（4 處呼叫點改傳 `nowIso()`，import 自 `../db/time`）、`src/domain/event-formatter.billing.test.ts`（既有 4 處呼叫補基準 ISO ＋新增 3 條 `[T-023 AC-1]`）。實際輸出（真實時鐘 2026-08-22 台灣）：四處皆 `2026/08/29`。機器關卡：**lint 0／build 綠／371 tests 全綠（基線 368＋3，零回歸）／`harness:check` 全過（AC 193/193）** |

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

## 我要回報給 Orchestrator 的事項
| 類型（阻塞/契約疑義/重複問題/建議） | 內容 |
|---|---|
| 建議（編號） | F1 是使用者實測回報的既有 bug（D-004 跨群語意），目前掛在 T-018 分支上但**不屬於 T-018 範圍**，建議另編任務 ID 以利追溯與 commit 訊息 `fix(D-004/T-xxx)` |
| 重複問題（LESSONS 候選） | 「conversation state 三件套」再犯一次：`conversation_states` 的**讀取端**未比對 `group_id`，且 `AbortInput` 當初就沒帶 `groupId`。建議把「凡以 `line_user_id` 為 PK 的狀態表，讀取端必須連同 scope 欄位一起比對」寫成 reviewer checklist 條目（現已累計：D-004 攔截、D-011 session 兩處同型） |
| 建議（既有取捨，未動） | 一人同時只能有一段進行中流程：在 A 群開團中又於 B 群 `開團` 仍會覆寫同一列（既有行為，本次未改，已記入 D-004 errata 第 5 條） |
