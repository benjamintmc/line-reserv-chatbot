# Backlog（暫緩事項登記簿）

> 擁有者：orchestrator，**唯一可寫者**（同 `docs/task-board.md`，見 `harness/OWNERSHIP.md`）。
> **2026-08-22 自 task-board 切出**：board 受 doc-budget 80 行上限約束，而 Backlog 是**長期累積**的
> 暫緩登記簿，兩者成長曲線不同——擠在一起導致每次新增待辦都得先刪別的東西（同日內發生 2 次）。
> 切檔後 board 只留「進行中任務 + 阻塞 + 決策待辦」，本檔負責「決定不做／暫緩／待排」的完整理由。
>
> **寫入規則**：每條需寫明「為什麼現在不做」與「動工前必須先解掉什麼」——只寫標題的條目會在
> 幾週後失去意義，等同沒登記。已結案的條目移入 `docs/task-board-archive.md`，不留在本檔。

## 修復順序裁決（使用者，2026-08-23）

> 本段為**優先序真相**。動工前先讀本段再讀下方條目；與條目內舊有的「建議順序」衝突時，以本段為準。

**進度（2026-08-23）**：**①文案整潔化已完成**（T-028／D-017）——六項中四項修復、
兩項經呼叫點比對後判定為「刻意分工」不改（結論已寫進程式碼註解，避免下一位 reviewer 重複提報）。
④「其他」中的**資安 H1／M2–M5 亦已提前全數完成**（T-027／D-016）。
**下一輪從 ②拒絕回覆去重不對稱（R2）開始**，再接 ③測試檔假綠。
**新登記**：`design/D-015` 已達 120 行文件預算上限，下次要改它必須先切檔。

**執行順序**：①~~**文案整潔化**~~ **已完成（T-028／D-017，2026-08-23）**（同一狀態兩種說法／地點上限不一致／`formatEditOk` 對空氣喊話／顯示名 fallback／`editErrorField` 非 exhaustive／D-007 §3 errata）→ ②**拒絕回覆去重不對稱**（CLAUDE.md §4 已立規則、碼未收斂；碰 `registration-service.ts` ⇒ R2）→ ③**測試檔假綠**（獨立 tsconfig 跑 `tsc --noEmit` 涵蓋 `*.test.ts`）→ ④其他（拆批遞補、N+1 批次原語、D-009、`指令`/`教學` 全指令說明回覆；~~資安 M2–M5~~ 已於 T-027 完成）。

**裁決為「不動」**（本輪不開任務，條目保留備查，恢復評估時直接沿用）：
- **M6 開團鎖死無回收路徑**（＝上輪清單 #3）。
- **縮減名額（`capacity` 下修）**（＝上輪清單 #4），連帶 `signup` 交易外快照 capacity 一併不動——
  **前提未變**：只要不開放縮減，D-010 G1「單調不減」仍使現況安全。日後若恢復此案，該行**必須**先改鎖內重讀。

**mention 數量上限（＝上輪清單 #2）：改以文案處理，不做完整技術修復。**
使用者裁決：「確保有文本提醒開團者要自己 tag 即可」。
**orchestrator 註記（動工前必讀，勿只加文案）**：兩條路徑現況不同——
`編輯活動`（D-015）已定義「超限整則退化為純文字」，**加一句提醒即可滿足裁決**；
但 **`buildPromotionNotice` 遞補通知路徑目前無任何上限檢查**，超限是 **LINE API 400、整則發送失敗**，
**連提醒文案都送不出去** ⇒ 該路徑仍需最小改動（共用常數 `MAX_MENTIONS_PER_MESSAGE` + 超限就不帶 mention 改純文字），
文案才有載體。此為「讓裁決生效的最小成本」，非擴大範圍。

## 條目

- **（D-020 雙審 nit，2026-09-01 登記，不阻擋 APPROVED）** architect-reviewer 複審 B1（跨群引言防禦）修法時提出：目前 AC-28 只覆蓋「candidates>1 + 跨群引言」的攻擊情境，沒有一條 AC 專門覆蓋「candidates=1（單場）+ 跨群引言」組合——雖然邏輯上安全（該分支用 `candidates[0]`、不讀 `quotedEventId`），但缺一條純防禦性回歸測試釘住這個安全性。**為什麼現在不做**：非阻擋項，reviewer 已確認邏輯無漏洞，只是測試覆蓋面可以更完整。**動工前**：D-020 進入實作階段（T-xxx）時，unit-tester 補這條 AC 即可，不需要另開設計變更。
- **（新功能，2026-08-31 登記）`指令`／`教學` 全指令說明回覆**：使用者輸入 `指令` 或 `教學` 時，機器人回覆一份完整指令清單（目前只有零散的 fragment help——`formatEditHelp`〔編輯欄位缺失時〕、`分組指令格式：`〔分組參數畸形時〕——尚無總覽/教學性質的回覆）。**為什麼現在不做**：非當前主線（T-032）需求，排入修復順序裁決④「其他」佇列。**動工前確認事項（已查證，2026-08-31）**：①`指令`／`教學` 兩字目前未被 `parseCommand` 佔用、不會誤判其他分支，可安全新增為新關鍵字②現行 unknown 分支是「完全靜默、不回覆、不 mark」（`handler.ts` `dispatchSingle` 的 `case 'unknown'`，G9 防洗版政策）——新增本分支後該訊息變成「有回覆」，依 CLAUDE.md §4 去重政策，**`markProcessed` 須置於本分支的 reply 之前**，否則重送會重覆吐出整份說明③內容範圍為現行 `src/commands/parse.ts` 已支援的指令（名單/list、確認、取消活動、取消、下一輪、我的id、開團/新活動、分組、加開 N、編輯 日期/時間/場地/費用/人數、+N、-N）——**`關閉報名` 已裁決移除**（見下方條目），撰寫教學文案時**不得收錄**，且若該案先落地，本案內容需同步排除。**風險與流程**：**R0**——純新增一個唯讀回覆分支，不碰報名/授權/資料寫入邏輯；依 CLAUDE.md §5，設計用任務單內 stub（3–5 行 + 1 條 Guardrail + 1 條 AC）即可，不建 D 檔，跳過 reviewer，unit-tester 抽驗。
- **（T-026 雙審 nit，2026-08-23，實作已 PASS 不阻塞）** 兩位 reviewer 提出、經 orchestrator 裁定「不值得為此再跑一輪設計 errata + 實作 + 複審」的項目，逐條記於此供後續同型任務**順手**清償：
  ①**`formatEditOk` 對空氣喊話**：正取為 0 時（主辦自行 `-1` 後）仍輸出「已報名的各位請確認。」。極低頻、非資料錯誤；修法是該情況只輸出成功句，但會動 D-015 §3 釘死字串 ⇒ 需 errata。
  ②**`event-formatter.ts:245` 仍為「活動已關閉報名。」**，與 D-015 收斂後的「報名已截止」並存——**與本檔既有條目④（`formatNoActiveEvent` vs `formatNoOpenEvent`）同族**，屬 LESSONS 登記過的「同一狀態兩種說法」；建議與④併案一次收斂。
  ③**`handler.ts:493` 顯示名 fallback `'使用者'` vs 同檔 203 行既有 `'代報者'`** 風格不一（皆為防禦路徑、不在釘死清單內）。
  ④**`users.getByIds` 批次原語缺席**：`renderEdit` 成功路徑對 ≤20 個 owner 各發一次 `getById`（交易外、`Promise.all`，符合 G9 不延長鎖期），但同型 N+1 在 `buildPromotionNotice`／`renderAddCapacity` 已存在三處；加一個批次原語可一次清掉。R1。
  ⑤**`editErrorField(reason: string)` 非 exhaustive**：非 `create_bad_date`／`create_bad_time` 一律落 `'location'`，日後 parser 對 `edit_event` 新增第 4 個 reason 會**靜默給錯文案**；建議改吃 `InvalidReason` 並對已知值 exhaustive。
  ⑥**`EventServiceDeps.runImmediate?` 為選填＋runtime throw**：`server.ts` 已注入故現況安全，改必填即可讓編譯器擋住未來新建構點（僅需改測試 fixture）。
  ⑦**`MAX_MENTIONS_PER_MESSAGE = 20` 的真機驗證**：出處為官方送訊方向文件（非 SDK 型別，OpenAPI 無 `maxProperties`），唯一守門是應用層常數；LINE 若日後調整我方不會自動得知。建議部署後真機驗一次 21 人退化路徑。
- **（D-015／T-026 衍生，2026-08-22，兩條）** 編輯活動資訊設計階段裁決後留下：
  ①**縮減名額（`capacity` 下修）無合法路徑**——`編輯 人數` 只導向 `加開 N`，D-010 保證只加不減，想縮只能「取消活動重開」（報名與候補 FIFO 全毀）。**動工前必須先解**：`registration-service.signup` 目前以**交易外**的 `event.capacity` 快照作容量決策，安全性完全依賴 D-010 G1「單調不減」；未先改為鎖內重讀就開放縮減 = 靜默超賣（同 2026-08-19 條目①，此為其產品面出口）。另需裁決「縮到低於現有正取人數時，誰被踢回候補」。碰 `registration-service.ts` ⇒ **R2**。
  ④**同一狀態兩種說法（文案不一致）**：`formatNoActiveEvent()`「目前沒有進行中的活動。」（有句號）與 `formatNoOpenEvent()`「目前沒有開放報名的活動」（無句號）並存，指涉情境高度重疊。D-015 選用前者正確，不阻塞任何任務；收斂需逐一比對兩者現行呼叫點的語意差異（是否真的一個指「沒有活動」、一個指「有活動但不開放」）再決定合併或明確分工。純文案，R0–R1。**design-reviewer 標為疑似重複問題**——若再出現一次同型缺陷，登記 LESSONS。
  ③**既有 mention 無數量上限檢查（D-003 遞補通知同受影響）**：`src/webhook/handler.ts` 的 `toLineMessage()` 把 `mentionees` 逐一轉為 `{mN}` substitution，**完全沒有上限檢查**；LINE 單則訊息的 mention 數量上限亦未在 SDK 型別（`textMessageV2.d.ts` 的 `substitution` 是無 `maxItems` 的開放 map）或任何設計文件中 pin 住。大量遞補時（例：一次釋出 20+ 名額）遞補通知可能同樣超限而整則發送失敗。**D-015 只為編輯路徑定義了「超限整則退化」，未擴大範圍修 D-003**；動工前須先以官方文件確證上限數字並定為共用常數 `MAX_MENTIONS_PER_MESSAGE`。R1。
  ②**地點長度上限兩路徑不一致**：D-015 為編輯路徑加了 40 字 sanity 上限（超長會撐爆 LINE 回覆），但**開團路徑（一行式與逐步問答）目前無上限**，故仍可建出 100 字地點、之後不能編輯。屬已知不一致，收斂方式：`validators.ts` 抽共用 `validateLocation` 並套用於 create-flow 與 parse 的開團分支。純驗證層、無 schema 變動 ⇒ **R1**。
- **（資安盤點，2026-08-22）** **狀態更新（2026-08-23）：12 條已結案 7 條**——M7（T-025）、H1／M2／M3／M4／M5（T-027／D-016，已部署 PROD `00005-89q`）、M6（使用者裁決不做）。**遺留**：①輪替 LINE token 並刪除仍帶明文 secret 的舊 revision 00001–00004（需 LINE Console 操作，程序見 runbook §4.2）②L1–L5 低疑慮維持備查。以下為 2026-08-22 當時的原始盤點文字，保留供追溯。 明細見 **[`docs/security-review-2026-08-22.md`](security-review-2026-08-22.md)**（每項附落點 + 動工前必讀 + 建議順序）。摘要：**T-024／D-014（H1，DB TLS 顯式化，R1，設計已備妥待核可）**、M2 Secret Manager、M3 webhook 無限流、M4 `textV2` 的 `{}` 未跳脫（**＝T-006 nit-3 第二次提出**）、M5 log 寫入 PII、M6 開團鎖死無回收（R2）、M7 容器 root + 無 `.dockerignore`。**H1 初判「高」經實測降為「中（潛伏）」——PROD 目前其實有完整憑證驗證，真風險是 pg v9 升級時靜默失去驗證。** 另含 **L1–L5 低疑慮**（`我的ID` 全群可見／無資料保存期限與刪除路徑（**與既有 conversation TTL OP-6 同族，宜合併**）／CI 無 `npm audit`／特權操作無稽核軌跡／host 可代取消他人名額）——記錄備查，不建議單獨開任務。**共 12 條：H1、M2–M7、L1–L5（無 M1，編號習慣不一致非遺漏）。** 建議起手：M7（兩行）→ T-024。
- **（工具面，2026-08-22）`eli5` skill 的評測工作區暫緩**：已建 `.claude/skills/eli5/SKILL.md`（中文化自 https://github.com/dreambigou/eli5 ，MIT），本次**刻意只做 skill 本體**。原 repo 另有 `evals.json` + `run-evals.py`（同一 prompt 跑 with-skill / baseline 兩次，再用 Claude 依 assertions 自動評分、印通過率），若日後要驗證這個 skill 真的有效再補。**與產品無關、不影響任何交付關卡**（不進 `npm run harness:check`）。
- **（T-017 衍生，2026-08-22，兩條「規則已立、碼未收斂」）** T-017 只做規則回寫、刻意不夾帶碼改動，故留下兩筆待收斂：
  ①**拒絕回覆去重政策的碼面收斂**：CLAUDE.md §4 已定通則「凡會送出回覆的訊息（含拒絕）一律消費 `message.id`」，但現行碼仍不對稱——`no_open_event` 等純拒絕分支在 `markProcessed` **之前** early-return（`registration-service.ts` signup/cancel），`getListView` 與分組策略A 則已先 mark。使用者可見症狀：LINE 重送時拒絕訊息會重覆出現。**碰 `registration-service.ts` / `event-service.ts` ⇒ R2**，需設計文件 + 雙審；動工時須窮舉所有 early-return 點。
  ②**D-007 §3「cancel candidates 唯讀讀安全」需 errata**：`freedConfirmed` 是決策輸入而非單純讀，該段措辭與 CLAUDE.md §4 新增的「決策輸入必須鎖內取得」不一致（實作已於 T-012 B1 修正為鎖內 RETURNING，僅文件未同步）。**純文件 errata，R1**。
- **【跨任務衝突，orchestrator 2026-08-22 登記】D-015（編輯活動）× 移除 `關閉報名` 兩案相撞**：D-015 於另一 session 設計期間，本 session 剛裁決移除 `關閉報名`，兩邊未互見。具體碰撞點三處——①D-015 §3 split 成功文案釘死「暫估，**關閉報名後結算**」（承自 D-005），指令移除後該句失真；②`closed_not_editable` 分支與文案「**報名已截止**的活動無法編輯。」在無 `closed` 狀態後語意需重新定義（改為「已過期不可編輯」與既有 `event_ended` 合併？）；③D-015 §2 (B) 以 `findLatestDisplayable` 判 `closed` 的邏輯同受影響。**不阻擋 D-015 核可或 T-026 動工**（現行 `closed` 仍存在，設計正確）；但**移除 `關閉報名` 的設計文件必須把 D-015 列入「將改動的既有文件」預列 errata**，否則會留下三處失真文案。依 D-000 模板新欄位辦理。
- **【已裁決 2026-08-22：移除 `關閉報名`】待開設計文件（R2，動 `events` 狀態機）**。使用者定調：**不做排程更新 status，一律以「活動時間是否已過當下時間」判定**（＝沿用 D-008 惰性 on-read）。現行 `closeEvent` 綁三件事——①截止報名 ②`split_venue` 凍結 `settled_per_person` ③離開 active 集釋放單一活動槽位。設計須解掉：**(a)** 槽位釋放改由「過期」單獨承擔 ⇒ **同群要提前開下一場必須等活動時間過去**（現行可用關閉繞過；`取消活動` 會刪活動非替代品）——此取捨已告知使用者；**(b)** 費用凍結時機移到過期當下，靠惰性 on-read 寫入，**需防並發重複寫**；**(c)** 附帶好處：「關閉後沒人能退出／不可逆」兩個坑自然消失。
- **（2026-08-19 本輪衍生，四項）** ①**`signup` 的 `available` 用交易外快照 `event.capacity`**（`registration-service.ts`）：今日安全僅因 D-010 G1 保證 capacity 單調不減（stale 偏小→保守落候補）；**若日後實作「縮減名額」，此行必須改為鎖內 `fresh.capacity`，否則靜默超賣**（architect nit，T-019）。②**測試檔不受 `tsc` 型別檢查**（`tsconfig` 排除 `*.test.ts`、eslint 未開 type-checked）⇒ 介面新增必填欄位時漏改測試呼叫端會以 `undefined` 靜默通過＝假綠；候選對策：獨立 tsconfig 跑 `tsc --noEmit` 涵蓋測試。**此為本專案第 3 次假綠類問題**，見 LESSONS 2026-08-19。③**conversation TTL（OP-6）**：複合 PK 後殘列上限由「人數」變為「人數×群數」，TTL 必要性略升；另流程綁群後，使用者離開原群／bot 被移出時該列再也無法用 `取消` 清掉，只能靠 `開團` 覆寫自癒。~~④範例日期過期~~ **已由 T-023 解決並 merge（2026-08-22，PR #13）**。
- **（同群互斥，D-011 §1 / D-013 範圍外）** 同一群內「開團問答 ↔ 分組 session」仍共用 `conversation_states` 同一列（state 二選一）：該群有分組 session 時打 `開團` 會覆寫它（已附「已結束你先前未完成的分組。」告知）。若要並行需 PK 再加 state 維度或分表 ⇒ 另案。
- **（新功能，下一個可動工項）「我的球聚」個人待辦查詢**：規格與四項實作前提**已於 2026-08-22 移入 `docs/00-project-brief.md` FR-7**（需求屬 brief，不該長期寄居 board）。五項決策 2026-08-05 全數裁決完畢，**動工只差 D-009 設計文件，可直接派 architect**。風險 R1（若需為 `registrations.owner_user_id` 建索引則升 R2）。
- **【已裁決 2026-08-22：不做】開球前提醒推播——商業化之前不做。** ＋**H2「關閉報名時 @ 正取者」一併不做**：`關閉報名` 既已裁決移除，就沒有可搭便車的回覆時機（reply 不計費），只剩主動推播（計費）⇒ 與上一條裁決一致。兩項的研究與規格保留於下方備查，恢復評估時直接沿用。
- **（P1 前期研究備查，2026-08-05 完成）開球前提醒的 push 費用**：**結論——技術上可行、免費層夠用，但有兩個前提未定**。①`replyMessage` 不計費（本專案至今零訊息成本之因）；`push`/`multicast` 計費且**按收訊人數計，推播到群組＝按群組總人數計**。②台灣輕用量方案 200 則/月且**不可加購**、超出直接 API 錯誤＋訊息不送出。③試算：推播給正取者本人 12 則/場 ⇒ 免費層約 **16 場/月**；推播到群組（30 人）30 則/場且吵到沒報名者 ⇒ 應走個別 multicast。④**待實測**：個別推播是否要求對方已加好友（決定能否覆蓋全部報名者）。完整計費規則與方案表見 `docs/01-architecture.md`「訊息費用結構」。**尚未決定是否實作**；若要做，另需排程器（Cloud Run min-instances=0 無排程能力）與一條非 LINE 驗簽的 cron 入口 ⇒ 建議開 ADR 而非當普通 feature。
- **（後續優化，使用者裁決 2026-08-02／T-015 衍生）整批原子遞補**：`pickWaitlistForPromotion` 以**列**為單位 `LIMIT`，當剩餘名額 < 候補隊首批次人數時會**拆散整批**（剩 1 位、隊首 `+2 陳先生` → 1 列轉正取、1 列留候補），與 G1 進場「整批不部分接受」的原子性不對稱。使用者已裁決**本次先允許拆批**。實作需求：`registrations` 新增 `batch_id` 欄位（同批共用；`0001_init.sql` 現無此欄，`seq` 無法可靠推斷批次）→ 屬 **migration ⇒ R2**（需 D-003 或新設計文件 + 雙 reviewer）。另需決策：額度塞不下隊首批次時採「跳過該批、遞補得下的後批」（不留空位但可能插隊）或「整批卡住等待」（嚴格 FIFO 但留空位）。回歸測試已釘住現行拆批行為：`[D-003 AC-21]` 第 2 案。
- **（e2e 待辦，整合階段或發布前）** ①代報名（`+1 名字`）與候補遞補案例補入 e2e-tester 清單；②architect-reviewer nit-1：D-003 雖標 R1，因含授權（主辦 override）+ 刪除類（soft-delete），e2e 至少需涵蓋 AC-17（主辦跨 owner 代取消觸發 FIFO 遞補）。未阻擋任何已完成任務。

- ~~**D-018 遺留：backfill 群組的 `group_name` 為 NULL**~~ → **已解（2026-08-28，T-031）**。
  新增 `npm run db:backfill-names`（`scripts/backfill-group-names.ts`，附 `--dry-run`），
  對 PROD 5 列補名全數成功、零失敗，現存群組已無缺名。腳本保留供日後再有 backfill 列時重跑。
