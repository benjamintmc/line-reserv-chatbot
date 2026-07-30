# M2 真實 LINE 跨試 Runbook（ngrok）

> 目的：在真實 LINE 群組上跨試 M2 報名核心（`+N` / `-N` / `名單` / 代報名 / 候補 / @遞補）。
> 因開團流程（M3/D-004）尚未實作，先用 `npm run db:seed` 手動建立一場 `open` 活動。
> 需你操作的部分：LINE 官方帳號/憑證、把 bot 加進群組、ngrok。程式端已備妥。

## 0. 前置需求（你需先具備）

- [ ] 一個 **LINE Official Account** 並在 [LINE Developers Console](https://developers.line.biz/) 建立 **Messaging API channel**。
- [ ] 取得 **Channel secret**（Basic settings）與 **Channel access token（long-lived）**（Messaging API 分頁 → Issue）。
- [ ] 安裝 **ngrok**（`ngrok http 3000`）並登入（免費帳號即可）。
- [ ] 一個測試用 **LINE 群組**（可自己建、拉朋友或分身帳號進來測代報名/候補）。
- [ ] 於 **LINE Official Account Manager**（manager.line.biz）→ 設定：
  - **Response settings**：關閉「自動回應訊息（Auto-reply）」與「加入好友的歡迎訊息」，開啟 **Webhook**。
  - **允許加入群組**：開啟「Allow bot to join group chats / 允許被邀請進入群組」。

## 1. 設定 .env

複製 `.env.example` 為 `.env`，填入：

```
LINE_CHANNEL_SECRET=<你的 channel secret>
LINE_CHANNEL_ACCESS_TOKEN=<你的 long-lived access token>
PORT=3000
DATABASE_PATH=./data/golf.db
DEBUG_WEBHOOK=1
```

> `DEBUG_WEBHOOK=1` 讓 server 在 log 印出每個事件的 `groupId`/`userId`，第 3 步取 groupId 用。跨試完成後可設回空。

## 2. 啟動 server + ngrok

兩個終端機：

```powershell
# 終端 A：啟動 bot（tsx watch 熱重載）
npm run dev

# 終端 B：開通道，取得 https 對外網址
ngrok http 3000
```

把 ngrok 顯示的 `https://xxxx.ngrok-free.app` 記下。

## 3. 設定 webhook 並取得 groupId / 你的 userId

1. LINE Developers Console → Messaging API → **Webhook URL** 填 `https://xxxx.ngrok-free.app/webhook` → **Verify**（應回 200；server log 會看到請求）。
2. 確認 **Use webhook = Enabled**。
3. 把 bot（官方帳號）**加入你的測試群組**。
4. 在群組隨便發一則文字訊息（例如「hi」）。
5. 看**終端 A** 的 log，找到：
   ```
   [DEBUG_WEBHOOK] 收到事件  sourceType:"group" groupId:"Cxxxxxxxx..." userId:"Uxxxxxxxx..." text:"hi"
   ```
   - 記下 **`groupId`（C 開頭）** → seed 活動用。
   - 記下你自己的 **`userId`（U 開頭）** → 若要測「主辦跨 owner 代取消」用。

> 註：此時發 `hi` bot 不會回覆是正常的（非指令一律忽略，防洗版）。

## 4. Seed 一場 open 活動

用第 3 步取得的 groupId（要測主辦代取消再帶 `HOST_LINE_USER_ID`）：

```powershell
# 終端 B（或新終端）
$env:GROUP_ID='Cxxxxxxxx...'
$env:HOST_LINE_USER_ID='Uxxxxxxxx...'   # 選填：帶你的 userId，測主辦跨 owner 代取消
npm run db:seed
```

成功會印出建立的活動（`status:"open"`, `capacity:16`, `每人 2200`…）。
可覆寫欄位：`EVENT_CAPACITY` / `EVENT_PRICE` / `EVENT_DATE` / `EVENT_TIME` / `EVENT_LOCATION`。

> 建議測候補/遞補時用小 capacity（如 `$env:EVENT_CAPACITY='2'`）比較快滿。
> `npm run dev` 用的是同一個 `DATABASE_PATH`，seed 完不需重啟即生效。

## 5. 在群組跨試指令（對照預期回覆）

| 輸入 | 預期 | 對應 AC |
|---|---|---|
| `+1` | 活動摘要 + 名單（1/16）+ 剩餘 15 | AC-1 |
| `+2` | 名單新增 2 位，後綴 `你的名字(2)`/`(3)` | AC-1/AC-13 |
| `名單` | 依序名單 + 每人價格 + 預估總金額 | AC-8 |
| `+1 陳大哥`（代報名） | 名單出現「陳大哥」 | AC-6 |
| `-1` | 取消你 1 位自報名 | AC-12 |
| `-1 陳大哥` | 取消你代報的「陳大哥」 | AC-7 |
| （capacity=2 已滿後）另一人 `+2` | 「整批排入候補」+ 候補序位 | AC-3 |
| 滿員時某正取 `-1` | 釋出名額，**候補第一位被 @mention 遞補** | AC-4/AC-14 |
| `+99` | **靜默不回覆**（防洗版） | AC-15 |
| 閒聊訊息 | **不回覆** | AC-10 |
| 主辦人（seed 時帶的 userId）`-1 陳大哥`（他人代報） | 跨 owner 代取消成功 | AC-17 |

> 多帳號測法：拉第二個 LINE 帳號進群，用它 `+N` / 代報名，再用主辦帳號測「主辦代取消他人代報」。

## 6. 收尾

- 跨試完成後，`.env` 的 `DEBUG_WEBHOOK` 設回空（關閉事件 log）。
- 測試資料在 `./data/golf.db`（已 gitignore）；要重來就刪掉該檔再 seed。
- ngrok 免費網址每次重啟會變，變更後記得回 LINE Console 更新 Webhook URL。

## 疑難排解

| 症狀 | 可能原因 / 處置 |
|---|---|
| Webhook Verify 失敗 / 401 | `LINE_CHANNEL_SECRET` 未填或錯；ngrok 未指向 3000；server 未啟動 |
| 指令有進 log 但 bot 不回 | LINE Official Account 的「自動回應」未關（會蓋掉）；或該指令設計上就靜默（`+99`、閒聊） |
| `+1` 回「目前沒有開放報名的活動」 | 尚未 seed，或 seed 的 `GROUP_ID` 與實際群組不符（重看第 3 步 log） |
| 新成員報名顯示「使用者」而非暱稱 | `getGroupMemberProfile` 取名失敗的 fallback；確認 access token 正確、bot 仍在群內 |
| @遞補通知沒有藍字可點 | mention 需 `textV2`；確認未被自動回應攔截；fallback 會退成純文字 `@名字` |
