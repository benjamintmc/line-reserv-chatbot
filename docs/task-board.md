# Task Board（任務看板）

> 擁有者：orchestrator，**唯一可寫者**（見 `harness/OWNERSHIP.md`）。跨 session、跨模型的共同記憶。
> 各角色以 `docs/worklists/<role>.md` 的「狀態提議」提出 `PROPOSE → DONE`，由 orchestrator 驗證後裁定。
> 只保留未完成 + 最近 10 筆 DONE，其餘見 `docs/task-board-archive.md`。

## 目前階段：**已上線（PROD LIVE，2026-08-02）**。T-012（PG 移植）DONE + T-014（單場自動釋放，D-008）DONE，R2 全通過、271 tests 綠、AC 142/142。**部署完成**：依 `docs/deployment-runbook.md` 走完 Neon 建DB→直連 migrate(0001/0002/0003)→build/push image→Cloud Run deploy→LINE webhook Verify→真機冒煙，全數通過。線上座標見 runbook 附錄「上線座標」。Service：`https://golf-reserv-chatbot-1006751446489.asia-east1.run.app`（GCP `group-chatbot-504305` / `asia-east1` / min-instances=0 / Neon 免費層 = $0/月）。後續選項：`--min-instances=1` 消除冷啟遺失窗口（犧牲 $0）、Secret Manager 收斂 secret（post-MVP）
>
> **2026-08-05 harness 1.4.0 升級完成（T-016）**：補齊三代框架缺件、回填 CLAUDE.md、
> 反向文件化 01-architecture 與 02 指令契約（原為空白模板）、修好 3 個會產生錯誤訊號的 checks
> 缺陷並加上 GitHub Actions。
>
> **2026-08-22 T-017 LESSONS 回寫清償完成**：9 項達門檻教訓落到 6 個點（CLAUDE.md §4 兩條通則、
> D-000 模板三處、兩份 reviewer 角色檔、審查包 §3.5、DoD 兩條），回寫機制首次成規模運轉。
> 同日裁決：nit-6（過期死團）刪除不做；範例日期改動態產生（T-023 DONE）。**PR #13 已 merge、main CI 綠**
> ——併修掉一個自 2026-08-19 起無人察覺的 **CI 永久紅**（`check_commit_trace` 誤判 squash merge；見 LESSONS）。

## 看板
| ID | 任務 | 設計文件 | 風險 | 負責角色 | 狀態 | 產出路徑 | 備註 |
|---|---|---|---|---|---|---|---|
| T-023 | **開團範例日期動態產生**（4 處寫死 `2026/08/15` 已過期 → 改「今日+7 天」，時鐘以參數注入保持純函式可測） | 任務單內 stub（R0，見下方「T-023 設計 stub」） | R0 | backend-engineer | **DONE（2026-08-22）** | src/domain/event-formatter.ts, src/webhook/handler.ts, src/domain/event-formatter.billing.test.ts | **四關全綠**（lint 0、build、**371 tests**（+3）、harness --strict）。AC-1 通過且超出要求：另測時區邊界（UTC 08-21T16:30Z＝台灣 08-22 仍得 2026/08/29）與「其餘文案一字不改」回歸鎖。Guardrail 無違反——`exampleDate(nowIso)` 由 handler 注入時鐘，formatter 內無 `new Date()`。R0 依 §5 跳過 reviewer。commit `84b0a13` |
| T-018 / T-019 / T-020 / T-021 / T-022 | 分組／加開名額／多行批次報名／跨群根治（五筆） | D-010〜D-013 | R1–R2 | backend-engineer | **全數 DONE（2026-08-19）、PR #12 已 merge、PROD v3 已部署** | – | 明細已於 2026-08-22 移入 `docs/task-board-archive.md`（doc-budget ≤80 行）|

### T-023 設計 stub（R0，依 CLAUDE.md §5「R0 不建 D 檔」）
1. `event-formatter.ts` 目前 4 處把範例日期寫死為已過期的 `2026/08/15`，對新使用者是錯誤示範。
2. 改為由呼叫端注入「今日」（台灣時區），範例日期取 **今日 +7 天**，格式沿用既有 `YYYY/MM/DD`。
3. 為保持純函式（D-006 G4：formatter 對 LINE 零耦合、可純測），時鐘**以參數注入**，不得在 formatter 內呼叫 `new Date()`。
4. 僅動範例字串，其餘文案一字不改；日期格式沿用既有 `utcIsoToTaipei` 的呈現慣例，不另創格式。
- **Guardrail**：不得在 `event-formatter.ts` 內直接取系統時間（破壞純函式與可測性）。
- **AC-1**：注入 `2026-08-22` 時，`formatFlowPrompt('awaiting_date')`、`formatFieldError('awaiting_date')` 與一行式格式提示皆顯示 `2026/08/29`；注入不同日期時範例隨之改變。（執行：`npm test`）

## M5 部署（Cloud Run + Neon PG）任務
> 6 筆（ADR-004／D-007／T-012／D-008／T-014／T-015）全數結案、PROD 已上線，**2026-08-19 移入 `docs/task-board-archive.md`**。結論見開頭「目前階段」與 `docs/deployment-runbook.md`。


## harness 維運任務
| ID | 任務 | 設計 | 風險 | 角色 | 狀態 |
|---|---|---|---|---|---|
| T-016 | **harness 1.1.0 → 1.4.0 升級 + 文件斷層修補**（框架缺件、CLAUDE.md 回填、反向文件化 01/02、checks 跨平台修正 + CI） | – | R1 | orchestrator | **DONE（2026-08-05）**。五個階段全完成：①1.2/1.3/1.4 三代缺件補齊（TOKEN-BUDGET/OWNERSHIP/審查包/worklists/2 支 check）②CLAUDE.md 補 §4 指令表、§4.5 既有專案現況、§8/§9，並校正 fastify 4→5、移除已不存在的 better-sqlite3 ③01-architecture 與 02 指令契約由 codebase 反向產生（原為空白模板）④修 3 個 checks 缺陷（cp950 假紅、Windows 路徑 no-op 假綠、粗體 APPROVED 漏檢）+ `npm run harness:check` + GitHub Actions ⑤本次歸檔。**驗證**：lint 0、build 綠、274 tests 全綠零回歸、4 項反向測試確認新檢查真的會抓 |
| T-017 | **LESSONS 回寫清償**：達門檻項目轉為具體落點（CLAUDE.md 條文 / D-000 模板欄位 / reviewer checklist / 審查包自檢），逐條交使用者核可後生效並補「已回寫紀錄」 | – | R1 | orchestrator | **DONE（2026-08-22）**。**實為 9 項非 5 項**——原盤點為 2026-08-05 當時狀態，T-018~T-022 一輪又新增 4 項達門檻（狀態表 scope 比對 ×2、釘死字串失同步 ×2、AC 未落可執行機制 ×2、審查包 diff 範圍不全 ×2）。9 項全數清償，落 6 個點：`CLAUDE.md` §4（去重政策 + 鎖內決策輸入，**使用者核可動憲法**）、`design/D-000-TEMPLATE.md`（預列 errata 欄位 / conversation state 三件套表 / AC 須註明執行方式）、兩份 reviewer 角色檔固定檢查項、`REVIEW-PACKET-TEMPLATE` §3.5、`DEFINITION-OF-DONE` 通用段兩條。**本次純文件、零碼改動**；碼面收斂另立 Backlog 兩條（皆碰 R2 模組，不夾帶） |

## 設計文件狀態
| 設計 ID | 功能 | 撰寫者 | 狀態（DRAFT/IN_DISCUSSION/APPROVED） |
|---|---|---|---|
| D-014 | DB 連線 TLS 驗證顯式化（移除不可達的 `rejectUnauthorized:false`、連線字串收斂為 `sslmode=verify-full`、升級金絲雀測試） | orchestrator | **DRAFT — 暫緩（2026-08-22 使用者裁決排入 Backlog）**。R1。4 Guardrails / 7 AC（含 2 條真機 AC）。設計已完備，恢復動工只差核可 → 解鎖 T-024 |
| D-001 | 資料模型（per-slot、候補、代報名） | architect | APPROVED（2026-07-22，reviewer 通過 + errata + 使用者核可） |
| D-002 | 指令解析 command parser（+N/-N/名單/開團；全形/上限/邊界） | backend-engineer | APPROVED（2026-07-23，reviewer 通過 + errata + 使用者核可） |
| D-003 | 報名核心（額滿判斷/整批轉候補/FIFO 遞補/名單訊息組版/webhook 接線） | backend-engineer | **APPROVED（2026-07-31）** — architect-reviewer 通過 + nit-2/5 採納 + 使用者最終核可（OP-1~4 已裁決；風險 R1） |
| D-004 | 開團流程（開團一行式/逐步問答、event 狀態機、host 白名單授權、確認/關閉/取消活動、conversation_states） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 零 blocker + design 2 blocker 已修）、OP-1~9 定案、使用者核可 |
| D-005 | 計費模式擴充（每人固定 vs 場地費均攤：估算/關閉結算/無條件進位/主辦自動登記為第一人）+ 文案中性化（忽略球種） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 條件式零 blocker + design 3 blocker 已修）、OP-1~4 定案、使用者核可。D-001 errata 已補 |
| D-006 | 授權簡化（開團全開 + 關閉/取消限建立者 host_user_id 或 super-admin；作廢管理人認領方案） | backend-engineer | **APPROVED（2026-07-31）** — R2 雙審通過（architect 零 blocker + design 3 blocker 已修）、OP 採建議、使用者核可 |
| D-007 | PG 移植 + serverless 部署（repository 換 PG、FOR UPDATE、pooler、先處理再回200、migration PG 方言、Dockerfile） | architect | **APPROVED（2026-08-01）** — R2 雙審通過（design + architect 零 blocker）、B1 路線 A / B2 int4 IDENTITY 兩 blocker 封閉、OP-1~7 定案、使用者最終核可 |
| D-008 | 單場名額自動釋放（合併 event_datetime、closed/過期自動釋放、惰性 on-read 過期判定、過期顯示 done） | architect | **APPROVED（2026-08-02）** — R2 雙審通過（architect 零 blocker + design B1/B2 修訂後封閉）、使用者最終核可。三讀取點語意 + 索引拆兩半 + UTC+8；5 Guardrails / 13 AC |
| D-011 | 分組（策略A 均分 3–4／策略B 多輪輪替 2v2＋單打、逐輪 `下一輪`、中性文案、conversation_states session） | backend-engineer | **APPROVED（2026-08-17）** — 使用者最終核可；4 項裁決 + 單打模式 + 逐輪揭示回填。6 Guardrails / 24 AC。解鎖 T-018 |
| D-010 | 開團後加開名額（只加不減、鎖內改 capacity + 立即遞補候補、`加開 N`、單則公告+遞補通知） | backend-engineer | **APPROVED（2026-08-17）** — R2 雙審 PASS + 使用者核可。nits 待 T-019：抽共享 authz helper、`promoteWithinLock` 共用。解鎖 T-019 |
| D-012 | 多行批次報名（一則多行、每行 `+N`/`-N` 逐行執行、`message.id#行號` 去重、一次 reply≤5則合併回覆） | backend-engineer | **APPROVED（2026-08-17）** — R1；design-reviewer PASS + 使用者核可。3 決策回填、字串釘死。解鎖 T-020。＋2026-08-19 errata（§一.3）：取消行同報名行聚合 |
| D-013 | conversation_states PK 改 `(group_id, line_user_id)`（跨群流程並行；migration 0004、repo 簽名、(N2) 收斂） | **orchestrator 代筆**（architect 連 4 次 API 529） | **APPROVED（2026-08-19）** — R2 雙審通過（architect 2 輪 PASS／design 3 輪 PASS，**合計 10 條 blocker 全封閉**，其中 2 條為 orchestrator 修補時自行引入）+ 使用者核可。8 Guardrails / 10 AC。約束名 `conversation_states_pkey` 已對真 PG 實測查證。解鎖 T-022 |

## 阻塞清單
| ID | 阻塞原因 | 等待對象 |
|---|---|---|
| （無，僅餘一項未驗）| 五任務（T-018~T-022）皆 DONE、PR #12 已 merge（CI 綠）、**2026-08-19 已部署 PROD**（image `:v3`／revision `00003-7lc`；0004 已套用，PK 實測 `(group_id, line_user_id)`、`group_id` NOT NULL；`/health` 200）。**2026-08-22 使用者回報：分組／多行報名／加開名額三項正向流程 PROD 實測通過。**　**唯一未驗：跨群修復（T-021/T-022）**——需兩個群才測得出來：A 群 `開團` 問答途中改到 B 群發言／打 `確認`，預期 B 群不攔截且**不得**把 A 群 draft 建成 B 群活動；另 `下一輪` 不得外洩他群名單。**不阻擋新工作**（PG 層 0004 已實測、368 tests 綠）| 使用者（有兩群時順手驗） |

## Backlog（含暫緩的 TODO）
- **（資安盤點，2026-08-22，使用者裁決全數暫緩）** 明細見 **[`docs/security-review-2026-08-22.md`](security-review-2026-08-22.md)**（每項附落點 + 動工前必讀 + 建議順序）。摘要：**T-024／D-014（H1，DB TLS 顯式化，R1，設計已備妥待核可）**、M2 Secret Manager、M3 webhook 無限流、M4 `textV2` 的 `{}` 未跳脫（**＝T-006 nit-3 第二次提出**）、M5 log 寫入 PII、M6 開團鎖死無回收（R2）、M7 容器 root + 無 `.dockerignore`。**H1 初判「高」經實測降為「中（潛伏）」——PROD 目前其實有完整憑證驗證，真風險是 pg v9 升級時靜默失去驗證。** 另含 **L1–L5 低疑慮**（`我的ID` 全群可見／無資料保存期限與刪除路徑（**與既有 conversation TTL OP-6 同族，宜合併**）／CI 無 `npm audit`／特權操作無稽核軌跡／host 可代取消他人名額）——記錄備查，不建議單獨開任務。**共 12 條：H1、M2–M7、L1–L5（無 M1，編號習慣不一致非遺漏）。** 建議起手：M7（兩行）→ T-024。
- **（工具面，2026-08-22）`eli5` skill 的評測工作區暫緩**：已建 `.claude/skills/eli5/SKILL.md`（中文化自 https://github.com/dreambigou/eli5 ，MIT），本次**刻意只做 skill 本體**。原 repo 另有 `evals.json` + `run-evals.py`（同一 prompt 跑 with-skill / baseline 兩次，再用 Claude 依 assertions 自動評分、印通過率），若日後要驗證這個 skill 真的有效再補。**與產品無關、不影響任何交付關卡**（不進 `npm run harness:check`）。
- **（T-017 衍生，2026-08-22，兩條「規則已立、碼未收斂」）** T-017 只做規則回寫、刻意不夾帶碼改動，故留下兩筆待收斂：
  ①**拒絕回覆去重政策的碼面收斂**：CLAUDE.md §4 已定通則「凡會送出回覆的訊息（含拒絕）一律消費 `message.id`」，但現行碼仍不對稱——`no_open_event` 等純拒絕分支在 `markProcessed` **之前** early-return（`registration-service.ts` signup/cancel），`getListView` 與分組策略A 則已先 mark。使用者可見症狀：LINE 重送時拒絕訊息會重覆出現。**碰 `registration-service.ts` / `event-service.ts` ⇒ R2**，需設計文件 + 雙審；動工時須窮舉所有 early-return 點。
  ②**D-007 §3「cancel candidates 唯讀讀安全」需 errata**：`freedConfirmed` 是決策輸入而非單純讀，該段措辭與 CLAUDE.md §4 新增的「決策輸入必須鎖內取得」不一致（實作已於 T-012 B1 修正為鎖內 RETURNING，僅文件未同步）。**純文件 errata，R1**。
- **（產品面，使用者提出 2026-08-19）`關閉報名` 是否為必要指令**：使用者傾向**移除**，改為「日期到了自動結算」。現行 `closeEvent` 綁三件事——①截止報名（連 `-N`/`加開` 一併擋，且**不可逆**，無 `closed → open` 指令）②`split_venue` 凍結 `settled_per_person` ③離開 active 集以釋放單一活動槽位。移除前須解掉：**(a)** 槽位釋放改由「過期」單獨承擔 ⇒ 同群要提前開下一場必須等活動時間過去（現行可用關閉繞過）；**(b)** 凍結時機移到過期當下，但 Cloud Run min-instances=0 **無排程器** ⇒ 只能沿用 D-008 惰性 on-read 寫入（首次讀取者觸發，需防並發重複寫）；**(c)** 好處是「關閉後沒人能退出／不可逆」兩個坑自然消失。**不影響現行使用，暫不動工**；動工需新設計文件（動 `events` 狀態機 ⇒ R2）。
- **（2026-08-19 本輪衍生，四項）** ①**`signup` 的 `available` 用交易外快照 `event.capacity`**（`registration-service.ts`）：今日安全僅因 D-010 G1 保證 capacity 單調不減（stale 偏小→保守落候補）；**若日後實作「縮減名額」，此行必須改為鎖內 `fresh.capacity`，否則靜默超賣**（architect nit，T-019）。②**測試檔不受 `tsc` 型別檢查**（`tsconfig` 排除 `*.test.ts`、eslint 未開 type-checked）⇒ 介面新增必填欄位時漏改測試呼叫端會以 `undefined` 靜默通過＝假綠；候選對策：獨立 tsconfig 跑 `tsc --noEmit` 涵蓋測試。**此為本專案第 3 次假綠類問題**，見 LESSONS 2026-08-19。③**conversation TTL（OP-6）**：複合 PK 後殘列上限由「人數」變為「人數×群數」，TTL 必要性略升；另流程綁群後，使用者離開原群／bot 被移出時該列再也無法用 `取消` 清掉，只能靠 `開團` 覆寫自癒。~~④範例日期過期~~ **已由 T-023 解決並 merge（2026-08-22，PR #13）**。
- **（同群互斥，D-011 §1 / D-013 範圍外）** 同一群內「開團問答 ↔ 分組 session」仍共用 `conversation_states` 同一列（state 二選一）：該群有分組 session 時打 `開團` 會覆寫它（已附「已結束你先前未完成的分組。」告知）。若要並行需 PK 再加 state 維度或分表 ⇒ 另案。
- **（新功能，下一個可動工項）「我的球聚」個人待辦查詢**：規格與四項實作前提**已於 2026-08-22 移入 `docs/00-project-brief.md` FR-7**（需求屬 brief，不該長期寄居 board）。五項決策 2026-08-05 全數裁決完畢，**動工只差 D-009 設計文件，可直接派 architect**。風險 R1（若需為 `registrations.owner_user_id` 建索引則升 R2）。
- **（P1 前期研究，2026-08-05 完成）開球前提醒的 push 費用**：**結論——技術上可行、免費層夠用，但有兩個前提未定**。①`replyMessage` 不計費（本專案至今零訊息成本之因）；`push`/`multicast` 計費且**按收訊人數計，推播到群組＝按群組總人數計**。②台灣輕用量方案 200 則/月且**不可加購**、超出直接 API 錯誤＋訊息不送出。③試算：推播給正取者本人 12 則/場 ⇒ 免費層約 **16 場/月**；推播到群組（30 人）30 則/場且吵到沒報名者 ⇒ 應走個別 multicast。④**待實測**：個別推播是否要求對方已加好友（決定能否覆蓋全部報名者）。完整計費規則與方案表見 `docs/01-architecture.md`「訊息費用結構」。**尚未決定是否實作**；若要做，另需排程器（Cloud Run min-instances=0 無排程能力）與一條非 LINE 驗簽的 cron 入口 ⇒ 建議開 ADR 而非當普通 feature。
- **（H2，使用者提出 2026-08-05）關閉報名時 @ 正取者**：`關閉報名` 的回覆**在同一則訊息內** mention 所有正取者（裁決：單則，不拆多則）。代報名列**只 tag 報名者本人（代報者）**，被代報的人頭無 userId、不 tag。**風險 R1**（無 schema 變更；mention 機制已於候補遞補通知驗證）。要點：①同一人有多列（本人＋代報）時只 tag 一次，避免重複 @ ②需確認 mention 數量上限與單則訊息長度上限，**若正取人數超過上限需先裁決降級行為**（截斷並附「等 N 人」或改列名不 mention）③沿用 `textV2` + `substitution`（`{mN}` placeholder）④文案需與既有 `formatClosed` 整合，勿新增第二種「已截止」措辭（LESSONS ×2 詞彙一致性）。
- **（後續優化，使用者裁決 2026-08-02／T-015 衍生）整批原子遞補**：`pickWaitlistForPromotion` 以**列**為單位 `LIMIT`，當剩餘名額 < 候補隊首批次人數時會**拆散整批**（剩 1 位、隊首 `+2 陳先生` → 1 列轉正取、1 列留候補），與 G1 進場「整批不部分接受」的原子性不對稱。使用者已裁決**本次先允許拆批**。實作需求：`registrations` 新增 `batch_id` 欄位（同批共用；`0001_init.sql` 現無此欄，`seq` 無法可靠推斷批次）→ 屬 **migration ⇒ R2**（需 D-003 或新設計文件 + 雙 reviewer）。另需決策：額度塞不下隊首批次時採「跳過該批、遞補得下的後批」（不留空位但可能插隊）或「整批卡住等待」（嚴格 FIFO 但留空位）。回歸測試已釘住現行拆批行為：`[D-003 AC-21]` 第 2 案。
- **（e2e 待辦，整合階段或發布前）** ①代報名（`+1 名字`）與候補遞補案例補入 e2e-tester 清單；②architect-reviewer nit-1：D-003 雖標 R1，因含授權（主辦 override）+ 刪除類（soft-delete），e2e 至少需涵蓋 AC-17（主辦跨 owner 代取消觸發 FIFO 遞補）。未阻擋任何已完成任務。

## 決策待辦（需使用者裁決）
- （無）「我的球聚」五項決策已於 2026-08-05 裁決完畢，規格見 `docs/00-project-brief.md` FR-7——已具備開 D-009 的條件。
