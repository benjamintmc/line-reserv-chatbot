# LESSONS — 經驗回寫（讓 harness 自我進化）

> 擁有者：orchestrator。reviewer / tester 發現的**重複性**問題記錄於此；
> 同類問題出現 ≥ 2 次即為「回寫候選」，由 Orchestrator 提案寫入 CLAUDE.md 慣例、
> 設計文件的 Guardrails 模板、或新增 harness/checks/ 自動檢查，經使用者同意後生效。

## 回寫流程
1. reviewer/tester 在報告中標記「疑似重複問題」→ Orchestrator 登記到下表。
2. 次數達 2 → Orchestrator 於階段回報時向使用者提案回寫（附建議措辭與落點）。
3. 使用者同意 → 更新目標文件，並在下表標記「已回寫（連結）」。

## 問題登記表
| 日期 | 發現者 | 問題描述 | 次數 | 狀態（觀察中/已回寫） | 回寫落點 |
|---|---|---|---|---|---|
| 2026-08-05 | orchestrator(T-016) | **harness 版本落後三代（1.1.0 vs 1.4.0）無人察覺**——但**不是因為沒記錄**：三份交接快照都老實填了「harness 版本：1.1.0」。缺的是**比對對象**——框架自身沒有「上游最新版是多少」的概念，記了也無從發現落後。更關鍵的是連帶的三個 checks 缺陷（cp950 假紅、Windows 路徑 no-op 假綠、粗體 APPROVED 漏檢）長期存在未被發現：**假綠的檢查比沒有檢查更糟**，它讓人以為關卡有在把關。 | 1 | 觀察中 | 候選：①check 腳本加 self-test（餵一筆已知應失敗的輸入，確認真的會抓；假綠自曝）②DoD 或 handoff 加「本次是否驗證過 checks 真的會失敗」一項，而非只看它「有沒有通過」 |
| 2026-07-22 | backend(T-004) | better-sqlite3 最新版對新 Node ABI 常無 prebuilt，本機無 C++ 工具鏈時 node-gyp rebuild 失敗。Node 24（ABI 137）須 pin `better-sqlite3@^12.4.1` 才有 win32-x64 prebuilt。 | 1 | 觀察中 | 候選：CLAUDE.md §4 依賴版本註記 / 部署映像裝 build tools |
| 2026-07-22 | orchestrator(T-004 驗證) | 本機 `python`/`python3` 是 Windows Store app 別名 stub（exit 49、無輸出、非真 Python）；harness Python 檢查須用 `py` launcher（Python 3.9.13）。 | 1 | **已回寫（2026-08-05）** | `npm run harness:check` 自動偵測直譯器；見下方已回寫紀錄 |
| 2026-07-22 | orchestrator(T-004 驗證) | backend 測試名用 `AC-n：…` 未帶 `D-001` 前綴，`check_ac_coverage.py` 需 `[D-001 AC-n]` 格式，導致覆蓋 0/13。 | 1 | 觀察中 | 候選：CLAUDE.md §6 或 backend/unit-tester agent 指示明列標記格式 |
| 2026-07-31 | orchestrator(T-007 跨試) | `npm run dev`（tsx watch）**只監看 .ts 變更，不因 .env 改動而重載**；改 env var（如 DEBUG_WEBHOOK）後必須 Ctrl+C 重啟才生效。debug 期易誤判「沒反應」。 | 1 | 觀察中 | 候選：runbook 已註記；可加開發提示 |
| 2026-07-31 | orchestrator(T-007 跨試) | LINE **Verify 成功 ≠ 使用者訊息會送 webhook**：官方帳號 Response mode 須為 **Bot**（非 Chat）、且 OA Manager Webhook 開啟、自動回應關閉，訊息事件才會進 webhook。 | 1 | 觀察中 | 候選：runbook 疑難排解（已列） |
| 2026-07-31 | orchestrator(T-007 跨試) | Windows 終端 console codepage 非 UTF-8 → Pino log 中文顯示亂碼（僅顯示層，JS 字串/DB/回覆正常）；`chcp 65001` 可解。 | 1 | 觀察中 | 候選：runbook 註記 |
| 2026-07-31 | orchestrator(T-006 驗證) | LINE `getGroupMemberProfile`（單一成員 profile）所有帳號可用；但「取成員 ID 清單」需 verified/premium。設計只用單一 profile（userId 來自 webhook）故不受限——未來若做「@全員/列未報名者」需列舉成員則需 verified 帳號。 | 1 | 觀察中 | 候選：M4 規劃 / project-brief non-goals |
| 2026-07-31 | design-reviewer(D-004,D-005) | **新增 conversation state 時漏定義「無效答案重問範本」→ 靜默死角**：D-004 B2（awaiting_confirm）+ D-005 B1（awaiting_price_mode/venue_fee）同型。 | **2** | **已回寫（2026-08-22，T-017）** | `design/D-000-TEMPLATE.md` §一「Conversation state 三件套」必填表 + `harness/DEFINITION-OF-DONE.md` 通用段 |
| 2026-07-31 | architect-reviewer(D-005) | **D-001 G2「registrations 寫入必須 IMMEDIATE」措辭過寬**：未區分「read-decide-write 容量操作（需 IMMEDIATE 防超賣）」與「write-first 交易下的盲插首列（DEFERRED 足夠，如主辦自動登記）」。D-005 首次在 DEFERRED 內做 registration 寫入，字面違反 G2 需個案 errata。 | 1 | 觀察中 | 候選：D-001 G2 補 carve-out 通則（已排 APPROVED 後 errata）。 |
| 2026-07-31 | architect-reviewer(D-005) | **MVP 範圍文件（D-001/D-002/D-004）持續被後續 design 增量擴充 + 事後 errata**（D-004 兩次、D-005 對四份文件）。治理成本累積。 | **3** | **已回寫（2026-08-22，T-017）** | `design/D-000-TEMPLATE.md` §一「將改動的既有文件（預列 errata）」欄位——設計階段預列，取代事後逐次補 |
| 2026-08-01 | architect-reviewer(T-012) | **同步→非同步移植會激活「交易外快照當決策輸入」的既有 latent 超賣窗**：cancel 的 `freedConfirmed`（釋出正取數，驅動遞補）於交易**外**用取消前快照計算。SQLite 同步版「定位 candidates + runImmediate」單執行緒原子、無窗；T-012 sync→async 在兩 await 間插讓點 → 並發兩 cancel 鎖同列時 `cancelByIds` 的 `cancelled_at IS NULL` 守衛使實取數正確、但陳舊 `freedConfirmed` 仍遞補 → **正取數 > capacity 超賣**。**此為 task-board Backlog「T-006 reviewer nit-2」預言之條件（多實例/async）成真**。修法：於 FOR UPDATE 交易**內**由實際「取消且原為 confirmed」的列數推導 freedConfirmed（非交易外快照）。 | **2（承 2026-08-01 driver-swap 陷阱；且 T-006 nit-2 兌現）** | **已回寫（2026-08-22，T-017）** | `CLAUDE.md` §4 併發與冪等子項「決策輸入必須鎖內取得」。**未涵蓋**：D-007 §3「cancel candidates 唯讀讀安全」的 errata 仍待補（見 task-board Backlog） |
| 2026-08-01 | architect-reviewer(D-007) | **資料層換 driver 的兩個通用陷阱**（PG 移植/未來再換 driver 前置檢查）：①**交易內查詢跨連線 → 鎖失效靜默超賣**：pool 下若交易內各查詢用獨立 `pool.query()` 落到不同連線，`SELECT…FOR UPDATE` 的鎖與 INSERT 不同連線 → 鎖虛設。須「交易內所有查詢綁同一 checked-out client」（注入 client-bound repo 或 AsyncLocalStorage）。②**driver 預設型別解析改變 Row 型別**：node-postgres 預設 int8(BIGINT) 回 string、非 number → 打破 `Row.id:number` 型別假設。用 int4 或設 `pg.types.setTypeParser`。 | 1 | 觀察中 | 候選：migration 類任務設計 checklist 前置這兩檢查。 |
| 2026-07-31 | architect-reviewer(T-009) | **設計文件的 formatter/函式簽名未涵蓋其 AC 所需全部顯示欄位**：D-005 §5.1 `formatClosed(event, settledPerPerson)` 但 AC-7 需顯示「正取 K 人」→ 實作被迫擴為三參數 + errata。 | 1 | 觀察中 | 候選：design review checklist 加「formatter 簽名須涵蓋其 AC 要顯示的全部欄位」。 |
| 2026-07-31 | backend(T-008) | **設計文件「狀態行」加 markdown 粗體會使 `check_ac_coverage.py` 漏檢**：其 regex `狀態[:：]\s*(\w+)` 認不出 `狀態：**APPROVED**`，導致該設計的 AC 不納入覆蓋 → 假綠（D-004 22 條 AC 一度未計，顯示 58/58 實應 80/80）。狀態行請純文字 `狀態：APPROVED（日期）…`，勿加 `**` 粗體。 | 1 | **已回寫（2026-08-05）** | 採「放寬 regex」而非「要求人配合」；見下方已回寫紀錄 |
| 2026-07-31 | architect+design reviewer(D-004,D-006) | **「拒絕回覆」的去重 mark 政策不對稱**：純拒絕回覆（no_open_event / 非白名單 / 無 active / 重複開團）不 markProcessed → 重送同一拒絕會重覆回一次；有副作用步驟才 mark。D-003 T-006 nit-3、D-004 §9、**D-006（close/cancel no_active 前移交易外 early-return 不 mark）** 同型。 | **3** | **已回寫（2026-08-22，T-017）** | `CLAUDE.md` §4 併發與冪等子項「去重政策（拒絕回覆一律消費）」——**使用者裁決：凡會送出回覆的訊息一律消費 `message.id`**，例外僅「本來就不回覆」的路徑。**規則已立、現行碼尚未收斂**（碰 R2 模組，另立任務，見 task-board Backlog） |
| 2026-08-01 | orchestrator(T-012 期間) | **[已回寫 2026-08-05 → orchestrator 角色檔]** **背景 subagent 於同 repo 工作時，orchestrator 用 `git add -A` 會誤掃 agent 未提交的 WIP 進自己的 commit**：D-008 需求入 brief 時 `git add -A` 把 backend-engineer(T-012) 正在改的 5 個 `*.test.ts`（async 轉換）掃進 `docs:` commit，違反 commit 追溯慣例、混淆歸屬。以 `git reset --soft HEAD~1` + `git restore --staged <test 檔>` 拆開、還原成 agent WIP、重提純 docs。 | 1 | 觀察中 | 候選：orchestrator 提交文件變更時**只 stage 明確路徑**（`git add docs/ design/ harness/`），背景實作 agent 執行期**禁用 `git add -A/.`**；或提交前先 `git status` 確認無 agent WIP。 |
| 2026-07-31 | design-reviewer(D-006,D-008) | **跨文件部分改名造成使用者可見詞彙不一致**：D-006 (H′) 改「主辦人→開團的人」但 D-004 (I) 仍「主辦人」（同角色）；另訊息標籤 (F) 於 D-006 與 D-004 碰撞。**D-008 再現**：closed 狀態名單標「報名已截止」但既有 `formatClosed` 即時回覆為「已關閉報名」（同狀態相鄰流程兩詞），errata 未盤點既有範本。設計改動涉及既有 user-facing 範本時，未全域掃描同義詞/標籤。 | **2** | **已回寫（2026-08-22，T-017）** | `.claude/agents/design-reviewer.md` 職責 4「固定檢查項」第一條（改既有 user-facing 文案須 grep 同狀態措辭） |

| 2026-08-18 | architect+design reviewer(T-018,F1) | **以 `line_user_id` 為 PK 的狀態表，讀取端未連同 scope 欄位比對 → 跨群誤攔截/資訊外洩**：`conversation_states` 寫入時**有**存 `group_id`，但 5 個讀取點全都只用 `line_user_id` 查。三個出口：①開團問答跨群誤攔截（**使用者實際回報**：A 群開團中在 B 群發言被當成流程答案）②漏下去的 `確認` 會把 A 群 draft 建成 **B 群**活動 ③`下一輪` 讀到他群 session → 外洩他群凍結名單人名。**根因不是沒存 scope，是讀取端沒用**。 | **2（同輪 2 處：D-004 / D-011）** | **已回寫（2026-08-22，T-017）** | `.claude/agents/architect-reviewer.md` 職責 4「固定檢查項」兩條（讀取點須連 scope 比對；修復後複查新暴露路徑） |
| 2026-08-18 | architect-reviewer(F1) | **測試檔不受型別檢查 → 介面變更漏改測試呼叫端會造成假綠**：`tsconfig.json` 排除 `**/*.test.ts`、eslint 用 `recommended`（非 `recommendedTypeChecked`、無 `parserOptions.project`）。故「build 綠」**證明不了**測試呼叫端都改對了；漏改的必填欄位會以 `undefined` 執行，可能讓守衛靜默 noop、把真斷言變成**假通過**。本次 `AbortInput.groupId`/`NextRoundInput.groupId` 新增必填欄位即屬此風險（實地 grep 核對後確認無漏）。 | 1 | 觀察中 | 候選：①harness 加 `tsc --noEmit` 涵蓋測試檔（獨立 tsconfig）②介面新增必填欄位時，DoD 要求 grep 全部呼叫點並附證據。**此為本專案第 3 次「假綠」類問題**（前兩次見 2026-08-05 兩則），優先度應高。 |
| 2026-08-18 | design-reviewer(T-020) | **設計標「釘死」的字串與 formatter 實作不同步**：D-012 §一.3 釘死「已報名：{名字、名字…}」（聚合）但實作逐行一句；修正報名側後，取消側反向失配（實作聚合、設計仍為單數「已取消：{名字}」）。**危險在於下一位讀設計的 agent 會把它「修」回去**，形成無盡循環。 | **2（承 2026-07-31 D-005 formatter 簽名未涵蓋 AC 欄位）** | **已回寫（2026-08-22，T-017）** | `.claude/agents/design-reviewer.md` 職責 4「固定檢查項」第二條（釘死字串逐字比對，改實作或補 errata 二選一必須發生） |

| 2026-08-19 | architect-reviewer(D-013) | **AC 寫成「用現有工具跑不出來」的形式**：D-013 AC-3 要求「對含 `group_id IS NULL` 殘列的 DB 執行 0004 並斷言」，但 `runMigrations` **無「套用至指定版本」能力**，且 0004 後該欄為 NOT NULL 無法再造 NULL 列 ⇒ 該 AC 無法以一般測試流程執行，只能特製 setup 或降級為人工檢查。與同日登記的「測試檔不受 `tsc` 檢查，須靠 grep 核對」同屬**驗收手段未落到可執行機制**。 | **2** | **已回寫（2026-08-22，T-017）** | `design/D-000-TEMPLATE.md` §三 標題說明 + AC 範例行改為「（執行：…）」——把可執行手段前移到設計階段 |

| 2026-08-19 | architect-reviewer(T-019,T-022) | **orchestrator 產的審查包 diff 範圍不全，導致 reviewer 無法只讀審查包完成審查**：T-019 時把 `server.ts`/`parse.ts`/`handler.ts` 的 hunks 標「與他任務共用」而未附，reviewer 被迫展開原始檔；T-022 時 `git diff -- … src/webhook/handler.ts …` 誤寫成單檔（本意是 `src/webhook/`），**漏掉 `event-handler.test.ts`——AC-1/AC-2/AC-4 全在該檔**，只讀審查包的 reviewer 會直接漏驗三條 AC。違背 CLAUDE.md §9「reviewer 只讀審查包 + diff」的前提。 | **2** | **已回寫（2026-08-22，T-017）** | `harness/REVIEW-PACKET-TEMPLATE.md` 新增 §3.5「diff 範圍自檢」三項 + `harness/DEFINITION-OF-DONE.md` 通用段引用 |

## 已回寫紀錄（harness 演進史）
| 日期 | 回寫內容摘要 | 落點 | 版本 |
|---|---|---|---|
| 2026-08-05 | **`python3` 為 Windows Store stub**（原登記於問題表，2026-07-22）→ 不再要求各角色自行選直譯器：新增 `npm run harness:check` 統一入口，自動偵測 `py`/`python3`/`python` 並以實際輸出排除 stub。 | `scripts/harness-check.mjs`、CLAUDE.md §4 指令表、DoD 通用段 | 1.4.0 |
| 2026-08-05 | **設計文件狀態行加粗體會使 `check_ac_coverage.py` 漏檢**（原登記 2026-07-31，曾造成 D-004 的 22 條 AC 假綠）→ 採「放寬 regex」而非「要求人不要加粗體」：`狀態[:：]\s*\*{0,2}(\w+)`。同源的 DONE 計數一併修（原認不出 `**DONE（日期）**`，15 筆只數到 7 筆）。 | `harness/checks/check_ac_coverage.py`、`check_doc_budget.py` | 1.4.0 |
| 2026-08-05 | **orchestrator 用 `git add -A` 誤掃背景 agent 的 WIP**（原登記 2026-08-01）→ 落為角色檔鐵律：提交文件變更只 stage 明確路徑，背景實作 agent 執行期禁用 `git add -A/.`。 | `.claude/agents/orchestrator.md` 額外職責段 | 1.4.0 |
| 2026-08-22 (T-017) | **去重政策不對稱 ×3** → 使用者裁決通則：**凡本次會送出回覆的訊息（含純拒絕文案）一律消費 `message.id`**，重送不再回覆；例外僅「本來就不回覆」的路徑。`markProcessed` 須置於所有拒絕 early-return 之前。 | `CLAUDE.md` §4 併發與冪等 | 1.4.0（在地回寫） |
| 2026-08-22 (T-017) | **鎖內決策輸入 ×2** → 通則：「讀→決策→寫」的**決策輸入**（capacity、已用名額、可釋出數…）一律鎖內重讀，不得沿用交易外快照；「寫在鎖內」不等於安全。 | `CLAUDE.md` §4 併發與冪等 | 1.4.0（在地回寫） |
| 2026-08-22 (T-017) | **errata 治理成本 ×3｜conversation state 三件套 ×2｜AC 未落到可執行機制 ×2** → 三者全部前移到設計階段：預列 errata 清單欄位、三件套必填表、每條 AC 須註明用哪個指令可執行。 | `design/D-000-TEMPLATE.md` §一（兩個新段）、§三（標題說明 + AC 範例行） | 1.4.0（在地回寫） |
| 2026-08-22 (T-017) | **user-facing 詞彙未全域掃描 ×2｜釘死字串失同步 ×2** → design-reviewer 固定檢查項：改既有文案須 grep 同狀態措辭；設計標「釘死」的字串逐字比對（非語意），不一致時改實作或補 errata 二選一。 | `.claude/agents/design-reviewer.md` 職責 4 | 1.4.0（在地回寫） |
| 2026-08-22 (T-017) | **狀態表讀取點漏比對 scope ×2** → architect-reviewer 固定檢查項：以單一識別碼為 PK 的狀態／session 表，須窮舉所有讀取點確認每處都連 scope 欄位比對；修復既有缺陷後複查是否新暴露原不可達路徑。 | `.claude/agents/architect-reviewer.md` 職責 4 | 1.4.0（在地回寫） |
| 2026-08-22 (T-017) | **審查包 diff 範圍不全 ×2** → 交付前自檢：AC 對照表點名的每個檔案都須在 diff 中；R2 附全部受影響檔案；用目錄層級路徑產 diff。 | `harness/REVIEW-PACKET-TEMPLATE.md` §3.5 + `harness/DEFINITION-OF-DONE.md` 通用段 | 1.4.0（在地回寫） |

> **2026-08-22（T-017）：9 項達門檻項目全數清償**，回寫機制自此有實質運轉紀錄（此前僅 2026-08-05 的 3 筆）。
> **仍為「規則已立、碼未收斂」的兩處**（已登記 task-board Backlog，皆碰 R2 模組故不夾帶）：
> ①拒絕回覆去重的現行不對稱實作 ②D-007 §3「cancel candidates 唯讀讀安全」的 errata。
> 尚在觀察中（未達門檻）的項目仍留在上方問題登記表。
