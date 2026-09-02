# D-024: `@selector` 前綴切分 `selector.ts` 與顯示截斷

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §4.2 與 §4.3「顯示截斷」**逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——`src/commands/` 為指令解析入口，改動影響所有既有指令的分派路徑（AC-6 為零回歸守門）；隨 T-033a 一併以 R2 審查。
- 來源：D-020 §4.2、§4.3（顯示截斷段）；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。同屬 T-033a 的並行文件：D-021、D-022、D-023、D-026。

## errata（2026-09-02，來源 T-033a R2 雙審 design-reviewer N-1；**釘死字串消歧義，本節生效**）

> **AC-9 的釘死字串在文件中被換行切開**（「…`@不存在的場地 +1` → 回「找不到符合 不存在的場地⏎
> 　的球敘，請確認後再試」」），導致 `{xxx}` 之後究竟有無空格**無法從文件判讀**。
>
> **釘死判定**：`{xxx}` **前後皆有一個半形空格**，即 `找不到符合 {xxx} 的球敘，請確認後再試`
> ——與 AC-10 的 `有超過一場 {xxx} 的球敘，請修正再試` 同構。實作
> （`src/domain/disambiguation-formatter.ts`）已依此，經 design-reviewer codepoint 級比對 MATCH。
>
> **後續讀者請勿**依文件換行處把該空格「修正」掉；如需改動須另走變更流程。
>
> **本節由 orchestrator 落筆，尚未經 architect 確認。**

## 一、設計內容

#### 4.2 機制 B：`@selector` 前綴（`src/commands/selector.ts`，擴充 D-002）

**語法切分為純函式**，與 `parseCommand` 同層、同風格（G5/G6：只動白名單字元、不做 NFKC、
不觸 DB、不判斷候選活動）：

```ts
export interface SelectorSplit {
  /** 選擇器原文（trim；跨多 token 以原始間距切出，非重新 join）。undefined = 無 @ 前綴。 */
  selectorRaw: string | undefined;
  /** 供 parseCommand 使用的剩餘文字，**保留原始換行**（供 D-012 多行批次沿用既有拆行）。 */
  rest: string;
}
export function splitSelector(text: string): SelectorSplit;
```

演算法：

1. 先跑 D-002 §5 白名單正規化（`normalizeWhitelist`，**新增一項**：全形 `＠`(U+FF20) → 半形 `@`，
   與既有 `＋`/`－`/`：` 同一風格併入同一張表，非新開一條規則）。
2. 用 `\S+` 逐一取出 token 與其**字元位移**（换行也視為分隔，允許「選擇器獨佔第一行、指令在第二行」
   的批次寫法，例：`@旭陽\n+1\n-1 陳先生`）。
3. 第一個 token 不以 `@` 開頭 → `{ selectorRaw: undefined, rest: text }`（原樣不動）。
4. 否則，去掉 `@` 後若該 token 只剩空字串（即 `@` 後緊接空白或到此為止）→ 視為無效前綴，
   同上原樣不動（不硬吃掉這個 `@`，讓它按舊行為落入 `unknown`）。
5. 否則從該 token（去 `@` 後）開始累積為候選 selector 文字，逐一檢查後續 token，直到命中
   **停止 token**（累積中止，該 token 起算為 `rest`）：
   - 符合 `^[+-]\d` （`+N`/`-N` 起手）；或
   - 精確等於（大小寫規則與 D-002 §3 dispatch 表一致）下列**指令頭關鍵字**之一：
     `名單`、`list`（case-fold）、`確認`、`取消活動`、`取消`、`關閉報名`、`下一輪`、`我的id`
     （case-fold）、`開團`、`新活動`、`分組`、`加開`、`編輯`。
   - 若掃到文字結尾仍未命中停止 token（selector 佔滿剩餘全部文字、無指令可解）→ selector 為
     掃到的全部內容，`rest` 為空字串（多行批次時，代表第一行整行是 selector，指令在下一行；
     單行時代表這則訊息只有 selector 沒有指令 → 之後 `parseCommand('')` 得 `unknown`，無害）。
6. `selectorRaw` = 步驟 5 累積片段（依原文字元切出，trim 首尾）；`rest` = 原文自停止 token
   起始位置之後的子字串（**字元切片，不重組**，保留原始空白/換行給 D-012 拆行用）。

**停止關鍵字集合須與 `parse.ts` 的分派關鍵字保持同步**：新增任何指令首字關鍵字（例如日後的
`XX`）時**必須**同步加入本清單，否則該關鍵字會被誤吞進 selector 文字（G-selector-sync，見
Guardrails；**必須**新增測試斷言，見 AC-29）。

**判斷時機**：`splitSelector` 只在 `dispatchSingle`／`handleBatch` 前呼叫一次（在 D-004 §3.3 的
conversation 攔截**之後**——開團問答/分組 session 的答案不吃 `@selector` 語法，避免使用者填日期
欄位時剛好帶 `@` 被誤判）。

**顯示截斷（NIT-2 修復，2026-09-01）**：`not_found`/`too_many` 訊息中的 `{xxx}` 為 `selectorRaw`
原文回顯；若使用者輸入超長文字（例如整段貼上一大串文字後接 `@`），逐字回顯會造成訊息過長、體驗
不佳。**僅在 formatter 層**截斷（不改 `TargetResolution` 型別本身，`selectorRaw` 欄位仍存原始
未截斷值，供測試/除錯用）：新增純函式 `truncateForDisplay(s: string, max = 20): string`（比照既有
`MAX_PROXY_NAME_LEN=20`／`MAX_LOCATION_LEN=40` 量級，取較嚴格的 20），超過 `max` 字元 → 取前
`max` 字元 + `…`。`formatNotFound(selectorRaw)`／`formatTooMany(selectorRaw)` 呼叫前先過此函式
（AC-30）。

## 二、Guardrails（Must NOT）

- **G5（selector 切分不逾越正規化風格）**：`splitSelector` 的正規化僅限沿用/擴充 D-002 §5
  白名單字元類（本次新增 `＠→@` 一項），不得對整串做無差別 `NFKC`／全形標點轉換。
- **G6（selector 切分為純函式、不越界）**：`splitSelector` 不得存取 DB、不得判斷候選活動集合、
  不得決定要不要回覆錯誤訊息——語意解析（是否命中哪一場）一律留給 `resolveTargetEvent`/
  `matchSelector`（domain 層），此為 D-002 G5「不越界」原則的延伸適用。**`resolveTargetEvent`／
  `matchSelector` 同樣不得接受 `groupId` 參數或查 DB**——跨群校驗是 dispatch 層的職責（G14），
  不得為了 B1 修復而讓這兩個函式失去純函式特性。
- **G-selector-sync（關鍵字同步）**：`splitSelector` 的停止 token 關鍵字集合（§4.2 步驟 5）與
  `src/commands/parse.ts` 的指令頭關鍵字**必須保持一致**；新增任何指令首字關鍵字時，兩處須同步
  更新，不得只改一處；**必須**新增至少一條測試斷言驗證 `splitSelector` 停止詞集合是 `parse.ts`
  指令頭關鍵字集合的超集（即後者 ⊆ 前者），兩者不同步時該測試須失敗——此為強制要求，非建議事項
  （對應 AC-29）。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-024 AC-9] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-9]` 會對不上）。

- [ ] **[D-020 AC-9]（`@selector` 命中 0 場）**：`@不存在的場地 +1` → 回「找不到符合 不存在的場地
  的球敘，請確認後再試」（`{xxx}` 為原文）。
- [ ] **[D-020 AC-10]（`@selector` 命中 >1 場）**：3 場 open 皆含「球場」子字串，`@球場 +1` → 回
  「有超過一場 球場 的球敘，請修正再試」。
- [ ] **[D-020 AC-24]（純函式性）**：`splitSelector`／`resolveTargetEvent`／`matchSelector` 對同一
  輸入呼叫兩次結果 deep-equal；三者皆不拋例外、不觸 DB（可靜態審查 import）。
- [ ] **[D-020 AC-29]（selector 停止詞與指令關鍵字同步，NIT-1）**：存在至少一條測試斷言
  `src/commands/parse.ts` 的全部指令頭關鍵字皆為 `splitSelector` 停止詞集合的子集；刻意在測試中
  新增一個不在停止詞集合內的假關鍵字時，該斷言必須失敗（證明測試確實有偵測力，非恆真斷言）。
- [ ] **[D-020 AC-30]（selectorRaw 超長回顯截斷，NIT-2）**：`selectorRaw` 長度 25 字元時，
  `not_found`/`too_many` 訊息中的 `{xxx}` 顯示為前 20 字元 + `…`（非原文 25 字元全文）；長度 ≤20
  時原樣顯示、不加 `…`（邊界零截斷）。
