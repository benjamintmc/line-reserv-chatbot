# D-013: conversation_states 改以 (group_id, line_user_id) 為 PK（跨群流程並行）

狀態：APPROVED（2026-08-19，使用者最終核可）——R2 雙審通過（architect 2 輪 PASS／design 3 輪 PASS，合計 10 條 blocker 全數封閉），3 項裁決已回填。解鎖 T-022

- 撰寫者：orchestrator（代 architect；本文件若經 architect 複核請改記撰寫者）
- 風險等級：**R2（高）**——資料 migration（CLAUDE.md §4.5 預設高風險）。雙 reviewer（design + architect）+ e2e，Guardrails ≥ 3。
- 關聯：使用者實際回報 bug（A 群開團中於 B 群發言被誤判）→ T-021 讀取端守衛（已完成，本輪）→ 本設計為**根治**。任務 T-022。
- 相依（只復用、不私改）：**D-001**（conversation_states 定義）、**D-004**（開團流程 + 跨群 errata 第 1–6 條）、**D-011** §1（分組 session 共用同一列的取捨）、**D-007**（PG 方言、client-bound TxRepos）。

## 一、設計內容

### 0. 問題與定位
`conversation_states` PK 為 `line_user_id` ⇒ **一人在全系統只有一列**。T-021 已在五個讀取點加 `conv.group_id === 來源 groupId` 守衛，修掉「讀錯列」（跨群誤攔截、`確認` 跨群建活動、`下一輪` 外洩他群名單）；但**擋不住「覆寫」**——在 B 群開新流程時 `upsert` 必然蓋掉 A 群那一列。T-021 以 (N2) 告知句消除「靜默」，然而**中斷另一群的流程本身對使用者不友善**（使用者裁決 2026-08-19：根治）。

本設計把 PK 改為複合鍵，使跨群流程**並行共存**；跨群外洩隨之由「守衛修補」升級為**結構上不可能**（查詢本身帶 group）。

### 1. Schema 變更（migration 0004）
`0001~0003` 為凍結區（已於 PROD 執行）**只新增、不改寫**。migration runner 單檔單交易（`src/db/migrate.ts`），故以下步驟原子、部分失敗不留半套。

0. **檔首先設 `SET LOCAL lock_timeout = '3s';`**（runner 已先 `BEGIN`，合法）。**這是本 migration 最大的維運風險防護**（architect B2）：`ALTER TABLE` 需 ACCESS EXCLUSIVE 鎖，若被任何持有本表鎖的交易擋住，**後續所有 `conversation_states` 查詢會排隊在其後**，而 handler 的第一個動作就是 `conversations.get` ⇒ webhook 全面逾時。逾時則整檔 ROLLBACK，稍後重跑即可（runbook 須註明）。
1. **清 NULL 列**：`DELETE FROM conversation_states WHERE group_id IS NULL`。`group_id` 現為 nullable，但**無任何寫入路徑能產生 NULL**（5 個 upsert 呼叫點皆傳真實 groupId；handler 丟棄非群組來源），故實務影響 0 列；縱有殘列，複合 PK 下永不可能被命中（fail-closed），刪除為正解。
2. `ALTER TABLE conversation_states ALTER COLUMN group_id SET NOT NULL`。
3. `ALTER TABLE conversation_states DROP CONSTRAINT conversation_states_pkey`。
   **約束名已實測查證（2026-08-19，非推斷）**：`0001_init.sql:76` 用隱式 `line_user_id TEXT PRIMARY KEY`，對真 PG 查 `pg_constraint` 得 `conname = conversation_states_pkey` / `def = PRIMARY KEY (line_user_id)`。查證指令見文末附註——**日後若改用具名約束，此步須同步更新**。
4. `ALTER TABLE conversation_states ADD PRIMARY KEY (group_id, line_user_id)`。
   註：**舊 PK 的隱含索引由該約束擁有，隨 `DROP CONSTRAINT` 一併消滅**，無需另行 `DROP INDEX`、亦不留孤兒索引；先 drop 後 add 故無同名衝突。步驟 2 的 `SET NOT NULL` 於 `ADD PRIMARY KEY` 已隱含，保留為顯式意圖宣告（冗餘但無害）。欄位順序取 `(group_id, line_user_id)`：現行查詢一律兩欄等值（兩種順序等效），此序另具「按群前綴掃描」優勢，利於未來 TTL／按群清理。不需額外索引（G2 已排除任何單以 `line_user_id` 的查詢，且無 FK 指向本表）。

**風險為何低**：本表是**暫存**（in-flight 開團問答／分組 session），非帳務或報名資料；最壞情況是某人進行中的流程消失、重打 `開團` 即可。**不得**把此結論套用到 `registrations`／`events`。

### 2. Repository 介面變更（`conversation-repository.ts`）
- `get(lineUserId)` → `get(groupId, lineUserId)`；`delete(lineUserId)` → `delete(groupId, lineUserId)`；`ConversationReader` 同步。
- `upsert` 的 `ON CONFLICT (line_user_id)` → `ON CONFLICT (group_id, line_user_id)`；`UpsertConversationInput.groupId` 收斂為 `string`（去掉 `| null`，從型別排除 NULL 列）。
- 受影響呼叫點：讀 5 處（`handler.ts` 攔截、`event-service` 的 `continueFlow`/`confirm`/`abort`、`grouping-service.nextRound`）、寫 5 處（`startCreation`/`handleOneline`/`continueFlow`/`startRounds`/`nextRound`）、`delete` 於 `confirm`/`abort`。

### 3. 語意收斂（承 D-004 errata 第 6 條）
- `NextRoundInput.groupId` 由「守衛用」變為**查詢鍵**。
- **五道 group 比對守衛全部保留**為縱深防禦（G3）：複合鍵已使跨群不可讀，守衛成為冗餘但零成本的第二道；且它們是回歸測試的錨點。
- **(N2) 告知句收斂**：`abandoned: 'create'` 移除、`'grouping'` 保留。
  - **移除 `'create'` 的正確理由是「構造性」而非「handler 會攔截」**（architect B1 糾正）：handler 的攔截讀在交易外，且 `src/server.ts` 以 `Promise.all` **並行**處理同一 webhook body 的多個事件 ⇒ 兩則 `開團` 可同時通過攔截（TOCTOU），故不能倚賴它。真正的理由是——`detectAbandoned` 回 `'create'` 的唯一條件是 `prev.group_id !== groupId`，而查詢鍵改為 `(groupId, lineUserId)` 後，撈回的 `prev` **由構造必然同群**，該條件恆為 false。並發 race 下 `prev` 亦為同群列，現行碼本就回 `undefined` ⇒ **行為零變化**。
  - **`detectAbandoned` 的新實作語意（必須逐字照此，勿自行推廣）**：body 收斂為 `prev?.state === GROUPING_STATE ? 'grouping' : undefined`，**並移除 `groupId` 參數**（已成死參數）。**不得**改寫成「prev 存在且非 grouping → 告知」——那會在並發 race 下回歸出現假告知句。
  - `'grouping'` 保留——同群內開團問答與分組 session 仍共用同一列，該群有分組 session 時打 `開團` 依然覆寫它。**其可達性有前置條件**，見 AC-4。
  - **同群競態殘留時回 `undefined`（靜默）是可接受的**：使用者就在該視窗、且已收到新流程的提問，無資訊落差。實作者**不得**為求保險而保留 `'create'`（design-reviewer N3）。
- **為何不加跨群區辨資訊（G7 的依據）**：複合 PK 後使用者可在多群各有一段流程，而提問文案兩群一致、不含群組資訊。經 design-reviewer 判定**不構成真實困惑**：①提問與作答同在該群視窗內發生，視窗即 context，推播通知列亦帶群組名；②開團在不可逆動作前必經 `確認` 摘要（完整列出日期／時間／場地／人數／費用），誤答會在建立前被看見；③踩到可回復（該群 `取消`）。反之若加「你在另一個群還有流程」這類措辭**即是洩漏**。故定為 G7。
- **附帶消解一項疑慮**：收斂後唯一的告知句只在**同群**發生，不可能洩漏其他群資訊；T-021 遺留的「看到告知句是否等於確認前一段流程在別群」問題自然不成立。

### 範圍外
- 同群內「開團問答 ↔ 分組 session」互斥（仍共用 `(group, user)` 一列）。若要並行需 PK 再加 state 維度或分表 ⇒ 另案。
- conversation TTL 清理（OP-6）：本設計不引入 TTL；複合鍵使殘列數上限由「人數」變為「人數 × 群數」，TTL 的必要性略升，登記 Backlog。
- 1:1（非群組）流程：handler 仍丟棄非群組來源，故無 `group_id` 來源問題。

## 二、Guardrails（Must NOT）
- **G1（凍結區）**：不得改寫 `0001~0003` 任何內容；PK 變更**只能**以新增 `0004` 達成。不得改動 `src/db/tx.ts`。
- **G2（無殘留單鍵查詢）**：`conversation_states` 的任何 SQL **不得**只以 `line_user_id` 為條件；讀、寫、刪一律帶 `group_id`。不得於 domain/handler 自拼 SQL 繞過 repository。
- **G3（守衛不得移除）**：不得以「複合鍵已足夠」為由刪除 T-021 的五道 `conv.group_id === groupId` 守衛；它們保留為縱深防禦與回歸錨點。**本條不含 `detectAbandoned` 內的 `prev.group_id !== groupId` 判斷**——那不是守衛而是 `'create'` 的判定條件，依 G4 隨該分支一併移除，兩條不衝突。
- **G4（(N2) 精確收斂）**：不得保留已不可達的 `abandoned: 'create'` 分支（死碼）；亦**不得**連帶移除仍可達的 `'grouping'` 分支。
- **G5（暫存語意不變）**：不得將 `conversation_states` 當作可長期保存的業務資料；不得因本變更而在其中存放報名／費用等業務欄位。
- **G6（NULL 不得復活）**：`UpsertConversationInput.groupId` 不得再允許 `null`；不得新增任何能寫入 NULL `group_id` 的路徑。
- **G7（文案不得帶他群資訊）**：**不得**為了讓使用者區辨跨群並行流程，而在提問或告知文案中加入群組名稱或任何他群資訊。設計已判定不需區辨（見 §3 附註「為何不加區辨」）；此條存在是為了防止日後「好心」補上而造成洩漏（design-reviewer N2）。
- **G8（0004 刪除範圍）**：0004 的 `DELETE` **只得**帶 `WHERE group_id IS NULL`，不得無條件刪除本表；0004 **不得**夾帶任何其他資料表的變更。

## 三、Acceptance Checks
- [ ] **[D-013 AC-1]（跨群並行）**：同一人在 A 群 `開團` 進到 `awaiting_time`，於 B 群 `開團` → **兩列並存**；A 群列的 `state`/`payload` 不變，回 A 群作答正常前進；B 群列獨立前進。**不出現任何放棄告知**。
- [ ] **[D-013 AC-2]（跨群不可讀，結構性）**：A 群有 `grouping` session 時於 B 群 `下一輪` → `no_session`，且**回覆不含 A 群任何人名**；B 群 `確認`／`取消` 對 A 群流程零影響。
- [ ] **[D-013 AC-3a]（結構斷言，可直接跑）**：0004 套用後查 `pg_constraint`／`pg_index`，PK 為 `(group_id, line_user_id)` 且 `group_id` 為 NOT NULL、無殘留孤兒索引；`upsert` 對同一人不同群各自成列、同一 `(群, 人)` 則覆寫。
- [ ] **[D-013 AC-3b]（NULL 清理，需特製 setup）**：`runMigrations` **無「套用至指定版本」能力**，且 0004 後 `group_id` 為 NOT NULL 無法再造 NULL 列 ⇒ 本條**不可用一般測試流程驗**。作法擇一：(i) 於獨立 schema/DB 以 `readFileSync` 手動依序套 0001–0003 → 插 NULL 列 → 套 0004 → 斷言該列已刪。**套 0004 時務必自行以 `BEGIN`/`COMMIT` 包住**，否則 `SET LOCAL` 在交易外只發 WARNING 而無效，與 runner 實際行為不一致（architect nit）；(ii) 降級為上線前人工 `SELECT count(*) FROM conversation_states WHERE group_id IS NULL` 確認為 0 並記錄於 runbook。（architect B4）
- [ ] **[D-013 AC-4]（同群 grouping 覆寫仍告知）**：回覆含「已結束你先前未完成的分組。」，且**不含**任何群組識別或活動內容。**前置條件（必讀，否則測不到）**：`startCreation` 於交易前 early-return `already_active`（該群有未過期 open 即拒），而分組 session 必然伴隨一場 active 活動 ⇒ 「active open + grouping session + `開團`」**永遠走不到告知句**。可達窗口只有三種：該活動已 `關閉報名`（closed 不在 active 集）／已 `取消活動`／已過期（D-008 入口放行）。**tester 若在 naive setup 下測不到，不得據此判定 `'grouping'` 為死碼而刪除**（違反 G4）。**最省事路徑**：unit 層直接 `conversations.upsert({ state: 'grouping' })` 且該群無 active 活動（即 `event-service.test.ts` 現行 `[D-004 errata N2]` 子案 (b) 的既有寫法），比佈置 closed／過期活動快。（design-reviewer B3 + nit）
- [ ] **[D-013 AC-5]（`create` 分支徹底移除，無死碼殘留）**：①`AbandonedKind` 不再含 `'create'`；②`src/domain/event-formatter.ts` 的 `withAbandonedNotice` 參數型別同步收斂（或去參數），字串常數「已放棄你先前未完成的開團。」刪除，該檔 (N2) 註解中「別群開團」情境的敘述一併修正；**併同修正 `src/domain/event-service.ts` `detectAbandoned` 的 doc-comment**——現寫「同群 create 流程回 undefined：該情形 handler 已攔截」，正是 §3 判定**錯誤**的理由，不修會把錯誤推理留在碼裡；③**grep 範圍限 `src/`（程式碼＋測試）**，`已放棄你先前未完成的開團` 命中數 = 0。**不得**擴及 `design/`／`docs/`——該字串會續存於 D-004 errata（AC-9 只標註取代、不刪文）、本文件 AC 引文、及交接快照，那些檔案**不歸本任務所有**（CLAUDE.md §2／OWNERSHIP）；④`detectAbandoned` 的 `groupId` 死參數已移除；⑤**前置「該群無 grouping session」時**，並發雙 `開團`（同群、同一 webhook body 經 `Promise.all`）不得出現任何告知句（有 grouping session 時應出現 `'grouping'` 句，見 AC-4，兩者不衝突）。（design-reviewer B2/B5 + architect B1）
- [ ] **[D-013 AC-6]（無殘留單鍵查詢）**：全庫掃描 `conversation_states` 相關 SQL，皆帶 `group_id`；`get`/`delete` 簽名為 `(groupId, lineUserId)`，無呼叫點漏改（**含測試檔——測試不受 `tsc` 檢查，須 grep 核對**，見 LESSONS 2026-08-19）。
- [ ] **[D-013 AC-7]（既有行為零回歸，含兩處必須改寫的例外）**：既有 358 tests 全綠，**有兩處必然失敗、必須改寫**，tester 不得誤判為真回歸。**前提**：以下「僅此兩處」是以 AC-6 的機械式簽名更新（`get`/`delete` 改雙參數，`src/` 內約 50 處測試呼叫點）**已完成**為準；簽名未更新所造成的失敗屬 AC-6 範疇，不計入本條。
  1. `src/webhook/event-handler.test.ts` 第一條 `[D-004 errata N2]`——斷言 B 群 `開團` 回覆含「已放棄你先前未完成的開團。」且 A 群 draft 被取代。改寫為 AC-1 的反向斷言：回覆**不含**「已放棄」、A 群列的 `state`/`payload`/`group_id` **不變**。
  2. `src/domain/event-service.test.ts` 的 `[D-004 errata N2]` **子案 (a)**——直接 `expect(a.abandoned).toBe('create')`。改寫為斷言別群既有列**不再**被視為 abandoned（回 `undefined`），且該列於 DB 中仍在。**該 `it` 的標題字串亦含「abandoned=create」，須一併改**。同區塊的子案 (b)（grouping）與 (c)（無前段流程）行為不變，不需改寫——(b) 正是 AC-4 指向的最省事路徑。其餘（T-021 三條跨群整合測試、同群開團／報名／名單／分組／加開）行為不變。（design-reviewer B1）
- [ ] **[D-013 AC-8]（runbook 落實單階段上線）**：`docs/deployment-runbook.md` 增列 0004 段落，須含：①直連（非 pooled）執行 0004 → **立即**部署新 revision；②窗口內失效指令清單（`開團`／一行式開團／逐步問答**每一步作答**／`分組`／`下一輪`——皆走 upsert；`get`/`delete` 不受影響）；③`lock_timeout` 逾時即整檔 ROLLBACK、稍後重跑即可；④**退版警語**：新 revision 一旦產生「同人多群列」，反向 migration 只能人工取捨保留一列 ⇒ **退版即有資料損失**。（architect B3）
- [ ] **[D-013 AC-9]（權威文件不得並存矛盾敘述）**：T-022 交付時須補 `design/D-004-event-creation.md` errata（2026-08-19，來源 D-013）標註其 errata **第 5 條**（「不動 schema、不改 PK；一人同時只能有一段流程」）與**第 6 條**（`create` 告知句）已被取代；並補 `design/D-011-grouping.md` §1 errata（鍵已變複合、互斥範圍縮為同群）。依 CLAUDE.md §2，D-004 為攔截語意與 (N2) 文案的權威來源。（design-reviewer B4 + N1）

## 討論紀錄（待使用者裁決）
| # | 議題 | 建議預設 | 使用者裁決 |
|---|---|---|---|
| 1 | **PROD 上線順序**。0004 **非向後相容**：舊版程式的 `ON CONFLICT (line_user_id)` 在 PK 換掉後會直接報錯（找不到匹配的唯一約束）。(a)**單階段**：先跑 0004 再部署新 revision——舊 revision 若仍在服務，該窗口內的開團/分組 upsert 會失敗（使用者重打即可；min-instances=0、流量極低）。(b)**兩階段零停機**：先加 `UNIQUE (group_id, line_user_id)` 並部署改用新 conflict target 的程式，確認後再 drop 舊 PK 並提升為 PK（多一次 migration 與一次部署）。 | **(a) 單階段** | **裁決（2026-08-19）：(a) 單階段**。runbook 須明載「0004 執行後應立即部署新 revision」，並提示該窗口內開團/分組指令可能失敗、重打即可。 |
| 2 | **既有 NULL 列處理**：實務上應為 0 列。(a) `DELETE` 掉（建議）(b) backfill 一個哨兵值後保留 | **(a) DELETE** | **裁決（2026-08-19）：(a) DELETE**（orchestrator 逕定：無合理 backfill 值、複合 PK 下 NULL 列永不可命中、實務 0 列）。 |
| 3 | 五道守衛去留 | 全部保留為縱深防禦（G3） | 已定（不需裁決，列此備查） |

> **附註——約束名查證指令**（`docker compose up -d` 後）：
> `docker exec golf-reserv-pg-test psql -U golf -d golf_test -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'conversation_states'::regclass;"`
> 2026-08-19 實測輸出：`conversation_states_pkey | PRIMARY KEY (line_user_id)`。
