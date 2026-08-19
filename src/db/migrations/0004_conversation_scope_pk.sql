-- 0004_conversation_scope_pk.sql — D-013 §1（PostgreSQL 方言；migration runner 單檔單交易）
--
-- conversation_states 的 PK 由 line_user_id（跨群唯一 ⇒ 一人全系統只有一列）改為
-- (group_id, line_user_id)，使同一人在不同群的流程（開團問答／分組 session）**並行共存**，
-- 並讓「跨群讀到他群資料」由守衛修補升級為**結構上不可能**（查詢鍵本身帶 group）。
--
-- 0001~0003 為凍結區（已於 PROD 執行）——只新增、不改寫（D-013 G1 / CLAUDE.md §4.5）。
-- 本檔**不得**夾帶任何其他資料表的變更（G8）。
--
-- 上線程序（單階段，裁決 #1）：對直連跑本 migration → **立即**部署新 revision。
-- 該窗口內舊 revision 的 `ON CONFLICT (line_user_id)` 會找不到匹配唯一約束而失敗
-- （開團／分組類指令重打即可）。詳見 docs/deployment-runbook.md §2.1。

-- (0) 鎖等待上限（本 migration 最大的維運風險防護，D-013 §1 步驟 0 / architect B2）。
--     ALTER TABLE 需 ACCESS EXCLUSIVE 鎖；若被任何持有本表鎖的交易擋住，後續所有
--     conversation_states 查詢會排隊其後，而 handler 的第一個動作就是 conversations.get
--     ⇒ webhook 全面逾時。逾時則整檔 ROLLBACK（runner 單檔單交易），稍後重跑即可。
--     runner 已先 BEGIN，故 SET LOCAL 合法且作用於本交易。
SET LOCAL lock_timeout = '3s';

-- (1) 清 NULL 列（裁決 #2；G8：**只得**帶 WHERE group_id IS NULL）。
--     group_id 現為 nullable，但無任何寫入路徑能產生 NULL（5 個 upsert 呼叫點皆傳真實 groupId、
--     handler 丟棄非群組來源）⇒ 實務影響 0 列；縱有殘列，複合 PK 下亦永不可能被命中（fail-closed）。
DELETE FROM conversation_states WHERE group_id IS NULL;

-- (2) 收斂為 NOT NULL（ADD PRIMARY KEY 已隱含；保留為顯式意圖宣告）。
ALTER TABLE conversation_states ALTER COLUMN group_id SET NOT NULL;

-- (3) 移除舊 PK。約束名已對真 PG 實測查證（2026-08-19）：0001_init.sql:76 的隱式
--     `line_user_id TEXT PRIMARY KEY` 產生 conname = conversation_states_pkey /
--     def = PRIMARY KEY (line_user_id)。舊 PK 的隱含索引由該約束擁有，隨 DROP 一併消滅
--     （無需 DROP INDEX、不留孤兒索引）。日後若改用具名約束，此步須同步更新。
ALTER TABLE conversation_states DROP CONSTRAINT conversation_states_pkey;

-- (4) 新複合 PK。欄位順序 (group_id, line_user_id)：現行查詢一律兩欄等值（兩序等效），
--     此序另具「按群前綴掃描」優勢，利於未來 TTL／按群清理。
--     先 drop 後 add，故無同名衝突；不需額外索引（無任何單以 line_user_id 的查詢，G2；本表無 FK 指向）。
ALTER TABLE conversation_states ADD PRIMARY KEY (group_id, line_user_id);
