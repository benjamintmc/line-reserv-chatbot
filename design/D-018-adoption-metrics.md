# D-018: 觸及與擴散觀測（`groups` 表 + join/leave 接線 + 指標 SQL）

- 狀態：**APPROVED**（2026-08-28，使用者核可動工）
- 撰寫者：orchestrator（代筆；R1）
- 關聯：Brief §0 Non-goals（不做 Admin 後台，指標以直連 SQL 觀測）/ 任務 T-029 / errata：D-001 §6·§8、D-003 §5

## 一、設計內容

**問題**：五項成長指標中，前四項已可直接由 `users`/`events`/`registrations` 查出；第五項
「有幾個非我主動建立的群組開始使用」查不到——**資料庫裡沒有「群組」這個實體**。`group_id` 只在
有人**成功開團**時才第一次出現，因此「加了機器人卻從未開團的群」在資料上完全不存在（最大盲點），
且「機器人何時進入／離開某群」無任何紀錄。本案補齊這層資料，並把五項指標的 SQL 固定落點。

**平台天花板（先講清楚）**：LINE Messaging API **不提供群組建立者資訊**，`join` 事件的 source 也
只帶 `groupId`。因此「非我主動建立」**任何做法都無法自動判定**。使用者已裁決**不做人工標記**（2026-08-28），
故本設計**不設 `origin` 欄位**，第 5 項指標一律以 `docs/metrics.md` 的
「我從未在其中開過團的群」推估——**它是估計值，不是精確數字**，解讀時須知此限制。

### 範圍內
1. **migration `0005_groups.sql`**（只新增，不動 0001–0004 凍結區）：
   ```sql
   CREATE TABLE groups (
     group_id       TEXT PRIMARY KEY,
     group_name     TEXT,                      -- best-effort 快照；取不到為 NULL
     joined_at      TEXT NOT NULL,             -- UTC ISO-8601，應用層寫入（D-001 §0 G11）
     discovered_via TEXT NOT NULL CHECK (discovered_via IN ('join','message','backfill')),
     left_at        TEXT,                      -- NULL = 仍在群
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL
   );
   CREATE INDEX ix_groups_active ON groups (joined_at) WHERE left_at IS NULL;
   ```
   同檔 backfill 既有群：`INSERT … SELECT group_id, MIN(created_at), 'backfill' … FROM events
   GROUP BY group_id ON CONFLICT DO NOTHING`。**`discovered_via='backfill'` 的 `joined_at` 是下限**
   （實際加入時間更早、不可考），解讀指標時須排除或標註。
2. **`join`／`leave` 事件接線**（`handleEvent` 事件型別白名單自「僅 message」擴為 message+join+leave）：
   - `join`（且 `source.type==='group'`）→ upsert：`ON CONFLICT (group_id) DO UPDATE SET left_at=NULL`
     （被踢後再加回：清空 `left_at`、**保留最早的 `joined_at`**）。
   - `leave` → `UPDATE … SET left_at=$now WHERE group_id=$1 AND left_at IS NULL`（重複不覆蓋）。
   - 兩者**一律不回覆、不 `markProcessed`**（屬 §4 去重政策「本來就不回覆」的例外路徑）。
3. **訊息路徑 first-seen 補登**：功能上線前既已在群的 bot **永遠不會再收到 `join`**，故在
   `handleEvent` 確認 `source.type==='group'` 之後、conversation 攔截之前，做一次
   `INSERT … ON CONFLICT DO NOTHING RETURNING group_id`（`discovered_via='message'`）。這也是
   「加了不開團」的唯一觀測來源。熱路徑成本 +1 次 DB 往返（該路徑原已有 `conversations.get`，1→2）。
4. **群組名稱 best-effort**：**僅當上一步 `RETURNING` 真的回傳新列時**（每群一生一次）呼叫
   `getGroupSummary(groupId)` 寫入 `group_name`；比照 `resolveDisplayName` 的 try/catch + `logError`
   + `redactId` 既有模式，失敗即 NULL。理由：PM 面對 32 位十六進位的 `groupId` 無法行動。
5. **`docs/metrics.md`**：五項指標各一段 SQL（實際使用者數／活動數／重複開團主／回訪率／擴散群組數），
   附各自的口徑定義。指標定義採本次對話裁決：「實際使用者」＝有過未取消的 `kind='self'` 報名者
   （被代報名者無 LINE 帳號紀錄，不計）；「回訪」＝參加過 **2 場以上不同活動**。

### 範圍外
- 判定 LINE 群組建立者——平台不提供，且使用者已裁決不以人工標記補足（見上）。
- 任何使用者可見的文案、指令或行為變化——本案對群組成員**完全靜默**。
- 報表／dashboard 介面、排程快照、事件流（event sourcing）；PM 直接對 Neon 跑 SQL。
- 個人層級的活躍度時間序列、群組成員數。

### 將改動的既有文件（預列 errata）
- `design/D-001-data-model.md` §6 ERD + §8 migration 策略 → 新增第 6 張表 `groups`（與其餘 5 表**無 FK 關聯**，
  刻意不對 `events.group_id` 建 FK：groups 可先於 events 存在，加 FK 會讓 backfill 與首見順序耦合）。
- `design/D-003-registration-core.md` §5（第 194 行「非 text 事件／非群組來源：一律忽略」）→
  改為「非 text 之 **message** 事件一律忽略；`join`／`leave` 例外，僅寫 `groups`、仍不回覆」。

### Conversation state 三件套
無（本設計不新增任何 conversation state）。

## 二、Guardrails（Must NOT）
- **G1**：不得讓 `groups` 的任何讀寫影響使用者可見行為。所有 `groups` 寫入與群組名稱查詢一律以
  try/catch 包覆，失敗只 `logError` 後繼續原流程。**這是對 CLAUDE.md §4「不吞例外」的顯式申報偏離**
  ——理由：觀測寫入失敗不得使報名／開團失效；既有 `resolveDisplayName` 已是同型先例。
- **G2**：不得新增任何使用者可見文案或指令；`join`／`leave` 不得回覆訊息、不得 `markProcessed`。
- **G3**：不得改寫 `src/db/migrations/0001`–`0004`（凍結區）；只新增 `0005_groups.sql`。
- **G4**：首見路徑上不得超過「1 次 `INSERT … ON CONFLICT DO NOTHING`」的 DB 往返；群組名稱 API
  **只在該 INSERT 實際新增一列時**觸發，不得每則訊息都打。
- **G5**：不得新增任何需要人工維護才有意義的欄位（如已裁決移除的 `origin`）——無人維護的欄位
  即 §3.6 的 TODO 黑洞；第 5 項指標一律由 `docs/metrics.md` 的查詢推估，不落成 schema 欄位。
- **G6**：不得改動 `src/domain/registration-service.ts`、`src/domain/event-service.ts`、`src/db/tx.ts`
  （高風險模組／凍結區）；`groups` 寫入不得進入任何既有交易。
- **G7**：非群組來源（1:1 聊天、room）的任何事件不得寫入 `groups`。

## 三、Acceptance Checks
- [ ] **[D-018 AC-1]**：群組來源 `join` 事件 → `groups` 新增一列，`discovered_via='join'`、`left_at IS NULL`，且 `handleEvent` 回傳**空陣列**（不回覆）。（執行：`npm test`，G2）
- [ ] **[D-018 AC-2]**：`leave` 事件 → 該列 `left_at` 寫入；再次 `leave` **不覆蓋**既有 `left_at`。（`npm test`）
- [ ] **[D-018 AC-3]**：被踢後再 `join` → `left_at` 回到 NULL，`joined_at` **維持首次值**。（`npm test`）
- [ ] **[D-018 AC-4]**：未見過的群組送出一般文字訊息 → 自動新增一列且 `discovered_via='message'`；
  同群**第二則**訊息不新增列、且群組名稱 API 的 mock 呼叫次數**維持 1**。（`npm test`，G4）
- [ ] **[D-018 AC-5]**：群組名稱查詢拋錯 → `group_name` 為 NULL，且該則訊息的回覆內容與未接線前**逐字相同**。（`npm test`，G1）
- [ ] **[D-018 AC-6]**：`groups` 寫入拋錯（注入失敗的 repo）→ 使用者仍收到原本的回覆。（`npm test`，G1）
- [ ] **[D-018 AC-7]**：對含既有 `events` 資料的測試 DB 跑 `0005` → 每個曾出現的 `group_id` 皆有一列且
  `discovered_via='backfill'`；重跑 migration runner 不重複插入、不報錯。（`npm test`，G3）
- [ ] **[D-018 AC-8]**：`source.type` 為 `user`／`room` 的 `join`／`message` 事件 → `groups` **零列新增**。（`npm test`，G7）
- [ ] **[D-018 AC-9]**：`docs/metrics.md` 內五段 SQL 逐一對測試 DB 執行皆成功且各回傳單列。（執行：`npm test` 讀該檔實跑）

（「既有測試零回歸 + 四關全綠」不另列為 AC——那是 CLAUDE.md §6 關卡 0 對**所有**任務的通用要求，
列進來只會產生一條無法對應測試標記的假 AC。驗收證據記於 task-board。）

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-28 | 是否為第 5 項指標開案、風險等級 | **開案，R1**（新增 migration 通常 R2，但本表不動既有資料、不在報名併發路徑上） |
| 2026-08-28 | 觀測寫入失敗時的行為（憲法 §4「不吞例外」偏離） | **接受偏離**：指標寫入失敗只記 log，使用者回覆不受影響 |
| 2026-08-28 | `origin` 人工標記「非我建立的群組」 | **不做**。移除 `origin` 欄位；第 5 項指標接受為推估值 |
| 2026-08-28 | 「再次使用」的口徑 | **維持「參加過 2 場以上不同活動」** |
