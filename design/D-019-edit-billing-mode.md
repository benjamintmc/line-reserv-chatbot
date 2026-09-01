# D-019: 編輯費用支援切換計費模式（per_person ↔ split_venue）

- 狀態：**APPROVED（2026-09-01，使用者核可）**——R2 雙審 PASS，無 blocker；4 nit 已回填。解鎖 T-032
- 撰寫者：architect
- 關聯：任務 T-032／errata D-015（`design/D-015-edit-event.md`，APPROVED、已上線 T-026）／相依 D-005 §2、§6（`billing.ts`、`validateFee`）
- 風險等級：**R2（高）**——動 `src/domain/event-service.ts`（CLAUDE.md §4.5 預設高風險模組），涉及計費三欄一致性與金額正確性。依 §5：雙 reviewer + e2e，Guardrails ≥3（本文件 6 條）。
- 定位：本設計**反轉** D-015 決議⑥（原：`編輯 費用` 不得切換計費模式）。使用者主動要求開放切換，這是刻意的規格變更，非糾正錯誤；D-015 需回填 errata（見「四、將改動的既有文件」）。

## 一、設計內容

### 1. 指令語法（沿用既有，parser 層不改）
`編輯 費用 <值>` 判模式規則改為與開團一行式／D-005 §6.1 同一套：`validateFee(value)` 依前綴判 `split_venue`（`場地費N`/`均攤N`）或 `per_person`（`每人N`/裸 `N`）。**`parse.ts`（238-294 行）不需改動**：fee 分支已把 compact 後字串（`tokens.slice(2).join('').replace(/\s+/g,'')`）原樣下傳，`validateFee` 內部自身也會 compact——與 D-015 F2 完全相容，不重複判斷、無需新增分支。

### 2. 前置條件（不變，沿用 D-015 §2 步驟 1-4）
`open` 且未過期、鎖內 `getById` 重讀、`canManageEvent` 授權。**不新增**「僅主辦一人時才能切換」等額外限制（使用者已裁決）：已有人報名後仍可切換。

### 3. domain：`event-service.ts` `case 'fee'`（728-747 行）重寫
```
const r = validateFee(req.value);
if (!r.ok) return { kind: 'bad_fee' };   // 純格式錯，不再依 fresh.price_mode 判定
const { mode, amount } = r.value;
const pricePerPerson = mode === 'split_venue' ? 0 : amount;
const venueFee = mode === 'split_venue' ? amount : null;
await repos.events.updateBilling(fresh.id, { priceMode: mode, pricePerPerson, venueFee });
const switched = mode !== fresh.price_mode;
const oldAmount = fresh.price_mode === 'split_venue' ? fresh.venue_fee ?? 0 : fresh.price_per_person;
before = switched ? feeLabel(fresh.price_mode, oldAmount) : String(oldAmount);
after  = switched ? feeLabel(mode, amount) : String(amount);
if (mode === 'split_venue') {
  perPerson = perPersonAmount({ ...fresh, price_mode: mode, venue_fee: amount }, confirmedCount); // N6：改後值算
}
feeModeSwitched = switched;
```
`feeLabel(mode, amount)`（formatter 內部 helper）：per_person → `每人費用 {amount} 元`（與 D-015 原句「已更新每人費用：…」、D-005 `feeLine` 標籤「每人費用：2200 元」用詞一致）；split_venue → `場地費 {amount} 元`。**未切換時 before/after 維持 D-015 原樣裸數字**（回歸零風險）；**切換時改用帶標籤全稱**，左右標籤對稱（如「每人費用 2200 元 → 場地費 4000 元」），避免「2200 → 4000」讓人誤讀為同模式改價。`confirmedCount` 沿用 §2 步驟 5 既有共用計算，不重複查詢。

### 4. repo：新原語 `EventRepository.updateBilling`
```
async updateBilling(id, { priceMode, pricePerPerson, venueFee }:
  { priceMode: PriceMode; pricePerPerson: number; venueFee: number | null }): Promise<number>
// 單一 UPDATE：SET price_mode=$1, price_per_person=$2, venue_fee=$3, updated_at=$4 WHERE id=$5
```
單次呼叫同時定三欄，**不論是否切換模式皆用此原語**（同模式改價＝三欄中兩欄值不變、一欄變，仍走同一 UPDATE，呼叫端不必分支）。維持 D-005 §1.3 不變式：split → `price_per_person=0`∧`venue_fee>0`；per_person → `venue_fee=NULL`。舊有 `updatePricePerPerson`/`updateVenueFee` 兩單欄原語**不再被 fee 路徑呼叫**；是否移除交 backend-engineer 於實作時 grep 確認無其他呼叫點後裁定（本設計不強制刪除，避免不必要 blast radius）。`capacity`/`status`/`settled_per_person`/其餘欄位仍不得寫入（沿用 D-015 G2 精神，僅費用可寫欄位封閉集擴大為三欄）。

### 5. formatter 改動
- `editSuccessLine` `case 'fee'`：`feeModeSwitched` 為真 → `已更新計費方式：{before} → {after}`，若新模式為 `split_venue` 追加 `（目前正取 {K} 人，平均每人約 {perPerson} 元；暫估，關閉報名後結算）`；為假 → 沿用 D-015 原兩句型（每人費用／場地費均攤），零回歸。
- `formatEditBadFee()`：**移除 `priceMode` 參數**（語意已變——`bad_fee` 現只代表輸入格式本身不合法，如 `abc`，與目前 `price_mode` 無關）。新文案：`費用格式不正確。每人固定請輸入金額（例：編輯 費用 2500）；場地費均攤請輸入「場地費」+總額（例：編輯 費用 場地費4000）。`（**呼應 D-005 §6.2 逐步問答的措辭精神，非逐字同款**——列點式 vs「請輸入」問答句、「請重新輸入。」有無皆不同，屬命令式/問答式情境差異的合理分歧，不要求兩處字串逐字同步；日後改動其一不需連動改另一處）。**呼叫端提醒**：domain 內 `case 'fee'` 分派處與任何組訊息呼叫點都必須同步移除傳給 `formatEditBadFee` 的 `priceMode` 引數；TS 型別收緊雖會讓編譯器擋下遺漏，仍請 backend-engineer 明確 grep 核對所有呼叫點，降低審查來回。
- `formatEditHelp` 的 `{費用範例}`（依 `event.price_mode` 動態產生）**不變**——help 範例仍示範「當前模式怎麼改金額」，切換為進階用法，不必列入 help 範例。

### 6. 型別改動
- `EditEventResult`：`{kind:'bad_fee'; priceMode}` → `{kind:'bad_fee'}`（丟棄不再有語意的欄位）。
- `EditOk`（`kind:'ok'`）新增可選欄位 `feeModeSwitched?: boolean`；`before`/`after` 語意依 §3 分歧（未切換＝裸數字、切換＝帶標籤全稱），型別仍為 `string`，不新增分支。

## 二、Guardrails
- **G1（決策輸入必於鎖內取得）**：改前 `price_mode`/`price_per_person`/`venue_fee` 一律取自鎖內 `fresh`（`runImmediate` 內 `getById` 重讀），不得以交易外快照判定是否切換或算改前值。
- **G2（三欄原子寫入、維持 D-005 不變式）**：`price_mode`/`price_per_person`/`venue_fee` 必須透過單一 `updateBilling` 呼叫同時寫入；不得先後兩次 UPDATE 拼湊，不得產生「切了模式但舊金額殘留」的中間態；split 恆 `price_per_person=0`∧`venue_fee>0`，per_person 恆 `venue_fee=NULL`。
- **G3（複用 validateFee，不得另寫驗證）**：fee 值解析與模式判定一律呼叫 `commands/validators.ts` 的 `validateFee`；不得為本設計新增 regex 或另訂前綴判斷邏輯，不得複製既有 `validateVenueFee`/`validatePrice` 的判模式片段。
- **G4（bad_fee 與現有模式解耦）**：`bad_fee` 判定不得讀取 `fresh.price_mode`；純粹由 `validateFee` 回傳 `ok:false` 決定，訊息一律用 §5 新文案，不得依目前模式輸出不同句子。
- **G5（其餘欄位不受影響）**：本次編輯**只能**改 `price_mode`/`price_per_person`/`venue_fee` 三欄；不得寫入 `capacity`/`status`/`settled_per_person`/`group_id`/`host_user_id`/`event_datetime`/`location`。
- **G6（通知行為零例外）**：mention 邏輯（對象、去重、overflow 退化、reply-only）完全複用既有機制，不得因切換模式新增/移除任何分支；不得改用 push/multicast。

## 三、Acceptance Checks
- [ ] **AC-1（per_person→split_venue 切換成功）**：per_person 事件 `編輯 費用 場地費4000` → `price_mode='split_venue'`、`price_per_person=0`、`venue_fee=4000`；回覆含 `已更新計費方式：每人費用 {舊} 元 → 場地費 4000 元（目前正取 K 人，平均每人約 M 元；暫估，關閉報名後結算）`；整列 diff 除三欄與 `updated_at` 外逐欄相等。（`npm test`）
- [ ] **AC-2（split_venue→per_person 切換成功）**：split 事件 `編輯 費用 2500` → `price_mode='per_person'`、`price_per_person=2500`、`venue_fee=NULL`；回覆 `已更新計費方式：場地費 {舊} 元 → 每人費用 2500 元`（不附攤額子句）；整列 diff 同上。（`npm test`）
- [ ] **AC-3（同模式只改金額，零回歸）**：per_person `編輯 費用 3000` 與 split `編輯 費用 場地費5000` 各自沿用 D-015 原句型（`已更新每人費用：… 元 → 3000 元`／`已更新場地費：… 元 → 5000 元（目前正取…）`），`feeModeSwitched` 為假，其餘欄位不變。（`npm test`）
- [ ] **AC-4（真 bad_fee，純格式不合法）**：`編輯 費用 abc` 在 per_person 與 split 兩模式下**皆**回同一新通用文案、`events` 無 UPDATE、`message.id` 已消費——證明文案不再依模式分岔。（`npm test`）
- [ ] **AC-5（mention 行為不變）**：切換模式成功後，@ 對象、去重、overflow 退化規則與 D-015 AC-12/AC-13 同一套斷言全數通過；不新增 profile API 呼叫（沿用 D-015 AC-14 spy）。（`npm test`）
- [ ] **AC-6（其餘欄位／併發不受影響）**：`capacity`/`status`/`settled_per_person`/`event_datetime`/`location`/`host_user_id`/`group_id` 切換前後逐欄相等；`registrations` 列數與內容不變；兩則並行編輯（一則切模式、一則改日期）序列化後皆生效、互不覆蓋（沿用 D-015 AC-1 併發設施）。（`npm test`）
- [ ] **AC-7（G2 原子寫入名實相符，非巧合通過）**：AC-6 的並行序列化只證明結果正確，無法區分「一次 UPDATE」與「拆兩次 UPDATE 剛好都成功」——本條專門補證：spy/mock `repos.events.updateBilling`，斷言單次 `編輯 費用`（含切換與不切換）呼叫此方法**恰好一次**、且未呼叫 `updatePricePerPerson`/`updateVenueFee`；另由 reviewer 於審查時 grep `updateBilling` 方法本體，核對其內僅有**一條** `UPDATE` 陳述句（非兩條分開執行）。（`npm test` + 人工 grep 核對，記於審查包）
- [ ] **AC-8（機器關卡全綠）**：`npm run lint`／`npm run build`／`npm test`／`npm run harness:check` 四關全綠，輸出貼於審查包。（四道指令）

## 四、將改動的既有文件（預列，由 orchestrator 轉派）
- **`docs/02-api-contract.md`**：`編輯 費用` 指令說明需新增「可切換計費模式」與新 `bad_fee` 文案；交 api-contract-designer。
- **`design/D-015-edit-event.md`（errata，orchestrator 執行，本文件只列清單）**：
  1. §一 決議⑥「不支援切換計費模式」→ 改為指向本文件（D-019）反轉。
  2. **G2**「不得寫 `price_mode`」→ 改為「費用欄位封閉集擴大為 `price_mode`/`price_per_person`/`venue_fee` 三欄（原子寫入，見 D-019 G2）」。
  3. **G6**「費用路徑不得呼叫 `validateFee`」→ 該限制**廢止**，改為 D-019 G3「必須呼叫 `validateFee`」。
  4. **AC-6**：「per_person 收到 `場地費4000` 應回 `bad_fee`」的斷言已失效，改為「應成功切換為 split_venue」，指向 D-019 AC-1。
  5. `event-formatter.formatEditBadFee` 文案「本活動的計費方式無法變更」→ 依 D-019 §5 新文案取代；`EditEventResult.bad_fee` 型別的 `priceMode` 欄位移除，**所有呼叫 `formatEditBadFee(priceMode)` 的地方需同步移除該引數**（見 D-019 §一.5 呼叫端提醒）。
  6. 討論紀錄新增一列指向本文件（D-019，使用者主動要求反轉決議⑥）。

## 討論紀錄
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-08-31 | 是否開放 `編輯 費用` 切換計費模式（反轉 D-015 決議⑥） | **開放**。語法沿用 `validateFee`（同開團一行式）；任何時候皆可切換（含已有人報名後），僅需 `open` 且未過期；通知行為維持現狀（同一則 reply @ 正取者，不新增例外）。 |
| 2026-08-31 | R2 雙審 4 nit（design-reviewer 2、architect-reviewer 2） | 全數採納：①`feeLabel` per_person 標籤改「每人費用 {amount} 元」（AC-1/AC-2 同步）②bad_fee 措辭改註記「呼應精神、非逐字同款」③補呼叫端需同步移除 `formatEditBadFee` 傳參提醒④新增 AC-7 以 spy 呼叫次數 + grep 單一 UPDATE 陳述句佐證 G2 非巧合通過。 |
