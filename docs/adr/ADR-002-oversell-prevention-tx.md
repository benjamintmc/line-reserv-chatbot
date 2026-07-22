# ADR-002: 報名防超賣的併發策略（SQLite IMMEDIATE / PostgreSQL row lock）

- 狀態：已採納
- 日期：2026-07-22
- 決策者：architect（審查：architect-reviewer）

## 背景
NFR-1 要求報名寫入用 transaction / row lock 防超賣。成功條件 #2 與旅程 #2：容量剩 1，
兩位成員幾乎同時 `+1`，僅一人進正取、無超賣。per-slot 設計下，判斷是否額滿需在同一
交易內「先計數有效正取、再決定插入正取或候補」，兩步之間不得被其他寫入插隊。
取消採 soft-delete（ADR-001 增訂）後，取消會釋出名額並觸發 FIFO 遞補，故取消同屬須序列化的寫入。

## 決策
以「單場活動的報名/取消/遞補寫入序列化」達成防超賣，兩種資料庫各自對映：

- **SQLite（better-sqlite3，MVP）**：報名/取消交易用 **`BEGIN IMMEDIATE`**（better-sqlite3 的
  `db.transaction(fn).immediate(...)`）。IMMEDIATE 在交易開始即取得 RESERVED 寫鎖，
  搭配 `PRAGMA journal_mode=WAL`、`PRAGMA busy_timeout=5000`、`PRAGMA foreign_keys=ON`。
  better-sqlite3 為同步、單行程，加上寫鎖即可序列化所有報名/取消交易。交易內：
  `SELECT COUNT(*) WHERE event_id=? AND status='confirmed' AND cancelled_at IS NULL` → 計算可用名額 →
  決定整批進正取或整批進候補 → 插入 N 列並指派 `seq`；取消交易則 soft-delete 目標列後，於同一交易
  選有效候補（`WHERE status='waitlist' AND cancelled_at IS NULL ORDER BY seq`）遞補。
- **PostgreSQL（無持久磁碟平台）**：交易開頭 `SELECT ... FROM events WHERE id=? FOR UPDATE`
  取得該 event 列鎖，序列化同一場的報名/取消/遞補寫入；其餘計數與插入邏輯相同。

`seq` 於同一交易內以 `SELECT COALESCE(MAX(seq),0)+1 WHERE event_id=?` 指派（含已取消列，只增不減），
因寫入已序列化故無競態；`UNIQUE(event_id, seq)` 為最後防線。

## 理由與被放棄的替代方案
| 方案 | 優點 | 缺點 | 結果 |
|---|---|---|---|
| SQLite IMMEDIATE + PG FOR UPDATE | 明確序列化、實作簡單、與 per-slot 計數一致；報名/取消/遞補共用同一語意 | 同場寫入序列化（單場低流量可接受） | **採納** |
| SQLite 預設 DEFERRED 交易 | 無需指定 | 寫鎖延到首次寫入才取得，計數與插入之間可能被插隊 → 超賣風險 | 放棄 |
| 應用層 mutex/佇列 | 不依賴 DB 語意 | 多行程/多實例失效；重啟遺失；與 DB 事實不同步 | 放棄 |
| PG SERIALIZABLE 隔離 | 理論最嚴 | 需處理序列化失敗重試；MVP 過度 | 放棄（FOR UPDATE 已足夠） |

## 影響
- D-001 於 registrations 的報名與取消（soft-delete + 遞補）寫入路徑要求此交易語意；D-002 報名核心據此實作。
- repository 層需提供「以 IMMEDIATE 交易執行報名/取消」的封裝；連線初始化須設上述 PRAGMA。
- Guardrail：不得在無 IMMEDIATE 交易 / row lock 下寫入或取消 registrations（D-001 G2）。
