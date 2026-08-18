# D-013: conversation_states 改以 (group_id, line_user_id) 為 PK（跨群流程並行）

狀態：IN_DISCUSSION（2026-08-19，orchestrator 代筆——architect 連續四次 API 529 失敗）——3 項裁決已回填，待 R2 雙審（design + architect）後交使用者最終 APPROVED 以解鎖 T-022

- 撰寫者：orchestrator（代 architect；本文件若經 architect 複核請改記撰寫者）
- 風險等級：**R2（高）**——資料 migration（CLAUDE.md §4.5 預設高風險）。雙 reviewer（design + architect）+ e2e，Guardrails ≥ 3。
- 關聯：使用者實際回報 bug（A 群開團中於 B 群發言被誤判）→ T-021 讀取端守衛（已完成，本輪）→ 本設計為**根治**。任務 T-022。
- 相依（只復用、不私改）：**D-001**（conversation_states 定義）、**D-004**（開團流程 + 跨群 errata 第 1–6 條）、**D-011** §1（分組 session 共用同一列的取捨）、**D-007**（PG 方言、client-bound TxRepos）。

## 一、設計內容

### 0. 問題與定位
`conversation_states` PK 為 `line_user_id` ⇒ **一人在全系統只有一列**。T-021 已在五個讀取點加 `conv.group_id === 來源 groupId` 守衛，修掉「讀錯列」（跨群誤攔截、`確認` 跨群建活動、`下一輪` 外洩他群名單）；但**擋不住「覆寫」**——在 B 群開新流程時 `upsert` 必然蓋掉 A 群那一列。T-021 以 (N2) 告知句消除「靜默」，然而**中斷另一群的流程本身對使用者不友善**（使用者裁決 2026-08-19：根治）。

本設計把 PK 改為複合鍵，使跨群流程**並行共存**；跨群外洩隨之由「守衛修補」升級為**結構上不可能**（查詢本身帶 group）。

### 1. Schema 變更（migration 0004）
`0001~0003` 為凍結區（已於 PROD 執行）**只新增、不改寫**。0004 四步：
1. **清 NULL 列**：`DELETE FROM conversation_states WHERE group_id IS NULL`。`group_id` 現為 nullable，但**無任何寫入路徑能產生 NULL**（5 個 upsert 呼叫點皆傳真實 groupId；handler 丟棄非群組來源），故實務影響 0 列；縱有殘列，複合 PK 下永不可能被命中（fail-closed），刪除為正解。
2. `ALTER TABLE conversation_states ALTER COLUMN group_id SET NOT NULL`。
3. `ALTER TABLE conversation_states DROP CONSTRAINT conversation_states_pkey`。
4. `ALTER TABLE conversation_states ADD PRIMARY KEY (group_id, line_user_id)`。

**風險為何低**：本表是**暫存**（in-flight 開團問答／分組 session），非帳務或報名資料；最壞情況是某人進行中的流程消失、重打 `開團` 即可。**不得**把此結論套用到 `registrations`／`events`。

### 2. Repository 介面變更（`conversation-repository.ts`）
- `get(lineUserId)` → `get(groupId, lineUserId)`；`delete(lineUserId)` → `delete(groupId, lineUserId)`；`ConversationReader` 同步。
- `upsert` 的 `ON CONFLICT (line_user_id)` → `ON CONFLICT (group_id, line_user_id)`；`UpsertConversationInput.groupId` 收斂為 `string`（去掉 `| null`，從型別排除 NULL 列）。
- 受影響呼叫點：讀 5 處（`handler.ts` 攔截、`event-service` 的 `continueFlow`/`confirm`/`abort`、`grouping-service.nextRound`）、寫 5 處（`startCreation`/`handleOneline`/`continueFlow`/`startRounds`/`nextRound`）、`delete` 於 `confirm`/`abort`。

### 3. 語意收斂（承 D-004 errata 第 6 條）
- `NextRoundInput.groupId` 由「守衛用」變為**查詢鍵**。
- **五道 group 比對守衛全部保留**為縱深防禦（G3）：複合鍵已使跨群不可讀，守衛成為冗餘但零成本的第二道；且它們是回歸測試的錨點。
- **(N2) 告知句收斂**：`abandoned: 'create'` **變成不可達 ⇒ 移除**（同群 mid-flow 的 `開團` 被 handler 攔截為答案；別群現各自一列）。`abandoned: 'grouping'` **保留**——同群內開團問答與分組 session 仍共用同一列，該群有分組 session 時打 `開團` 依然覆寫它。
- **附帶消解一項疑慮**：收斂後唯一的告知句只在**同群**發生，不可能洩漏其他群資訊；T-021 遺留的「看到告知句是否等於確認前一段流程在別群」問題自然不成立。

### 範圍外
- 同群內「開團問答 ↔ 分組 session」互斥（仍共用 `(group, user)` 一列）。若要並行需 PK 再加 state 維度或分表 ⇒ 另案。
- conversation TTL 清理（OP-6）：本設計不引入 TTL；複合鍵使殘列數上限由「人數」變為「人數 × 群數」，TTL 的必要性略升，登記 Backlog。
- 1:1（非群組）流程：handler 仍丟棄非群組來源，故無 `group_id` 來源問題。

## 二、Guardrails（Must NOT）
- **G1（凍結區）**：不得改寫 `0001~0003` 任何內容；PK 變更**只能**以新增 `0004` 達成。不得改動 `src/db/tx.ts`。
- **G2（無殘留單鍵查詢）**：`conversation_states` 的任何 SQL **不得**只以 `line_user_id` 為條件；讀、寫、刪一律帶 `group_id`。不得於 domain/handler 自拼 SQL 繞過 repository。
- **G3（守衛不得移除）**：不得以「複合鍵已足夠」為由刪除 T-021 的五道 `conv.group_id === groupId` 守衛；它們保留為縱深防禦與回歸錨點。
- **G4（(N2) 精確收斂）**：不得保留已不可達的 `abandoned: 'create'` 分支（死碼）；亦**不得**連帶移除仍可達的 `'grouping'` 分支。
- **G5（暫存語意不變）**：不得將 `conversation_states` 當作可長期保存的業務資料；不得因本變更而在其中存放報名／費用等業務欄位。
- **G6（NULL 不得復活）**：`UpsertConversationInput.groupId` 不得再允許 `null`；不得新增任何能寫入 NULL `group_id` 的路徑。

## 三、Acceptance Checks
- [ ] **[D-013 AC-1]（跨群並行）**：同一人在 A 群 `開團` 進到 `awaiting_time`，於 B 群 `開團` → **兩列並存**；A 群列的 `state`/`payload` 不變，回 A 群作答正常前進；B 群列獨立前進。**不出現任何放棄告知**。
- [ ] **[D-013 AC-2]（跨群不可讀，結構性）**：A 群有 `grouping` session 時於 B 群 `下一輪` → `no_session`，且**回覆不含 A 群任何人名**；B 群 `確認`／`取消` 對 A 群流程零影響。
- [ ] **[D-013 AC-3]（migration 0004 正確性）**：對含 `group_id IS NULL` 殘列的 DB 執行 0004 → NULL 列被刪、`group_id` 為 NOT NULL、PK 為 `(group_id, line_user_id)`；執行後 `upsert` 對同一人不同群各自成列、同一 `(群, 人)` 則覆寫。
- [ ] **[D-013 AC-4]（同群 grouping 覆寫仍告知）**：同群有 `grouping` session 時 `開團` → 回覆含「已結束你先前未完成的分組。」，且**不含**任何群組識別或活動內容。
- [ ] **[D-013 AC-5]（`create` 分支已移除）**：任何路徑皆不再產生「已放棄你先前未完成的開團。」；`AbandonedKind` 不再含 `'create'`（型別層面）。
- [ ] **[D-013 AC-6]（無殘留單鍵查詢）**：全庫掃描 `conversation_states` 相關 SQL，皆帶 `group_id`；`get`/`delete` 簽名為 `(groupId, lineUserId)`，無呼叫點漏改（**含測試檔——測試不受 `tsc` 檢查，須 grep 核對**，見 LESSONS 2026-08-19）。
- [ ] **[D-013 AC-7]（既有行為零回歸）**：T-021 的三條跨群整合測試與既有 358 tests 全綠；同群內開團／報名／名單／分組／加開行為不變。

## 討論紀錄（待使用者裁決）
| # | 議題 | 建議預設 | 使用者裁決 |
|---|---|---|---|
| 1 | **PROD 上線順序**。0004 **非向後相容**：舊版程式的 `ON CONFLICT (line_user_id)` 在 PK 換掉後會直接報錯（找不到匹配的唯一約束）。(a)**單階段**：先跑 0004 再部署新 revision——舊 revision 若仍在服務，該窗口內的開團/分組 upsert 會失敗（使用者重打即可；min-instances=0、流量極低）。(b)**兩階段零停機**：先加 `UNIQUE (group_id, line_user_id)` 並部署改用新 conflict target 的程式，確認後再 drop 舊 PK 並提升為 PK（多一次 migration 與一次部署）。 | **(a) 單階段** | **裁決（2026-08-19）：(a) 單階段**。runbook 須明載「0004 執行後應立即部署新 revision」，並提示該窗口內開團/分組指令可能失敗、重打即可。 |
| 2 | **既有 NULL 列處理**：實務上應為 0 列。(a) `DELETE` 掉（建議）(b) backfill 一個哨兵值後保留 | **(a) DELETE** | **裁決（2026-08-19）：(a) DELETE**（orchestrator 逕定：無合理 backfill 值、複合 PK 下 NULL 列永不可命中、實務 0 列）。 |
| 3 | 五道守衛去留 | 全部保留為縱深防禦（G3） | 已定（不需裁決，列此備查） |
