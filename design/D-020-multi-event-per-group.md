# D-020: 同群組多場並行活動（解除單場限制 + 訊息消歧義）

> **ID 衝突已解決（2026-08-31，orchestrator）**：本文件原由 architect 暫編為 `D-014`，
> 但該編號已被 `design/D-014-db-tls-verification.md` 占用（DB 連線 TLS 顯式化，APPROVED、
> 已於 T-027 實作並部署，AC-1~AC-7 已被 `src/db/__tests__/pool-ssl.test.ts` 與多份文件引用）。
> 已依 architect 建議改號為 `D-020`（`D-019` 為當時最大在用編號），檔案已搬移為
> `design/D-020-multi-event-per-group.md`，文件內部所有 `D-014` 引用已同步改為 `D-020`。
> `D-014-db-tls-verification.md` 維持不動、不受影響。

- 狀態：**APPROVED（2026-09-01）**——R2 雙審通過 + 使用者最終核可。**2026-09-02 起降級為 umbrella 索引**：
  15 條 Guardrails／30 條 AC 與全部設計內容已**逐字**切出至 `D-021`~`D-029`（見 §一 索引與轉址表），
  本檔只保留 §0 關注點、切檔與相位、索引、Backlog、errata 與討論紀錄。原任務 T-033 同步拆為 T-033a~c。
- AC 覆蓋：**不適用**（本檔已無自帶 AC；30 條隨子文件走，各檔自行宣告與移除其待動工宣告）。
- 撰寫者：architect
- 風險等級：**R2（高）**——`src/db/migrations/`、`src/domain/event-service.ts`、
  `src/domain/registration-service.ts`、`src/domain/grouping-service.ts`（授權判定入口）皆屬
  CLAUDE.md §4.5 預設高風險模組；且為資料 migration。
- 關聯：`docs/00-project-brief.md` FR-8 / 決策紀錄 #9（權威需求來源，已裁決完畢，本文件不重新徵詢）；
  取代決策 #3（同群限一場）。2026-08-31 使用者追加裁決：同群同時最多 3 場 open 活動（§3.5）。
- 相依（只復用、不私改）：D-001（schema 原語）、D-002（指令解析、正規化風格）、D-004（開團狀態機、
  兩層防護模式）、D-007（client-bound tx）、D-008（`event_datetime`／惰性過期）、D-010/D-011/D-012（加開／
  分組／批次，三者皆呼叫 `findActiveByGroup`）、D-013（`conversation_states` PK，正交、不改動）。

---

## 一、設計內容

### 0. 現況問題與本設計的兩個獨立關注點

1. **解除限制**：`ux_events_active_group`（`events(group_id) WHERE status IN ('draft','open')`）
   強制同群至多一場 active，且 `EventReader.findActiveByGroup(groupId)` 回傳**單一列**，
   `event-service.ts`／`registration-service.ts`／`grouping-service.ts` 全部呼叫點皆假設「群組只有
   一場活動」。解除限制後，這個假設不成立，凡是原本「查 groupId 就能唯一決定活動」的地方都要
   換成「查 groupId 得到候選集合，再決定要操作哪一場」。
2. **消歧義**：candidates 數 > 1 時，指令需要額外資訊才能決定目標活動——機制 A（quote-reply）
   與機制 B（`@selector`）。這是全新的一層，**與 D-013 的 `conversation_states` PK 問題正交**：
   D-013 解決「這個人在回答哪個流程的問題」，本設計解決「這個指令要作用在哪一場活動」；
   兩者互不影響，本設計不改動 `conversation_states` 的鍵值或攔截邏輯（G10）。

   > 另有第三個獨立關注點：**同群 open 活動數上限**（§3.5，2026-08-31 使用者追加裁決）。
   > 與「解除限制」和「消歧義」皆正交——解除限制決定「能不能同時有多場」，上限決定
   > 「最多能同時有幾場」，兩者一硬解一硬擋，不衝突。

### 切檔與相位（**〔切檔新增〕本節為切檔時新增的設計內容；已於 2026-09-02 經 R2 雙審複審並依 blocker 修訂**）

原 T-033 一次動 4 個 §4.5 高風險模組 + 1 個 migration + 1 個破壞性介面變更（`findActiveByGroup` 移除，
G1）擴散到 6 個呼叫端，既不滿足 CLAUDE.md §3.4「小步提交」也無法獨立回滾。改拆為 3 個可獨立上線的
任務；**每份子文件恰屬一個任務**，其 AC 皆可在該任務內驗證完畢，`待動工豁免`宣告於該任務結案時逐檔
移除，不跨任務殘留。任務內容、子文件與 AC 分配見下方索引表。

**為何機制 B（`@selector`）併入 T-033a 而非獨立成任務**：`resolveTargetEvent` 內部呼叫 `matchSelector`，
且移除 `findActiveByGroup` 後 6 個呼叫端必須立刻有 `eventId` 來源 ⇒ §4.3、§5.2 與 §1／§2／§5.1 是同一
個不可再分的原子；AC-6（單場零回歸）與 AC-23（授權作用對象）亦皆以 `@selector` 構造輸入。這是 T-033a
的下界，再切只會製造無法獨立編譯、或 AC 無法在其任務內驗證的假切分。

**〔切檔複審修正〕`名單` 回退（D-022）同屬 T-033a**：§5.4 明文要求 `getListView` 的候選數判斷「必須先
跑 §5.2 的消歧義流程」——它是 §5.1／§5.2 接線的**約束（G9）**，不是可延後的後續修補；獨立成任務會使
T-033a 交付當下即違反 G9。原將其定為獨立任務且標 R1，另屬未申報的風險降級（`getListView` 位於
`src/domain/registration-service.ts`，是本檔風險列已明列的 §4.5 高風險模組），一併更正為 R2。

**排序關鍵決定**：`DROP ux_events_active_group` 放在 **T-033a（早）** 而非 T-033c（晚）。理由：(i) 晚 DROP
會使 T-033a~c 的多場並存 AC（AC-2／18／23…）在測試 DB 上無法構造真實狀態，只能靠 fixture 手動砍索引，
schema 與 PROD 分歧的品質風險更大；(ii) 早 DROP 的殘餘風險有界，見下方不變式。**連帶**：G8 與 AC-5 隨
T-033a 走——`confirm()` 的窄捕捉必須與舊索引名消失在同一批改為比對新索引名，否則「同場地+時間」的
race 會噴出未捕捉的 23505。**〔切檔複審修正 B3〕AC-5 不隨 G8 走**：它逐字要求回 `duplicate_event`，
而該 result kind 屬 §3（D-027），故改隸 T-033c；T-033a 對 G8 的驗收由既有 `[D-004 AC-12]` 兩處測試涵蓋
（須依下方 errata 同步改為新索引名）。

**〔切檔複審新增 B2〕早 DROP 的連帶：既有測試對舊索引名的引用必須在 T-033a 同批處置**（否則 T-033a
交付時 `npm test` 必紅，違反「可獨立上線」）。窮舉如下，**全部歸屬 T-033a**：

| 測試位置 | 引用形式 | 處置 |
|---|---|---|
| `d007-postgres.test.ts:160,171` `[D-007 AC-9]` | 斷言 `err.constraint === 'ux_events_active_group'` | 改新索引名；**D-007 原不在 errata 表，已補列** |
| `event-service.strengthen.test.ts:74,79` `[D-004 AC-12]` | 注入 `constraint:'ux_events_active_group'` | 改新索引名（D-004 errata 已涵蓋語意） |
| `event-service.test.ts:291,300` `[D-004 AC-12]` | 同上 | 同上 |
| `migrate.test.ts:69,90,92,99` `[D-001 AC-9]` | 索引清單／predicate／「同群第二場被拒」 | 依 0006 更新（D-001 errata 已涵蓋 AC-9） |
| `event-repository.billing.test.ts:158` | 依賴舊索引擋第二場的 fixture | 改以新語意構造 |
| `groups-backfill.test.ts:46` | 為避開舊索引而先搬走第一場 | 註解更新，行為不變 |
| `d008-auto-release.test.ts:180` `[D-008 AC-6]` | 斷言字面綁「至多一場」語意 | 重新論證（D-008 errata 已涵蓋） |

另註：§0 稱介面變更「擴散到 6 個呼叫端」，實測 production 呼叫點為 **12 處**（`event-service` 8、
`grouping-service` 2、`registration-service` 2）。原文屬已核可內容故逐字保留，此處僅補正工時依據。

**中間狀態不變式（T-033a 上線後、T-033c 上線前：DB 已不硬擋、應用層仍擋）**：

1. §3 未落地 ⇒ 開團入口仍保留「已有 active 就拒絕」，使用者**無法**建立第二場。
2. 唯一可能產生多場的路徑是「兩人自 0 場同時 `確認`」的極窄 race。若真發生：無資料損壞（鎖粒度本就是
   單一 event 列，不影響超賣防護），讀取指令回既有 `ambiguous` 提示。**〔切檔複審修正 B-1〕恢復路徑**：`isExpired` 只是顯示分類、
   **不寫回 status**，故**單純過期不會使候選數下降**；真正的恢復是 (a) 對其中一場下 `關閉報名`／
   `取消活動`（多場時需以 `@selector` 指定，該機制隨 T-033a 落地即可用），或 (b) 下一次成功 `確認` 時
   `confirm()` 會把**最新的**過期 active flip 為 `done`（`event-service.ts:499`）。
3. 查重的兩層防護無空窗：DB 層（`ux_events_active_group_venue_time` + G8 窄捕捉）已於 T-033a 就位；應用
   層則由**更嚴格的**舊 `already_active` 全面拒絕暫時涵蓋，至 T-033c 交棒給 §3 查重。
4. §3 查重與 §3.5 上限**必須同批**上線（T-033c）：多場並行在該批才對使用者開放，兩道守門同時裝上，不
   存在「已開放但無守門」的空窗。
5. T-033a~b 期間這些新文案在 PROD 實務上僅極窄 race 可觸發（見 1、2），屬防禦性路徑。**〔切檔複審
   修正 B-1〕但不得據此宣稱 `@selector` 不可達**——它隨 T-033a 落地即可用，且是第 2 點唯一的恢復手段；
   該期間不可達的是 **quote（引言）**，要到 T-033b。AC-7 提示語同時指示兩種方式，其中「回覆」在
   T-033a~b 恆無效，相位註記見 D-026（釘死文案不因相位改寫）。

### 索引與轉址表（舊 §x → 新檔；子文件內文的 `§x` 一律仍指本表第二欄）

| 子文件 | D-020 舊章節 | 任務 | 風險 | Guardrails | AC |
|---|---|---|---|---|---|
| `D-021-schema-unlock-and-event-reader` | §1、§2、§5.1 | T-033a | R2 | G1, G8, G10 | 1, 2 |
| `D-023-event-disambiguation-core` | §4.3（型別／判斷順序／`matchSelector`） | T-033a | R2 | G2 | 6, 8, 11, 12 |
| `D-024-selector-split-and-truncation` | §4.2、§4.3（顯示截斷） | T-033a | R2 | G5, G6, G-selector-sync | 9, 10, 24, 29, 30 |
| `D-026-dispatch-disambiguation-pipeline` | §5.2 | T-033a | R2 | G11, G12 | 7, 20, 21, 23 |
| `D-022-list-zero-candidate-fallback` | §5.4 | T-033a | R2 | G9 | 18, 19 |
| `D-025-quote-message-event-map` | §4.1 | T-033b | R2 | G3, G14 | 13, 14, 15, 16, 28 |
| `D-029-related-event-emit-points` | §5.3、§5.5 | T-033b | R2 | G4 | 17, 22 |
| `D-027-duplicate-event-guard` | §3 | T-033c | R2 | G7（+ 引用繼承 G8） | 3, 4, 5 |
| `D-028-group-open-event-limit` | §3.5 | T-033c | R2 | G13 | 25, 26, 27 |
| 本檔（umbrella） | §0、§6、舊 §四 errata | — | — | 無 | 無 |

### 6. Backlog（本輪不做，登記供後續評估）

- `message_event_map` 隨時間增長的清除：規劃「每週清除已結束活動的關聯資料」，需要排程機制
  （本專案 Cloud Run `min-instances=0` 無背景 cron，比照既有「開球前提醒」的結論，需另開 ADR 評估
  排程方案）與保留期限，**不在本次實作範圍**，`ix_message_event_map_event` 已預先建好供未來
  清除查詢使用。
- `matchSelector` 對含空白場地名的精確度限制（§4.3 已知限制）。
- 名單查詢在 candidates.length===0 但同群有**多場**closed 事件時，仍只顯示 latest-by-id 那一場
  （未消歧義歷史 closed 事件），維持既有行為，不擴大範圍。
- 若同群 open 數上限（§3.5）的 race window 超出情形在實測中發現頻繁或後果比預期嚴重，評估是否需要
  以 serializable 交易或觸發器加固為 DB 層約束（目前判斷不需要，見 §3.5）。

---

## 二、Guardrails（Must NOT）

本檔為 umbrella，**不自帶 Guardrail**。15 條全數**逐字**保留於子文件（分配見上表），編號不變、不重編號、
不加前綴——既有文件與未來測試對 `G1`~`G14`／`G-selector-sync` 的引用因此全部不需修改。

---

## 三、Acceptance Checks

本檔為 umbrella，**不自帶 AC**，故本檔不宣告、也不得宣告待動工豁免。30 條全數逐字保留於子文件（分配
見上表），編號不變。**但測試標記必須改用子文件的 D 編號**——`harness/checks/check_ac_coverage.py` 的文件
編號取自**檔名**，例如 AC-8 的測試要寫 `[D-023 AC-8]`，寫成 `[D-020 AC-8]` 會對不上而使關卡永久紅；內文
（errata、審查紀錄、既有文件）對 AC 編號的交叉引用則沿用原字串，不必修改。

---

## errata（對既有文件的建議，不直接修改，交 orchestrator 裁決）

> 本節即原「§四」，標題改名以符合專案慣例（`## errata（…）`，見 D-001／D-004／D-006／D-008 等），
> 使其依 `check_doc_budget.py` 的既有規則不計入行數上限。**內容逐字未動、不拆給子文件**——11 份目標
> 文件寫的「來源 D-020」措辭因此持續成立，errata 維持單一對外出口。


| 文件 | 建議修改 |
|---|---|
| `docs/01-architecture.md` | 資料模型表：`ux_events_active_group` 一列改為兩列索引語意
  （新增 `ux_events_active_group_venue_time` 與 `message_event_map`）；併發章節可補一句
  「多場並行後，鎖定粒度仍是單一 event（`FOR UPDATE` 鎖該 event 列），group 層級不再有隱含互斥」；
  可補一句「同群 open 數上限（3 場）為應用層計數判斷，非 DB 約束（D-020 §3.5）」。 |
| `docs/02-api-contract.md` | 通用約定新增「`@selector` 前綴」一節（語法、判斷順序、四個新拒絕
  文案）；`關閉報名`/`取消活動`/`編輯`/`加開`/`分組`/`名單`/`+N`/`-N` 各列補充「多場並行時需消歧義」
  的備註；`開團` 列補充「同群同時最多 3 場 open，達上限回固定文案（不帶活動明細）」；REST 面不受影響。 |
| `design/D-001-data-model.md` | errata：§2「同一 `group_id` 同時最多一場 active 活動」、G3、
  §7 狀態機「active 集合...受 §2 partial unique index 約束（同 group 至多一場）」、AC-9 皆基於
  舊約束——D-020 已移除 `ux_events_active_group`，改以兩道獨立機制取代原「同群至多一場」角色：
  (a) `ux_events_active_group_venue_time`（場地+時間查重，DB 層安全網）(b) 同群 open 數上限 3 場
  （應用層計數，D-020 §3.5，非 DB 約束）。建議 §2/G3/§7/AC-9 各加註「已由 D-020 取代，詳見
  D-020 §1/§3.5」，不另改動本文件既有 DDL 文字（沿用既有 errata 慣例：不改 APPROVED 狀態、只加註）。 |
| `design/D-002-command-parser.md` | errata：新增 `splitSelector`（新檔 `selector.ts`）、
  白名單表新增 `＠→@`；註明 `parseCommand` 本身不變，`splitSelector` 是**前置**於它的獨立純函式。 |
| `design/D-004-event-creation.md` | errata：§4/§6「同群一場 active 約束」段落改寫為「開團查重
  （場地+時間）」；`CreateEntryResult`/`ConfirmResult` 的 `already_active` 更名 `duplicate_event`；
  訊息 (I)「已有進行中活動」文案改為「已有相同時間地點的球敘」；`startCreation` 移除入口早退檢查
  （**僅指查重**——上限早退檢查為新增例外，見下）。另新增獨立的 `group_open_limit`（同群 open
  數上限，D-020 §3.5）：`startCreation` **新增**入口早退檢查（本設計新增的例外，非移除）；
  `CreateEntryResult`/`ConfirmResult`/`ContinueFlowResult` 三者均新增此成員，與 `duplicate_event`
  並列不合併；固定文案「此群組已有 3 場進行中的球敘，請等其中一場結束後再開新團」逐字釘死、
  不帶活動明細。 |
| `design/D-006-admin-claiming.md` | errata：§1.1「唯一守門仍是同群單場（`findActiveByGroup`
  入口拒絕 + `確認` 撞 `ux_events_active_group` 安全網）」與 §1.2「授權需先 `findActiveByGroup`
  讀出 event 以取 `host_user_id`」兩處措辭已隨 D-020 過時——`findActiveByGroup` 已移除（G1），
  「同群單場」不再是開團的唯一守門（改為 D-020 §3.5 的 open 數上限 3 場 + §3 場地時間查重兩道
  機制）；`canManageEvent` 判定改讀 `events.getById(eventId)`（`eventId` 由 D-020 消歧義解出）。
  `canManageEvent` 謂詞本身（比對 `host_user_id`/super-admin）語意不變，僅資料讀取方式改變。 |
| `design/D-007-postgres-migration.md`〔切檔複審補列 B2〕 | errata：§「窄捕捉 UNIQUE → PG error
  code」所舉的 `err.constraint === 'ux_events_active_group'` 於 0006 後失效——該索引已 DROP，窄捕捉
  改比對 `ux_events_active_group_venue_time`（D-020 G8）；`[D-007 AC-9]` 的測試斷言須同批更新。
  本列為 2026-09-02 R2 複審發現的原表遺漏（原表 9 rows／11 份文件，現 10 rows／12 份文件）。 |
| `design/D-008-auto-release-slot.md` | errata：`findActiveByGroup` 相關敘述改為
  `listActiveByGroup` + 消歧義後 `getById`；「同群僅一場」相關措辭需標註「已由 D-020 取代」。 |
| `design/D-010-add-capacity.md` / `D-011-grouping.md` / `D-012-multiline-signup.md` | errata：
  三者呼叫 `findActiveByGroup` 之處改為消歧義後帶入 `eventId`；D-012 補充「`@selector` 僅認第一行」
  已由 D-002/D-020 承接，行為與原設計一致（批次選定活動後套用全批，語意未變，只是「選定」的
  方式從「唯一 active」變成「消歧義結果」）。 |
| `design/D-015-edit-event.md` | errata：`EditEventInput` 新增 `eventId?`；`EditEventResult.ok`
  新增 `eventId` 欄位（供 `message_event_map` 寫入）。 |

**為何 D-001／D-006 先前未列入本表（design-reviewer NIT-3 回應，2026-09-01）**：初版盤點聚焦於
直接呼叫 `findActiveByGroup` 的三份 service 設計文件（D-010/D-011/D-012）與直接受 schema/流程
變動影響的文件，遺漏了 D-001（schema 權威文件本身也描述「同群至多一場」規則，§2/G3/§7/AC-9）與
D-006（§1.1/§1.2 明文提及 `findActiveByGroup`／`ux_events_active_group` 作為開團守門角色）。經
review 提醒後已補齊上表兩列。**本表現涵蓋 9 個 row、11 份文件**（`01-architecture.md`、
`02-api-contract.md`、D-001、D-002、D-004、D-006、D-008、D-010、D-011、D-012、D-015）。

---

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 狀態 |
|---|---|---|
| 2026-09-02 | 任務過大／文件過長：D-020 切檔與 T-033 再拆 | 已執行。**裁定：任務太大是主因，文件長度只是症狀**——
  `check_doc_budget.py` 現行版本已對 R2 不設上限（規則四），D-020 從未違規，先前「6 倍超標」的判讀是錯的；
  但 §0 自陳 3 個正交關注點 + 一次動 4 個高風險模組 + 破壞性介面變更擴散 6 個呼叫端，規則七「超出預算多半
  代表任務該再拆一層」仍字面成立。設計內容**逐字**切出為 D-021~D-029 九份（皆 ≤120 行），本檔降級為
  umbrella。**驗證**：九份子文件的設計/G/AC 行重新串接後與本檔 git base 版比對，**512 行零遺失、零重複**，
  唯一差異是 20 行標記為〔切檔新增〕的新內容（相位說明 ×2、G8 引用繼承 ×1、測試標記提示 ×9 檔）。
  **與 `docs/proposals/D-020-SPLIT-PROPOSAL.md`（已移出 `design/` 並標記為被取代）的差異**：該提案的 5 任務／8 文件切法有三處切在呼叫邊上，已修正——
  ①`resolveTargetEvent` 內部呼叫 `matchSelector`，兩者分屬不同任務會使 T-033a 反過來依賴 T-033c；
  ②§5.1 明文「handler 層先解出 eventId」，但 §5.2 被整段分給最後一批 ⇒ T-033a 無法編譯；
  ③AC-6／14／15／23 皆須 `@selector` 或 quote 才能構造，卻被分配到更早的任務。改為 4 任務／9 文件後，
  每份子文件恰屬一個任務、每條 AC 皆可在其任務內驗證。該提案的 R-3（規則四與檢查器矛盾）經查已不存在，
  不需裁決。**使用者裁決（2026-09-02）**：①D-027 以「引用繼承 G8」滿足 CLAUDE.md §5「R2 至少 3 條 Guardrail」
  （T-033d 原生只有 G7+G13 兩條）——**可接受**，刻意不新增 Guardrail 以免竄改已核可的設計決定；
  ②20 行〔切檔新增〕內容**送 R2 雙審複審**，審查包 `docs/reviews/RP-D-020-SPLIT.md`。 |
| 2026-09-02 | 切檔的 R2 雙審複審（標的：`〔切檔新增〕`標記的新增內容） | **雙 BLOCK → 修訂後封閉**。
  architect-reviewer 3 blocker：**B1** 早 DROP 後開團側三處（`startCreation`／`handleOneline` 早退、
  `confirm()` 交易內重讀）在 T-033a 無替代設計，實作者只能取 `[0]` ⇒ 違反 **G1**；**B2** 早 DROP 使
  7 處既有測試對舊索引名的斷言失效（含 `[D-007 AC-9]`，且 **D-007 原不在 errata 表**）⇒ T-033a 無法
  綠燈交付；**B3** AC-5 逐字要求 `duplicate_event`，該 kind 屬 §3 ⇒ 不能在 T-033a 驗證。
  design-reviewer 2 blocker：**B-1** 不變式 #2「等其中一場過期即恢復」**事實錯誤**（`isExpired` 不寫回
  status），且與 #5「`@selector` 不可達」互相矛盾；**B-2** AC-7 釘死文案叫使用者「回覆」，但引言要到
  機制 A 才生效，T-033a~b 照做會靜默落回同一分支——裁決**不改釘死字串**、改以相位註記處理。
  **orchestrator 逐條對程式碼核實後全數採納**（`event-service.ts:342/371/493`、`event-status.ts:15`、
  `event-repository.ts` 的 `findActiveByGroup`、7 個測試位置皆親自查證）。修訂：D-021 增開團側**機械
  替換過渡條文**（取 `actives.at(-1)` 而非 `[0]`——舊查詢是 `ORDER BY id DESC LIMIT 1`，取首列會靜默
  取到最舊一場）＋AC-5 改隸 D-027；umbrella 補連帶測試窮舉表與 D-007 errata 列、修正不變式 #2/#5；
  D-026 補 AC-7 相位註記。**另 orchestrator 自行發現第 6 項（兩位 reviewer 皆未提）**：D-022 不可分離
  ——§5.4 明文要求 `getListView` 須先跑 §5.2 消歧義流程，是 T-033a 的接線約束（G9）而非後續修補，且
  原標 R1 屬未申報降級（`registration-service.ts` 為 §4.5 高風險模組）⇒ **併入 T-033a 並升 R2**，任務
  數 4→3（T-033a 核心／T-033b 機制 A／T-033c 開燈）。逐字保真複驗仍為 **512 行零遺失**，新增行 20→42
  且全部帶標記。**兩份文件（本檔 146 行、D-021 133 行）超過 R1 的 120 行提示線屬預期**：R2 依規則四
  不設上限，且 T-033a 已由雙審確認為不可再分的原子，**不得據該提示再拆**。 |
| 2026-08-31 | FR-8 / 決策 #9 逐項裁決（使用者） | 已定案，見 `docs/00-project-brief.md` |
| 2026-08-31 | D-014 ID 與既有 TLS 設計衝突 | 已裁決：本文件改號為 D-020，檔案搬移並同步內部引用（見文件頂端） |
| 2026-08-31 | 同群同時最多 3 場 open 活動（追加裁決） | 使用者裁決：新增獨立上限檢查（§3.5），與查重（§3）
  分開判斷（不同 result kind、不同訊息）；固定文案「此群組已有 3 場進行中的球敘，請等其中一場
  結束後再開新團」；不設 DB 唯一索引/CHECK（architect 評估後判定不需要，理由見 §3.5）；
  Guardrails 13→14（新增 G13）、AC 24→27（新增 AC-25~27）。 |
| 2026-09-01 | R2 雙審回覆（architect-reviewer B1 blocker + 2 nit；design-reviewer 文案 blocker
  + 3 nit） | architect 修訂本文件。**B1（跨群 quote 未驗證 group_id，唯一 blocker）**：採「dispatch
  層一次性校驗」方案（新增 G14、AC-28）——quote 解出的 `eventId` 於呼叫 `resolveTargetEvent` 之前
  先以 `events.getById` 比對 `group_id`，不符即視為未引言（落入既有 none/single/ambiguous 分支，
  不洩漏別群資訊）；`resolveTargetEvent`／`matchSelector` 維持純函式不變、service 層不需重複檢查
  （§5.1 已加註避免文件前後矛盾）。**architect-reviewer 2 nit 已採納**：§3.5「僅可能超出 1 場」
  改為「視同時並發請求數而定，非嚴格上界」；§5.1 補充 `closeEvent`/`cancelEvent` 雙層授權模式
  （交易外 early-return + 交易內權威重讀）明確保留、不得合併為一次查詢。**design-reviewer 文案
  blocker**：使用者已裁決保留原「有超過一場 {xxx} 的球敘，請修正再試」文案，本輪確認 §4.3/AC-10
  用字一致，無需修改內容，僅為確認。**design-reviewer 3 nit 全採納**：G-selector-sync「建議」
  改「必須」+ 新增 AC-29；`selectorRaw` 超長回顯新增截斷規則（20 字 + `…`）+ 新增 AC-30；§四
  errata 表補齊 D-001／D-006 兩份遺漏文件（原表 7 rows/9 docs → 現 9 rows/11 docs，並加註說明
  為何先前遺漏）。**Guardrails 14→15（新增 G14）；AC 27→30（新增 AC-28~30）**。狀態維持 DRAFT，
  待重新送雙審。 |
