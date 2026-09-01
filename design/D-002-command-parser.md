# D-002: 指令解析（Command Parser，純文字 → 結構化指令）

- 狀態：APPROVED（2026-07-23，經 architect-reviewer 審查通過 + nit errata + 使用者核可）
- 撰寫者：backend-engineer
- 關聯：Brief「指令規格總表」§58–69 / FR-1~FR-5 §29–36 / 里程碑 M1 §73 / 決策紀錄 #1–#6 §79–85 / 關鍵使用者旅程 §87–91 ・ 任務 T-005 ・ 設計 D-002
- 相依：D-001（**APPROVED**；僅欄位對接——解析輸出需能餵給 `registrations`/`events` 的欄位語意；**本文件不含任何 DB 寫入、報名決策、遞補、授權邏輯**）

---

## 一、設計內容

### 0. 目標與定位

D-002 只做**一件事**：把一則 LINE 文字訊息（`string`）解析為一個**結構化、可辨別聯合（discriminated union）的 `ParsedCommand`**。它是純解析層（pure parsing layer），對應任務 T-005、里程碑 M1、風險 R1。

- 「認出這是哪個指令與其參數」→ 屬 D-002（本文件）。
- 「執行指令、授權判斷、額滿/候補決策、DB 寫入、名單組版、開團問答流程」→ 屬 D-003 / M2 / M3。

parser **不觸 DB、不觸網、不讀 env、不拋例外給呼叫端**；任何輸入都回傳一個合法的 `ParsedCommand`（最壞情況為 `unknown`）。

#### 計數（count）邊界總覽（O-1 + O-3 裁決，2026-07-23）

`+N`/`-N` 的 `count` 依區間**不對稱**處理：

| `count` 值 | 產出 | 對使用者效果 | 理由 |
|---|---|---|---|
| `count < 1`（即 `+0` / `-0`） | `{ type:'unknown' }` | webhook **靜默不回覆**（no-op） | 0 多為誤植/玩笑，靜默避免洗版（O-3 裁決） |
| `1 <= count <= MAX_COUNT`（20） | 有效 `signup`/`cancel` | 正常報名/取消 | – |
| `count > MAX_COUNT`（如 `+21`/`+99`/超大數字） | `{ type:'invalid', reason:'count_out_of_range' }` | 帶原因供上層決定是否回提示 | 明確超限嘗試，值得標記（O-1 裁決） |

### 1. `ParsedCommand` 型別（discriminated union，嚴禁 any）

以 `type` 欄位為判別鍵。以下為型別草案（**設計說明用，非實作交付**）：

```ts
// src/commands/types.ts

/** 單次 +N/-N 的人數上限（防濫用；O-1 裁決）。 */
export const MAX_COUNT = 20;
/** 代報名 display_name 長度上限（JS string length / UTF-16 code unit 計）；超長截斷取前 20（O-4 裁決）。 */
export const MAX_PROXY_NAME_LEN = 20;
/** 一行式開團 capacity 上限（sanity 保護；events.capacity CHECK>0，D-001 §2）。 */
export const MAX_CAPACITY = 1000;

/** 畸形但可辨識為某指令嘗試時，標記是哪個指令家族。 */
export type InvalidCommandKind = 'signup' | 'cancel' | 'create_event';

/** 畸形原因（供 D-003/webhook 決定是否回提示；D-002 不決定要不要回覆）。 */
export type InvalidReason =
  | 'count_out_of_range'    // +N 超過 MAX_COUNT（如 +21/+99/超大數字）；注意 +0/-0 歸 unknown 非此
  | 'create_wrong_arity'    // 開團 參數數量不是 5
  | 'create_bad_date'       // 日期格式/範圍錯
  | 'create_bad_time'       // 時間格式/範圍錯
  | 'create_bad_capacity'   // 人數非正整數
  | 'create_bad_price';     // 價格非非負整數

export type ParsedCommand =
  // 報名（含代報名）：count>=1；proxyName 存在即代報名（kind='proxy'）
  | { type: 'signup'; count: number; proxyName?: string }
  // 取消（含代報名取消）
  | { type: 'cancel'; count: number; proxyName?: string }
  // 名單 / list / LIST
  | { type: 'list' }
  // 一行式開團（欄位已正規化：date=YYYY-MM-DD、time=HH:MM、capacity/price 為整數）
  | {
      type: 'create_event_oneline';
      date: string;      // 'YYYY-MM-DD'
      time: string;      // 'HH:MM'（24h，零填充）
      location: string;  // 原樣（僅 trim；白名單字元類已於全串正規化，見 §5）
      capacity: number;  // 正整數
      price: number;     // 非負整數（新台幣元）
    }
  // 開團（無參數）→ 進入逐步問答（流程屬 D-003）
  | { type: 'create_event_start' }
  // 開團流程：確認
  | { type: 'confirm' }
  // 開團流程：放棄（`取消`）。語意（放棄哪段流程）由 D-003 依 conversation_states 解讀
  | { type: 'abort' }
  // 關閉報名
  | { type: 'close_event' }
  // 取消活動
  | { type: 'cancel_event' }
  // 我的ID（私訊回 userId）
  | { type: 'my_id' }
  // 可辨識為某指令嘗試，但參數畸形；帶原因供上層決定是否回提示
  | { type: 'invalid'; command: InvalidCommandKind; reason: InvalidReason; raw: string }
  // 完全無法辨識（群組閒聊、+0/-0、sign 後非數字等）→ webhook 一律不回覆（FR-5）
  | { type: 'unknown' };
```

> **errata（2026-08-23，D-015／T-026）：新增 `編輯` 指令家族。** 原文的 union／原因碼清單是 T-005 當時的完整集合，**不是封閉集**；後續設計得依其自身流程擴充（`group`／`group_next`／`add_capacity` 亦同此理）。D-015「編輯活動資訊」新增：
> - `ParsedCommand` 增 **`{ type:'edit_event'; field:'date'|'time'|'location'|'fee'|'capacity'; value:string }`**（`date`／`time` 之 `value` 已經 `validateDate`／`validateTime` 正規化；`capacity` 只用於回「請改用 `加開 N`」導向文案，不帶異動語意）與 **`{ type:'edit_help' }`**（無參數 `編輯`／未知欄位名／缺新值）。
> - `InvalidCommandKind` 增 **`'edit_event'`**；`InvalidReason` 增 **`'bad_location'`**（場地名超過 40 個 code unit；刻意不加 `create_` 前綴，因其不屬開團家族）；`invalid` 增選填 **`detail?: { len: number }`**（供回覆顯示使用者實際輸入字數）。
> - **與既有靜默政策的差異（刻意）**：`+N`／`加開` 的畸形輸入多歸 `unknown`（防洗版）；**首 token 為 `編輯` 者一律回覆、不落入 `unknown`**。理由：`編輯` 不會出現在閒聊，且既然無參數 `編輯` 要回現值清單，`編輯 日期`（缺值）若靜默就成了「打對一半卻沒反應」的死角。G3「不可識別必 silent」的適用對象仍是**無法辨識**的輸入，`編輯 …` 屬**可辨識**，不在其射程內。
> - **取值規則兩者相反，勿混用**：`location` 為 `tokens.slice(2).join(' ')`（**保留空格**，場地名需要）；`fee` 為 `tokens.slice(2).join('').replace(/\s+/g,'')`（**compact**，因 `validateVenueFee`／`validatePrice` 不吸收空白，`場地費 4000` 不壓縮會被誤拒）。

**畸形輸入的兩層歸類（重要取捨，見 §四 O-2）**：

- `unknown`：**完全不是指令，或視為 no-op 的靜默輸入**（閒聊、無指令前綴、`+`/`-` 後非數字、`+0`/`-0`、空白等）。webhook **必須不回覆**（satisfies FR-5、成功條件 #5）。
- `invalid`：**明確是某指令的嘗試但參數畸形**（`開團` 關鍵字命中但欄位不對、`+21` 超上限）。attach `reason`，讓 D-003/webhook **有資訊可決定**是否回「格式錯誤」提示。D-002 只負責分類與帶原因，**不決定要不要回覆、也不組版提示文字**。

> `+abc`（sign 後非數字）與 `+0`/`-0`（count<1）刻意歸 `unknown`（silent），不歸 `invalid`：`+`/`-` 僅在**緊接 1 以上人數**時才是有效報名/取消；否則視為非指令/no-op，避免洗版（見 §四 O-2、O-3 理由）。

### 2. 解析函式介面

```ts
// src/commands/parse.ts
export function parseCommand(text: string): ParsedCommand;
```

- **純函式**：無副作用、無 I/O、不讀 env、相同輸入必得相同輸出、任何輸入皆不拋例外。
- 輸入為 LINE 文字訊息的 `message.text`（型別上永遠是 `string`；防禦性上若拿到非字串一律 `unknown`）。

#### 正規化管線（pipeline，順序固定）

1. **型別防禦**：非 `string` → `unknown`。
2. **全形空白轉換**：`U+3000`（全形空格）→ 半形空格 `' '`（供 trim 與 token 切分）。
3. **外層 trim**：去頭尾空白。
4. **空字串短路**：trim 後為空 → `unknown`。
5. **白名單字元正規化（僅限白名單字元類，對全串生效，token 切分前執行）**：見 §5 對照表——全形數字、全形/Unicode 加減號、全形冒號 → 半形。此轉換**對整串套用**，故位於 location/proxyName 內的這些白名單字元**也會被轉半形**（例：location `２號球場` → `2號球場`、proxyName 內全形數字亦轉半形）。**中文與其他非白名單字元一律保留原樣**——即**非**「location/proxyName 完全不動」，而是「只動白名單字元類、其餘字元不動」。此行為自洽且不違反 G6（未做無差別 NFKC）。
6. **關鍵字比對用大小寫折疊**：ASCII 關鍵字（`list`、`我的ID` 的 `ID`）比對時 case-insensitive；中文關鍵字為精確比對。
7. **分派（dispatch）**：依「首字元/首 token 或精確關鍵字」路由到各解析分支（§3、§4）。任何未命中 → `unknown`。

### 3. 各指令解析規則

正規化後（§2 步驟 1–6）依序判斷：

| 判斷順序 | 輸入樣態（正規化後） | 產出 |
|---|---|---|
| 1 | 精確等於 `名單`，或 case-fold 後等於 `list` | `{ type: 'list' }` |
| 2 | 精確等於 `確認` | `{ type: 'confirm' }` |
| 3 | 精確等於 `取消活動` | `{ type: 'cancel_event' }` |
| 4 | 精確等於 `取消` | `{ type: 'abort' }` |
| 5 | 精確等於 `關閉報名` | `{ type: 'close_event' }` |
| 6 | case-fold 後等於 `我的id` | `{ type: 'my_id' }` |
| 7 | 首 token 為 `開團` 或 `新活動`，且**無其他 token** | `{ type: 'create_event_start' }` |
| 8 | 首 token 為 `開團` 或 `新活動`，**有其他 token** | 走 §4 一行式解析 → `create_event_oneline` 或 `invalid(create_event, …)` |
| 9 | 以 `+` 開頭 | 走 §3.1 報名解析 |
| 10 | 以 `-` 開頭 | 走 §3.1 取消解析 |
| 11 | 其餘一切 | `{ type: 'unknown' }` |

> row 3/4（`取消活動`、`取消`）皆以**完全相等**比對，各為獨立字串，**順序不影響正確性**；列於此僅為閱讀順序。`確認`/`取消` 為 stateless token；D-003 依 conversation_states 判斷當下是否有進行中流程來決定實際語意（無流程時可視為 no-op/unknown，屬 D-003）。

> **errata（2026-08-23，D-015／T-026）：dispatch 表新增 `編輯` 分支（置於 row 10 與 row 11 之間，即 `+`/`-` 之後、fallback `unknown` 之前）。** 首 token 為 `編輯` 時：第 2 token 為 `日期`／`時間`／`場地`（**別名 `地點`，parser 收但對外文案一律示範「場地」**）／`費用`／`人數` → `edit_event{field, value}`（`value` 取法見 §1 errata）；第 2 token 為其他字串、或缺第 3 token（`人數` 除外，其恆走導向文案）→ `edit_help`；`日期`／`時間` 的值格式錯 → `invalid{command:'edit_event', reason:'create_bad_date'|'create_bad_time'}`；場地超長 → `invalid{reason:'bad_location', detail:{len}}`。**此分支不會回 `unknown`**（理由見 §1 errata）。

#### 3.1 `+N` / `-N`（含代報名 `+N 名字` / `-N 名字`）

樣態（sign ∈ `{+, -}`）：`<sign><digits>[<剩餘字串作為 proxyName>]`

1. sign 後**必須緊接一個以上數字**；否則（如 `+abc`、`+`、`+ 1`）→ `unknown`。
   - 註：`+ 1`（sign 與數字間有空白）視為 `unknown`——報名指令要求 sign 緊貼數字。
2. 擷取連續數字字串 `d`；其後的剩餘字串（若有）即為 proxyName 來源（**不要求以空白分隔**，見 step 4 與 §四 O-6）。
3. `count = Number(d)`，依 §0 邊界表分派：
   - `count < 1`（即 `+0`/`-0`）→ `{ type:'unknown' }`（**靜默 no-op**，O-3 裁決；0 多為誤植/玩笑，靜默避免洗版）。
   - 位數過長（`d.length > 3`）或 `count > MAX_COUNT` → `{ type:'invalid', command:'signup'|'cancel', reason:'count_out_of_range', raw }`（O-1 裁決；涵蓋 `+21`、`+99`、`+99999999999`，明確超限嘗試值得標記）。
   - `1 <= count <= MAX_COUNT` → 續行 step 4。
4. 名字擷取（代報名，**寬鬆規則**）：
   - 取數字之後的**剩餘字串**（不論是否以空白分隔）→ trim → 內部連續空白折疊為單一空白 → `proxyName`。
     - 故 `+1 陳大哥`、`+1陳大哥`、`+1abc`、`+1.5` 皆把數字後剩餘字串當 proxyName（分別為 `陳大哥`/`陳大哥`/`abc`/`.5`）。此寬鬆語意由 AC-26 鎖定（取捨見 §四 O-6）。
   - 若 `proxyName` 為空（如 `+1`、`+1   `）→ **不帶 proxyName**（自報名）。
   - 若 `proxyName` 長度 > `MAX_PROXY_NAME_LEN`（20）→ **截斷取前 20 個字元**作為 `proxyName`（O-4 裁決；截斷屬正規化行為，非 invalid）。長度以 **JS string length（UTF-16 code unit）** 計，MVP 不做 grapheme/emoji 群集精算。
5. 產出 `{ type:'signup'|'cancel', count, proxyName? }`。

> `+N 名字` 於 N>1 的語意（2 個同名名額？）**不在 D-002 決定**——parser 照實回 `count` 與 `proxyName`，是否允許、如何生成 `名字(2)` 由 D-003 定（對接 D-001 `registrations.kind='proxy'`、`display_name`）。

### 4. 一行式開團解析規則

輸入（正規化後）：`開團 <date> <time> <location> <capacity> <price>`（首 token `開團` 或 `新活動`）。

- **切分**：以空白切成 tokens；丟棄首 token（`開團`/`新活動`）後，**剩餘必須恰為 5 個 token**：`[date, time, location, capacity, price]`。
  - token 數 ≠ 5 → `{ type:'invalid', command:'create_event', reason:'create_wrong_arity', raw }`。
  - （MVP 限制：location 為**單一 token、不含空白**；含空白地名會使 token 數 ≠ 5 而歸 arity 錯，請走逐步問答。見 §四 O-5、AC-25。）
- **date**：regex `^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$`；接受 `YYYY/MM/DD` 或 `YYYY-MM-DD`；月 1–12、日 1–31（MVP 只做範圍檢查，不做每月天數/閏年精算）；零填充輸出 `YYYY-MM-DD`（對接 D-001 `events.event_date`）。失敗 → `invalid(create_bad_date)`。
- **time**：regex `^(\d{1,2}):(\d{2})$`；時 0–23、分 0–59；零填充輸出 `HH:MM`（對接 `events.event_time`）。失敗 → `invalid(create_bad_time)`。
- **location**：非空字串（trim 後）→ 原樣保留。空 → 走 arity（不會發生，因 token 切分已保證非空）。
- **capacity**：去除尾綴 `人`（若有）→ regex `^\d+$` → 整數；須 `1 <= capacity <= MAX_CAPACITY`。失敗 → `invalid(create_bad_capacity)`。（`16人`、`16` 皆可。）
- **price**：去除尾綴 `元`（若有）→ regex `^\d+$` → 整數；須 `price >= 0`（對接 `events.price_per_person` 整數元，CHECK>=0）。失敗 → `invalid(create_bad_price)`。（`2200元`、`2200` 皆可。）
- 全部通過 → `{ type:'create_event_oneline', date, time, location, capacity, price }`。

> 多個欄位同時錯時，回傳**第一個**偵測到的錯誤 reason（**檢查順序 date→time→capacity→price**），保持回傳單一明確原因（例：日期與時間同錯 → 回 `create_bad_date`，見 AC-24）。

### 5. 正規化對照表（僅限白名單字元類）

| 類別 | 來源 | 正規化為 | 適用範圍 |
|---|---|---|---|
| 全形空格 | `U+3000`（`　`） | 半形空格 `' '`（`U+0020`） | 全串（供 trim/切分） |
| 全形數字 | `U+FF10–U+FF19`（`０–９`） | `0–9` | 全串（含 location/proxyName 內） |
| 全形加號 | `U+FF0B`（`＋`） | `+` | 全串 |
| 全形減號 | `U+FF0D`（`－`） | `-` | 全串 |
| Unicode 減號 | `U+2212`（`−`） | `-` | 全串 |
| 全形冒號 | `U+FF1A`（`：`） | `:` | 全串（含 location/proxyName 內） |
| 頭尾空白 | 各式空白 | 移除（trim） | 頭尾 |
| ASCII 關鍵字大小寫 | `list` / `LIST` / `List`、`我的ID` 的 `ID` | 比對時 case-fold | 關鍵字比對 |
| 代報名名字超長 | proxyName 長度 > 20（code unit） | 截斷取前 20 字元 | proxyName 擷取（§3.1 step 4，O-4） |

- **白名單字元類對全串生效**：上表「全串」列（全形數字/`＋`/`－`/`：`/全形空格）於 token 切分前對整個訊息套用，因此 location/proxyName 內若含這些字元也會被轉半形（例：`開團 … ２號球場 …` 的 location 會存為 `2號球場`）。此為預期行為，非 bug。
- **刻意不做**：全域 `String.prototype.normalize('NFKC')`、全形中文標點轉換、**非白名單字元**（中文、英文字母、全形括號等）的形變（見 G6）。只正規化上表字元類，確保地名/人名的其餘字元語意不被改動。
- 內部連續空白：僅在 proxyName 擷取時折疊為單一空白（§3.1）；一行式開團的欄位切分以 1+ 空白為分隔。
- proxyName 截斷以 **JS string length（UTF-16 code unit）** 計長度，取前 20 個 code unit；MVP 不處理 emoji surrogate pair 群集邊界。

### 6. 與 webhook 層的關係與模組劃分

- parser 位於 `src/commands/`（符合 CLAUDE.md §4「`src/commands`：指令解析」）：

| 檔案 | 職責 | 依賴 |
|---|---|---|
| `src/commands/types.ts` | `ParsedCommand` union、常數（`MAX_COUNT`…）、`InvalidReason`。**嚴禁 any** | – |
| `src/commands/normalize.ts` | 正規化 helpers（全形→半形字元類、trim、case-fold 比對工具、proxyName 截斷） | – |
| `src/commands/parse.ts` | `parseCommand(text)`：純函式，組裝正規化管線 + 分派 | types、normalize |
| `src/commands/index.ts` | re-export（`parseCommand`、型別、常數） | 上列 |
| `src/commands/__tests__/parse.test.ts` | 單元測試（覆蓋 §三 AC） | parse |

- **`src/webhook/handler.ts` 的接法**（示意，非本文件交付；取代現行 M0 echo `buildReplies`）：
  文字訊息 → `const cmd = parseCommand(event.message.text)` → `switch (cmd.type)` 分派。
  - `unknown` → **回傳空陣列（不回覆）**，維持現行 echo 骨架「其餘事件不回覆」的形狀（`handler.ts` L13）。
  - `invalid` → 是否回提示為 **D-003/webhook 政策**（D-002 只提供 `reason`）；MVP 建議：`create_event` 類 invalid 回「格式錯誤 + 正確用法」提示，`signup`/`cancel` 類 invalid 傾向靜默（避免洗版），實際政策由 D-003 定。
  - 其餘（`signup`/`cancel`/`list`/`create_*`/`confirm`/`abort`/`close_event`/`cancel_event`/`my_id`）→ 交由 D-003/M2/M3 的 domain handler 執行（授權、額滿、DB 寫入、組版皆在那層）。
- `switch` 須對 union **窮舉**（exhaustive，含 `default: never` 檢查），保證新增指令型別時編譯期即被提醒（G7）。

> **errata（2026-08-23，D-015／T-026）：`invalid` 的回覆政策對 `edit_event` 家族是例外。** 上文「`signup`/`cancel` 類 invalid 傾向靜默」與 handler 現行「非 create/group 的 `invalid` 一律回 `[]`」對 `edit_event` **不適用**——`invalid{command:'edit_event'}` 與 `edit_help` **都必須送進 `eventService.editEvent()`**，由其在交易內 `markProcessed` 後回格式提示（CLAUDE.md §4：會回覆的分支一律消費 `message.id`）。G7 窮舉仍成立：新增兩個 union 成員會使 `dispatchSingle` 的 `never` 檢查編譯失敗，必須補分支。

### 範圍內

- 文字 → `ParsedCommand` 的**純解析**：`+N`/`-N`（含代報名 `+N 名字`/`-N 名字`）、`名單`/`list`、`開團`（一行式與無參數觸發）、`確認`、`取消`、`關閉報名`、`取消活動`、`我的ID`。
- 正規化（全形數字/加減號/冒號/全形空格、trim、大小寫折疊、proxyName 超長截斷）與邊界（`+0`/`-0` 靜默、`+21`/超上限 invalid、非數字/畸形、代報名名字擷取與截斷）。
- 畸形輸入的 `unknown` / `invalid` 兩層歸類與原因碼。
- 一行式開團的欄位順序、容錯（`16人`/`16`、`2200元`/`2200`、`YYYY/MM/DD`↔`YYYY-MM-DD`、`H:MM`→`HH:MM`）與正規化輸出（對接 D-001 欄位）。
- 模組檔案劃分與 webhook 呼叫關係。

### 範圍外（留給 D-003 / M2 / M3）

- 額滿判斷、整批轉候補、FIFO 遞補（定案 #1/#2）。
- 名單訊息**內容組版**（`名字`、`名字(2)`、剩餘名額、每人價格、預估總金額）。
- DB 寫入/查詢、transaction、去重（NFR-1/2）。
- **授權/權限檢查**（主辦人限定指令的判斷；host 白名單走環境變數，屬 D-003）。
- 開團**逐步問答 state machine**（`conversation_states` 流程節點、`確認`/`取消` 對流程的實際作用）。
- `+N 名字` 於 N>1 的允許與否、代報名同名 `(2)` 生成規則。
- 日期完整合法性（每月天數/閏年）、過去日期拒絕等業務校驗（D-003 視需要）。

---

## 二、Guardrails（Must NOT，reviewer 可逐條客觀判定）

- **G1（禁 any）**：`src/commands/` 不得出現 `any`；`ParsedCommand` 為具名 discriminated union，每種指令 payload 具體定型。（reviewer 可 grep `any` + 型別檢查。）
- **G2（純函式）**：`parseCommand` 不得有副作用——不得存取 DB、network、檔案系統、`process.env`、時鐘（`Date.now()`）、亂數或任何模組外可變狀態；相同輸入必得相同輸出。（可靜態審查 import 與呼叫。）
- **G3（不可識別必 silent）**：無法辨識為任何指令、或視為 no-op 的輸入（閒聊、`+`/`-` 後非數字、`+0`/`-0`、空白等）**必須回 `unknown`**，不得回傳任何會觸發 webhook 回覆的型別（FR-5、成功條件 #5）。
- **G4（N 邊界保護，不對稱）**：不得回傳 `count < 1` 或 `count > MAX_COUNT` 的 `signup`/`cancel`；其中 `count < 1`（`+0`/`-0`）歸 `unknown`（靜默）、`count > MAX_COUNT`（`+21`/`+99`/超大數字）歸 `invalid(count_out_of_range)`。（M1 明列 `+0`/`+99` 保護，O-1/O-3 裁決。）
- **G5（不越界）**：不得在解析層做授權判斷（host 與否）、額滿/候補決策、DB 存取、名單組版、遞補或 state machine 流程；一律留給 D-003（越界即違反）。
- **G6（正規化不逾越）**：不得對整串做無差別 `NFKC`/全形標點正規化；正規化**僅限** §5 對照表的白名單字元類（數字、`+`、`-`、`:`、全形空格）與 proxyName 截斷，不得改動 location/proxyName 內**非白名單字元**（中文、英文字母等）的語意。
- **G7（型別窮舉）**：不得回傳未定義於 `ParsedCommand` union 的 `type`；消費端 `switch` 須 exhaustive（含 `never` 檢查），新增指令型別時編譯期報錯。
- **G8（永不拋例外）**：`parseCommand` 對任意輸入（含空字串、超長字串、亂碼、非字串）**不得拋例外**；一律回傳合法 `ParsedCommand`（最壞為 `unknown`）。

> **errata（2026-08-23，D-015／T-026）：G3 的射程界定。** G3 約束的是「**無法辨識**為任何指令」的輸入必須靜默；`編輯 …`（含缺值／未知欄位名）屬**可辨識**的指令嘗試，回 `edit_help`／`invalid` 並由上層回覆，**不違反 G3**。G1／G2／G6／G7／G8 對 `編輯` 分支一律照舊成立（純函式、禁 any、只做白名單正規化、窮舉、不拋例外）。

---

## 三、Acceptance Checks（每條可轉單元測試）

格式：條件 → 預期結果 →（驗證方式）。

- [ ] **AC-1**：輸入 `＋１`（全形加號+全形數字）→ `{ type:'signup', count:1 }`（無 proxyName）。（驗證：unit test / M1 全形保護）
- [ ] **AC-2**：輸入 `+3` → `{ type:'signup', count:3 }`。（驗證：unit test / 成功條件 #1）
- [ ] **AC-3**：輸入 `+0` → `{ type:'unknown' }`；輸入 `-0` → `{ type:'unknown' }`（靜默 no-op，不回覆，O-3 裁決）。（驗證：unit test / G3、G4）
- [ ] **AC-4**：輸入 `+99` → `{ type:'invalid', command:'signup', reason:'count_out_of_range' }`；邊界 `+20`（=MAX_COUNT）→ `{ type:'signup', count:20 }`；`+21` → `invalid(signup, count_out_of_range)`。（驗證：unit test / M1 上限保護、O-1、G4）
- [ ] **AC-5**：輸入 `+1 陳大哥` → `{ type:'signup', count:1, proxyName:'陳大哥' }`。（驗證：unit test / 定案 #4）
- [ ] **AC-6**：輸入 `-2` → `{ type:'cancel', count:2 }`；輸入 `-1 陳大哥` → `{ type:'cancel', count:1, proxyName:'陳大哥' }`。（驗證：unit test / FR-1、定案 #4）
- [ ] **AC-7**：輸入 `名單`、`list`、`LIST` 三者皆 → `{ type:'list' }`。（驗證：unit test / FR-2）
- [ ] **AC-8**：輸入 `開團 2026/08/15 07:30 東方球場 16人 2200元` → `{ type:'create_event_oneline', date:'2026-08-15', time:'07:30', location:'東方球場', capacity:16, price:2200 }`（日期斜線正規化為破折號、`16人`去尾綴、`2200元`去尾綴）。（驗證：unit test / FR-3、旅程 #1、對接 D-001 §2 欄位）
- [ ] **AC-9**：容錯——`開團 2026-08-15 7:30 東方球場 16 2200` → 同 AC-8 結果（破折號日期、單位數時 `7:30`→`07:30`、無 `人`/`元` 尾綴）。（驗證：unit test / FR-3 容錯）
- [ ] **AC-10**：輸入 `開團`（無參數）→ `{ type:'create_event_start' }`；`新活動` 亦同。（驗證：unit test / FR-3）
- [ ] **AC-11**：輸入閒聊 `今天天氣真好` → `{ type:'unknown' }`。（驗證：unit test / FR-5、成功條件 #5）
- [ ] **AC-12**：輸入 `+abc`、`+`、`+ 1`（sign 未緊接數字）→ 皆 `{ type:'unknown' }`（不觸發回覆）。（驗證：unit test / G3、§四 O-2）
- [ ] **AC-13**：輸入 `開團 缺欄位`（token 數≠5）→ `{ type:'invalid', command:'create_event', reason:'create_wrong_arity' }`；`開團 2026/13/40 07:30 場 16 2200`（日期範圍錯）→ `invalid(create_event, create_bad_date)`。（驗證：unit test / FR-3、§四 O-2）
- [ ] **AC-14**：輸入 `確認`→`{type:'confirm'}`；`取消`→`{type:'abort'}`；`關閉報名`→`{type:'close_event'}`；`取消活動`→`{type:'cancel_event'}`；`我的ID` 與 `我的id`→`{type:'my_id'}`。（驗證：unit test / 指令規格總表）
- [ ] **AC-15**：前後空白與全形空格——`  +1  `、`＋１　`（含全形空格 U+3000）→ 皆 `{ type:'signup', count:1 }`。（驗證：unit test / §5 正規化）
- [ ] **AC-16**：全形數字/冒號的一行式——`開團 ２０２６/０８/１５ ０７：３０ 東方球場 １６人 ２２００元` → 同 AC-8 結果。（驗證：unit test / §5、M1 全形保護）
- [ ] **AC-17**：純函式性——對同一輸入呼叫兩次 `parseCommand`，回傳結果 deep-equal；對任意亂數/超長/空字串輸入皆**不拋例外**。（驗證：unit test / G2、G8）
- [ ] **AC-18**：代報名名字超長截斷——輸入 `+1 一二三四五六七八九十一二三四五六七八九十一`（數字後為 21 個中文字）→ `{ type:'signup', count:1, proxyName:'一二三四五六七八九十一二三四五六七八九十' }`（截斷為前 20 個 code unit，非 invalid，O-4 裁決）。（驗證：unit test / §3.1 step 4、§5）
- [ ] **AC-19**：`+1` 後僅尾隨空白（`+1   `）→ `{ type:'signup', count:1 }`（proxyName 不存在，非空字串）。（驗證：unit test / §3.1）
- [ ] **AC-20**：空字串 `''` 與純空白 `'   '` → 皆 `{ type:'unknown' }`。（驗證：unit test / §2 步驟 4、G3）
- [ ] **AC-21**：一行式時間格式/範圍錯——`開團 2026/08/15 25:99 東方球場 16 2200` → `{ type:'invalid', command:'create_event', reason:'create_bad_time' }`。（驗證：unit test / §4 time、InvalidReason `create_bad_time`）
- [ ] **AC-22**：一行式人數非正整數——`開團 2026/08/15 07:30 東方球場 0人 2200`（`0` 不符 `capacity>=1`）與 `開團 2026/08/15 07:30 東方球場 abc人 2200`（非數字）→ 皆 `{ type:'invalid', command:'create_event', reason:'create_bad_capacity' }`。（驗證：unit test / §4 capacity、InvalidReason `create_bad_capacity`）
- [ ] **AC-23**：一行式價格非非負整數——`開團 2026/08/15 07:30 東方球場 16 -100`（負數不符 `price>=0`）與 `開團 2026/08/15 07:30 東方球場 16 abc元`（非數字）→ 皆 `{ type:'invalid', command:'create_event', reason:'create_bad_price' }`。（驗證：unit test / §4 price、InvalidReason `create_bad_price`）
- [ ] **AC-24**：一行式多欄同錯回**第一個** reason——`開團 2026/13/40 25:99 東方球場 16 2200`（日期與時間同錯）→ `{ type:'invalid', command:'create_event', reason:'create_bad_date' }`（依 date→time→capacity→price 檢查順序回 date）。（驗證：unit test / §4 檢查順序）
- [ ] **AC-25**：一行式 location 含空白導致 arity 錯（O-5）——`開團 2026/08/15 07:30 東方 球場 16 2200`（location 被空白拆成 2 token → 共 6 個非首 token）→ `{ type:'invalid', command:'create_event', reason:'create_wrong_arity' }`。（驗證：unit test / §4 arity、§四 O-5）
- [ ] **AC-26**：`+N` 數字後緊接非空白字元（寬鬆 proxyName 規則，O-6）——`+1abc` → `{ type:'signup', count:1, proxyName:'abc' }`；`+1.5` → `{ type:'signup', count:1, proxyName:'.5' }`（數字後剩餘字串經 trim/截斷即 proxyName，不要求空白分隔）。（驗證：unit test / §3.1 step 4、§四 O-6）

> **errata（2026-08-23，D-015／T-026）：`編輯` 家族的解析 AC 不在本文件列舉，一律以 D-015 AC-9 為準**（`編輯`／未知欄位／缺值 → `edit_help`；`編輯 日期 2026-13-99` → `invalid(create_bad_date)`；`編輯 場地 東方 A 場` 與別名 `編輯 地點 …` → `value='東方 A 場'` 保留空格；`編輯 費用 場地費 4000` → `value='場地費4000'` compact；全形輸入正常解析）。本文件 AC-1~26 編號與內容一律不動（`check_ac_coverage` 依賴其編號）。

---

## 四、開放問題與裁決（2026-07-23 已裁決，留痕）

- **O-1（MAX_COUNT 值）→ 裁決：`MAX_COUNT = 20`（維持）**。理由：單場球聚容量約 16–24（brief 例 `16人`），單次 `+N` 超過 20 幾乎必為誤植/濫用；且需 < 99 以滿足 M1「`+99` 上限保護」。`count > 20` → `invalid(count_out_of_range)`。
- **O-2（畸形歸類：`invalid` vs `unknown`）→ 裁決：採納草稿分類（維持）**。`開團` 關鍵字命中但欄位錯 → `invalid`（帶 reason）；`+`/`-` 後非數字 → `unknown`（silent）。「invalid 是否真的回提示」屬 D-003 回覆政策；本文件維持「只分類、不決定回覆」。
- **O-3（`+0`/`-0` 行為）→ 裁決：改歸 `unknown`（靜默 no-op）**。webhook 不回覆；`count < 1` 一律 `unknown`。與 `count > MAX_COUNT` 的 `invalid` 形成不對稱（見 §0 邊界表）。理由：0 多為誤植/玩笑，靜默避免洗版；>20 為明確超限嘗試，值得標記。
- **O-4（代報名名字上限）→ 裁決：上限 20 字、超長截斷取前 20 個字元**（不再回 invalid）。長度以 JS string length（UTF-16 code unit）計。已從 `InvalidReason` 移除 `'proxy_name_too_long'`。
- **O-5（一行式開團 location 含空白）→ 裁決：location 限單一 token（不含空白，維持）**；含空白地名走逐步問答。理由：位置式解析下 location 是第 3 欄，含空白會使 token 數 ≠ 5 而歸 `create_wrong_arity`（AC-25）。
- **O-6（`+N` 名字是否要求空白分隔）→ 維持寬鬆規則（errata 2026-07-23，architect-reviewer nit-3）**：數字後剩餘字串（不論是否以空白分隔）經 trim/折疊/截斷後即 proxyName。故 `+1abc`→proxyName `abc`、`+1.5`→proxyName `.5`。以 AC-26 鎖定此語意。取捨：規則簡單（「數字 + 剩餘即名字」）、對 `+1陳大哥`（無空白）這類自然輸入友善；代價是 `+1.5`/`+1abc` 會被當成代報名而非畸形，但 proxyName 內容的業務校驗可由 D-003 再做（非 D-002 職責）。

> 上述裁決後，本文件無新增開放問題。
> **errata（2026-08-23，D-015／T-026）：O-5 的「location 限單一 token」只約束一行式開團**；`編輯 場地 <名稱>` 因採「首兩 token 之後全部剩餘」取值，**允許含空格的場地名**（不走位置式解析，無 arity 概念）。兩者規則不同是刻意的，勿相互套用。

---

## 五、D-020 預告 errata（2026-08-31，來源 `design/D-020-multi-event-per-group.md`；**DRAFT，尚未核可/未實作**，本節僅供追溯，不代表 parser 現行行為已改變）

> D-020（同群多場並行活動 + 訊息消歧義）若通過雙審與使用者核可，將對本文件產生以下影響
> （**目前尚未發生**，`parseCommand` 本身不變）：
> - 新增獨立檔案 `src/commands/selector.ts`，匯出 `splitSelector(text): { selectorRaw, rest }`
>   ——與 `parseCommand` **同層、前置**於它的獨立純函式（先切 `@selector` 前綴，再把 `rest` 交給
>   `parseCommand`），**不修改 `parseCommand` 本身、不新增 `ParsedCommand` 成員**。
> - §5 白名單正規化對照表新增一項：全形 `＠`(U+FF20) → 半形 `@`，與既有 `＋`/`－`/`：` 同一風格
>   併入 `normalizeWhitelist`，非新開一條規則、不擴大 NFKC 範圍（不違反 G6）。
> - `splitSelector` 的停止 token 關鍵字集合須與本文件 §3 dispatch 表的指令頭關鍵字保持同步
>   （D-020 G-selector-sync）；日後在本文件新增任何指令首字關鍵字時，須同步檢查
>   `src/commands/selector.ts` 是否也要更新。
>
> 權威來源：`design/D-020-multi-event-per-group.md` §4.2。

---

## 討論紀錄（Orchestrator 維護）

| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-07-23 | O-1 MAX_COUNT | 20 |
| 2026-07-23 | O-2 畸形歸類 | 採納：開團欄位錯→invalid、+/-後非數字→unknown；回覆政策留 D-003 |
| 2026-07-23 | O-3 +0/-0 | 改歸 unknown（靜默）；count>20 仍為 invalid |
| 2026-07-23 | O-4 代報名名字超長 | 上限 20 字、超長截斷（取前 20 字元），移除 proxy_name_too_long |
| 2026-07-23 | O-5 location 含空白 | 限單一 token，含空白走逐步問答 |
| 2026-07-23 | architect-reviewer errata | nit-1 正規化措辭精確化（白名單字元對全串生效、含 location/proxyName）；nit-2 補 AC-21~25 覆蓋 time/capacity/price/多欄順序/arity；nit-3 維持寬鬆 proxyName 規則並加 AC-26（記為 O-6）；nit-5 §3 表註淡化為「完全相等比對，順序不影響」 |
| 2026-07-23 | 最終核可 | 使用者 APPROVED，解鎖 T-005 實作 |
| 2026-08-23 | D-015／T-026 errata（架構 reviewer 要求補登） | 新增 `編輯` 家族：`edit_event`／`edit_help`、`InvalidCommandKind` 增 `'edit_event'`、`InvalidReason` 增 `'bad_location'`、`invalid` 增 `detail?:{len}`；首 token `編輯` 一律回覆不落 `unknown`（G3 射程界定）；fee compact／location 保留空格；解析 AC 以 D-015 AC-9 為準，本文件 AC 編號不動 |
| 2026-08-31 | D-020 預告 errata（architect 執行，使用者已核可採納） | 新增 `src/commands/selector.ts`／`splitSelector`（前置於 `parseCommand` 的獨立純函式）、白名單新增 `＠→@`；`parseCommand` 本身不變。**D-020 仍 DRAFT，本次僅預先登記，未生效** |
