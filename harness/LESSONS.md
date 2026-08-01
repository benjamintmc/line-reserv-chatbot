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
| 2026-07-22 | backend(T-004) | better-sqlite3 最新版對新 Node ABI 常無 prebuilt，本機無 C++ 工具鏈時 node-gyp rebuild 失敗。Node 24（ABI 137）須 pin `better-sqlite3@^12.4.1` 才有 win32-x64 prebuilt。 | 1 | 觀察中 | 候選：CLAUDE.md §4 依賴版本註記 / 部署映像裝 build tools |
| 2026-07-22 | orchestrator(T-004 驗證) | 本機 `python`/`python3` 是 Windows Store app 別名 stub（exit 49、無輸出、非真 Python）；harness Python 檢查須用 `py` launcher（Python 3.9.13）。 | 1 | 觀察中 | 候選：harness/checks/README 或 check 腳本 shebang/包裝改用 py |
| 2026-07-22 | orchestrator(T-004 驗證) | backend 測試名用 `AC-n：…` 未帶 `D-001` 前綴，`check_ac_coverage.py` 需 `[D-001 AC-n]` 格式，導致覆蓋 0/13。 | 1 | 觀察中 | 候選：CLAUDE.md §6 或 backend/unit-tester agent 指示明列標記格式 |
| 2026-07-31 | orchestrator(T-007 跨試) | `npm run dev`（tsx watch）**只監看 .ts 變更，不因 .env 改動而重載**；改 env var（如 DEBUG_WEBHOOK）後必須 Ctrl+C 重啟才生效。debug 期易誤判「沒反應」。 | 1 | 觀察中 | 候選：runbook 已註記；可加開發提示 |
| 2026-07-31 | orchestrator(T-007 跨試) | LINE **Verify 成功 ≠ 使用者訊息會送 webhook**：官方帳號 Response mode 須為 **Bot**（非 Chat）、且 OA Manager Webhook 開啟、自動回應關閉，訊息事件才會進 webhook。 | 1 | 觀察中 | 候選：runbook 疑難排解（已列） |
| 2026-07-31 | orchestrator(T-007 跨試) | Windows 終端 console codepage 非 UTF-8 → Pino log 中文顯示亂碼（僅顯示層，JS 字串/DB/回覆正常）；`chcp 65001` 可解。 | 1 | 觀察中 | 候選：runbook 註記 |
| 2026-07-31 | orchestrator(T-006 驗證) | LINE `getGroupMemberProfile`（單一成員 profile）所有帳號可用；但「取成員 ID 清單」需 verified/premium。設計只用單一 profile（userId 來自 webhook）故不受限——未來若做「@全員/列未報名者」需列舉成員則需 verified 帳號。 | 1 | 觀察中 | 候選：M4 規劃 / project-brief non-goals |
| 2026-07-31 | design-reviewer(D-004,D-005) | **新增 conversation state 時漏定義「無效答案重問範本」→ 靜默死角**：D-004 B2（awaiting_confirm）+ D-005 B1（awaiting_price_mode/venue_fee）同型。 | **2（回寫候選）** | 觀察中→**達 2 次，提案回寫** | 建議 checklist：新增任何 conversation state 必須同時交付 (a)初始提問 (b)無效答案重問範本 (c)對應 AC。落 harness/DEFINITION-OF-DONE 或 create-flow 設計指引。 |
| 2026-07-31 | architect-reviewer(D-005) | **D-001 G2「registrations 寫入必須 IMMEDIATE」措辭過寬**：未區分「read-decide-write 容量操作（需 IMMEDIATE 防超賣）」與「write-first 交易下的盲插首列（DEFERRED 足夠，如主辦自動登記）」。D-005 首次在 DEFERRED 內做 registration 寫入，字面違反 G2 需個案 errata。 | 1 | 觀察中 | 候選：D-001 G2 補 carve-out 通則（已排 APPROVED 後 errata）。 |
| 2026-07-31 | architect-reviewer(D-005) | **MVP 範圍文件（D-001/D-002/D-004）持續被後續 design 增量擴充 + 事後 errata**（D-004 兩次、D-005 對四份文件）。治理成本累積。 | **3** | 觀察中→**達 3 次，提案回寫** | 建議：確立「輕量 errata 協定」，或設計階段主動盤點「本設計會改動哪些既有文件的 AC/範例」預列 errata 清單（架構 R2 跨多文件功能尤需）；下次階段回報向使用者提案。 |
| 2026-08-01 | architect-reviewer(T-012) | **同步→非同步移植會激活「交易外快照當決策輸入」的既有 latent 超賣窗**：cancel 的 `freedConfirmed`（釋出正取數，驅動遞補）於交易**外**用取消前快照計算。SQLite 同步版「定位 candidates + runImmediate」單執行緒原子、無窗；T-012 sync→async 在兩 await 間插讓點 → 並發兩 cancel 鎖同列時 `cancelByIds` 的 `cancelled_at IS NULL` 守衛使實取數正確、但陳舊 `freedConfirmed` 仍遞補 → **正取數 > capacity 超賣**。**此為 task-board Backlog「T-006 reviewer nit-2」預言之條件（多實例/async）成真**。修法：於 FOR UPDATE 交易**內**由實際「取消且原為 confirmed」的列數推導 freedConfirmed（非交易外快照）。 | **2（承 2026-08-01 driver-swap 陷阱；且 T-006 nit-2 兌現）** | 觀察中→**達 2 次** | 通則：**任何「讀-決策-寫」的決策輸入必須在鎖內取得，不得用交易外快照**（不僅是「寫」在鎖內）。落 D-001 G2 補述 / migration 類設計 checklist。D-007 §3「cancel candidates 唯讀讀安全」需 errata（freedConfirmed 是決策輸入非單純讀）。 |
| 2026-08-01 | architect-reviewer(D-007) | **資料層換 driver 的兩個通用陷阱**（PG 移植/未來再換 driver 前置檢查）：①**交易內查詢跨連線 → 鎖失效靜默超賣**：pool 下若交易內各查詢用獨立 `pool.query()` 落到不同連線，`SELECT…FOR UPDATE` 的鎖與 INSERT 不同連線 → 鎖虛設。須「交易內所有查詢綁同一 checked-out client」（注入 client-bound repo 或 AsyncLocalStorage）。②**driver 預設型別解析改變 Row 型別**：node-postgres 預設 int8(BIGINT) 回 string、非 number → 打破 `Row.id:number` 型別假設。用 int4 或設 `pg.types.setTypeParser`。 | 1 | 觀察中 | 候選：migration 類任務設計 checklist 前置這兩檢查。 |
| 2026-07-31 | architect-reviewer(T-009) | **設計文件的 formatter/函式簽名未涵蓋其 AC 所需全部顯示欄位**：D-005 §5.1 `formatClosed(event, settledPerPerson)` 但 AC-7 需顯示「正取 K 人」→ 實作被迫擴為三參數 + errata。 | 1 | 觀察中 | 候選：design review checklist 加「formatter 簽名須涵蓋其 AC 要顯示的全部欄位」。 |
| 2026-07-31 | backend(T-008) | **設計文件「狀態行」加 markdown 粗體會使 `check_ac_coverage.py` 漏檢**：其 regex `狀態[:：]\s*(\w+)` 認不出 `狀態：**APPROVED**`，導致該設計的 AC 不納入覆蓋 → 假綠（D-004 22 條 AC 一度未計，顯示 58/58 實應 80/80）。狀態行請純文字 `狀態：APPROVED（日期）…`，勿加 `**` 粗體。 | 1 | 觀察中 | 候選：harness check 放寬 regex 容許粗體 / 或 CLAUDE.md §2 文件契約註記狀態行格式 |
| 2026-07-31 | architect+design reviewer(D-004,D-006) | **「拒絕回覆」的去重 mark 政策不對稱**：純拒絕回覆（no_open_event / 非白名單 / 無 active / 重複開團）不 markProcessed → 重送同一拒絕會重覆回一次；有副作用步驟才 mark。D-003 T-006 nit-3、D-004 §9、**D-006（close/cancel no_active 前移交易外 early-return 不 mark）** 同型。 | **3（回寫候選，升級）** | 觀察中→**達 3 次，強烈建議回寫** | 建議：立一則通則「拒絕回覆是否消費 messageId」的統一去重政策（落 CLAUDE.md §4 或 handler 設計指引），供後續 handler 沿用。**下次階段回報向使用者提案回寫。** |
| 2026-08-01 | orchestrator(T-012 期間) | **背景 subagent 於同 repo 工作時，orchestrator 用 `git add -A` 會誤掃 agent 未提交的 WIP 進自己的 commit**：D-008 需求入 brief 時 `git add -A` 把 backend-engineer(T-012) 正在改的 5 個 `*.test.ts`（async 轉換）掃進 `docs:` commit，違反 commit 追溯慣例、混淆歸屬。以 `git reset --soft HEAD~1` + `git restore --staged <test 檔>` 拆開、還原成 agent WIP、重提純 docs。 | 1 | 觀察中 | 候選：orchestrator 提交文件變更時**只 stage 明確路徑**（`git add docs/ design/ harness/`），背景實作 agent 執行期**禁用 `git add -A/.`**；或提交前先 `git status` 確認無 agent WIP。 |
| 2026-07-31 | design-reviewer(D-006) | **跨文件部分改名造成使用者可見詞彙不一致**：D-006 (H′) 改「主辦人→開團的人」但 D-004 (I) 仍「主辦人」（同角色）；另訊息標籤 (F) 於 D-006 與 D-004 碰撞。設計改動涉及既有 user-facing 範本時，未全域掃描同義詞/標籤。 | 1 | 觀察中 | 候選：design review checklist 加「改既有 user-facing 範本時，全域掃描同義詞與標籤碰撞」。 |

## 已回寫紀錄（harness 演進史）
| 日期 | 回寫內容摘要 | 落點 | 版本 |
|---|---|---|---|
