# 部署 Runbook — Cloud Run + Neon(PG)（$0/月）

> T-012（PG 移植）產出。依 D-007 §9 落為可執行步驟。**這些步驟由使用者操作**（需 Neon 帳號、Google Cloud 帳號 + `gcloud` CLI）。
> 已驗證：本機對 Docker PG 跑 256 tests 綠、build/lint 0、AC 129/129。以下是把它上到雲端的步驟。

## 0. 前置需求

| 項目 | 說明 |
|---|---|
| **Neon 帳號** | https://neon.tech 免費層（Postgres，autosuspend）。 |
| **Google Cloud 帳號 + 專案** | 啟用 Cloud Run、Artifact Registry API；安裝 `gcloud` CLI 並 `gcloud auth login`。 |
| **LINE 官方帳號憑證** | 已有：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`（Messaging API channel）。 |
| **你的 LINE userId** | 供 `ADMIN_USER_IDS`（super-admin 安全網）。以 `我的ID` 或 `DEBUG_WEBHOOK=1` 從 log 取得。 |

> **成本**：Cloud Run `min-instances=0`（閒置零計費）+ Neon 免費層 = $0/月。訊息量非瓶頸（bot 只用 reply、不吃 LINE 200 則 push 額度）。

---

## 1. Neon：建 DB、取兩條連線字串

1. Neon Console → 新建 Project（region 選離使用者近的，如 Singapore `ap-southeast-1`）。
2. 取得**兩條**連線字串（Dashboard → Connection Details）：
   - **Pooled（app runtime 用）**：host 含 `-pooler`，例 `postgres://user:pw@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/dbname?sslmode=verify-full`
   - **Direct（migrate 用）**：host **不含** `-pooler`，例 `postgres://user:pw@ep-xxx.ap-southeast-1.aws.neon.tech/dbname?sslmode=verify-full`

> 為何分兩條：migrate 是一次性、走直連即可；app runtime 走 pooler（PgBouncer）控管連線數。**不要**把 app runtime 指到直連（多實例會撞連線上限）。

---

## 2. Migrate（一次性，對 Neon 直連跑）

在**本機**（專案根目錄）對 Neon **直連**字串跑 migration（建 5 表 + schema_migrations + 索引/約束）：

PowerShell：
```powershell
$env:DATABASE_URL = "postgres://user:pw@ep-xxx.ap-southeast-1.aws.neon.tech/dbname?sslmode=verify-full"  # 直連（非 -pooler）
npm run db:migrate
```
預期輸出（全新 DB）：`[migrate] 本次套用：0001_init, 0002_billing_modes, 0003_merge_event_datetime`。重跑會顯示 `已套用略過`（冪等）。

> `0003_merge_event_datetime`（D-008 T-014，單場自動釋放）已交付：合併 `event_date`+`event_time` → `event_datetime`（UTC）並重定義 `ux_events_active_group` 為 {draft,open}。既有已上線環境升級時，對直連再跑一次 `npm run db:migrate` 即會套用 0003（backfill 台灣本地→UTC 等義、drop 舊兩欄）。

**驗證**（可用 Neon Console SQL Editor）：`\dt` 或 `SELECT tablename FROM pg_tables WHERE schemaname='public';` 應見 `users`、`events`、`registrations`、`conversation_states`、`processed_events`、`schema_migrations`。

---

## 2.1 升級 `0004_conversation_scope_pk`（D-013 / T-022）— **單階段，須照順序**

`0004` 把 `conversation_states` 的 PK 由 `line_user_id` 改為 `(group_id, line_user_id)`（同一人在不同群的流程可並行）。**此 migration 非向後相容**：舊版程式的 `ON CONFLICT (line_user_id)` 在 PK 換掉後會找不到匹配的唯一約束而直接報錯。裁決採**單階段**（先 migrate、再部署）。

1. **對直連（非 `-pooler`）字串執行**，然後**立即**部署新 revision（§3–§4）：
   ```powershell
   $env:DATABASE_URL = "postgres://user:pw@ep-xxx...neon.tech/dbname?sslmode=verify-full"  # 直連
   npm run db:migrate    # 預期：[migrate] 本次套用：0004_conversation_scope_pk
   ```
   兩步之間的窗口越短越好（min-instances=0、流量極低，實務上數分鐘可接受）。
   **實務作法（2026-08-19 執行時採用）**：先做 §3 的 build/push（慢，數分鐘），再 migrate，最後 `gcloud run deploy`（快）
   ⇒ 窗口只剩 deploy 本身。順序約束是「migrate 早於 deploy」，build/push 不動 DB 亦不換 revision，提前做不違反。

2. **窗口內會失效的指令**（皆走 conversation `upsert`；`get`／`delete` 不受影響，故 `名單`／`+N`／`-N`／`關閉報名`／`取消活動` 正常）：
   - `開團`（逐步問答入口）
   - **一行式**開團（`開團 <日期> <時間> <場地> <人數> <費用>`）
   - 逐步問答的**每一步作答**（日期／時間／場地／人數／費用）
   - `分組 {M}場 …`（啟動多輪 session）
   - `下一輪`
   使用者症狀為「沒有回覆」；**窗口結束後重打即可**，無資料損毀。

3. **逾時處理**：檔首 `SET LOCAL lock_timeout = '3s'`。`ALTER TABLE` 需 ACCESS EXCLUSIVE 鎖，若被其他交易擋住會在 3 秒後失敗；runner 為單檔單交易 ⇒ **整檔 ROLLBACK、不留半套**，稍後（流量更低時）**重跑 `npm run db:migrate` 即可**。若反覆逾時，先確認無長交易佔用該表。

4. **驗證**：
   ```sql
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'conversation_states'::regclass AND contype = 'p';
   -- 預期：conversation_states_pkey | PRIMARY KEY (group_id, line_user_id)
   SELECT count(*) FROM conversation_states WHERE group_id IS NULL;  -- 預期 0（0004 已清）
   ```

5. **⚠️ 退版警語**：新 revision 一旦運行，就可能產生「同一人多群各一列」的資料。反向 migration（改回單鍵 PK）**無法自動決定保留哪一列**，只能人工取捨 ⇒ **退版即有資料損失**（受影響者為進行中的開團問答／分組 session，重打指令即可恢復；不影響 `events`／`registrations`）。故退版前請確認該損失可接受。

---

## 3. Build image 並推到 Artifact Registry

```bash
# 一次性：建 Artifact Registry repo（region 自選，與 Cloud Run 同區）
gcloud artifacts repositories create golf-reserv --repository-format=docker --location=asia-east1

# 設定 docker 認證
gcloud auth configure-docker asia-east1-docker.pkg.dev

# build + tag + push（PROJECT_ID 換成你的）
docker build -t asia-east1-docker.pkg.dev/PROJECT_ID/golf-reserv/chatbot:v1 .
docker push asia-east1-docker.pkg.dev/PROJECT_ID/golf-reserv/chatbot:v1
```
> Dockerfile 為 PG-only（無 better-sqlite3 native）→ image 小、cold start 快。`node dist/index.js` 監聽 Cloud Run 注入的 `PORT`。

---

## 4. Cloud Run 部署

### 4.0 一次性：把憑證放進 Secret Manager（資安 M2，2026-08-23 起為正式做法）

**不得**再用 `--set-env-vars` 帶 `DATABASE_URL` / `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`——
明文 env var 會出現在 Cloud Run console、`gcloud run services describe`（任何 `roles/viewer` 可讀），
以及**所有歷史 revision 的設定**（無法回頭修改，只能刪 revision）。

```bash
gcloud services enable secretmanager.googleapis.com

# 建立三個 secret（值從 stdin 餵入，不留在 shell history）
printf '%s' '<POOLED 連線字串，須 ?sslmode=verify-full>' | gcloud secrets create database-url --replication-policy=automatic --data-file=-
printf '%s' '<LINE channel secret>'       | gcloud secrets create line-channel-secret --replication-policy=automatic --data-file=-
printf '%s' '<LINE channel access token>' | gcloud secrets create line-channel-access-token --replication-policy=automatic --data-file=-

# 授權 Cloud Run runtime service account 讀取
SA=$(gcloud run services describe golf-reserv-chatbot --region asia-east1 --format='value(spec.template.spec.serviceAccountName)')
for s in database-url line-channel-secret line-channel-access-token; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
done
```

### 4.1 部署

```bash
gcloud run deploy golf-reserv-chatbot \
  --image=asia-east1-docker.pkg.dev/PROJECT_ID/golf-reserv/chatbot:vN \
  --region=asia-east1 \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --concurrency=4 \
  --set-env-vars="ADMIN_USER_IDS=<你的userId>" \
  --set-secrets="DATABASE_URL=database-url:latest,LINE_CHANNEL_SECRET=line-channel-secret:latest,LINE_CHANNEL_ACCESS_TOKEN=line-channel-access-token:latest"
```
- **`DATABASE_URL` 用 POOLED（-pooler）字串且結尾 `?sslmode=verify-full`**（步驟 1 第一條、D-014 G2）。
- **`--max-instances=3`（資安 M3）**：`/webhook` 必須開放未驗證存取（LINE 平台要打得到），
  驗簽**之前**沒有節流 ⇒ 被灌流量時每則都會喚醒實例。此上限是**帳單天花板**；
  正常用量 1–2 個實例綽綽有餘，調高前請先確認不是被掃。
- `--allow-unauthenticated`：LINE 平台要能 POST 到 `/webhook`（驗簽在應用層做，見下）。
- **不要**設 `DEBUG_WEBHOOK`：即使設了，`NODE_ENV=production` 下程式也會忽略（資安 M5 fail-safe）。
- 部署完取得服務 URL：`https://golf-reserv-chatbot-xxxx.a.run.app`。

### 4.2 憑證輪替程序（資安 M2 要求；憑證可能外洩時執行）

1. LINE Developers Console → Messaging API channel → 重新簽發 **Channel access token**（必要時含 **Channel secret**）。
2. `printf '%s' '<新值>' | gcloud secrets versions add line-channel-access-token --data-file=-`
3. 重新部署或 `gcloud run services update ... --set-secrets="...:latest"`
   ——**新 revision 才會讀到新版本**，`:latest` 不會自動套用到已運行的 revision。
4. 真機驗一則指令 → 確認新憑證可用後：
   `gcloud secrets versions disable <舊版本號> --secret=line-channel-access-token`
5. **刪除仍帶明文 secret 的舊 revision**：
   `gcloud run revisions delete golf-reserv-chatbot-0000N-xxx --region asia-east1`
   注意：刪掉即失去該回滾點，請先確認新 revision 穩定。

### 4.4 ⚠️ 憑證改動後的必要冒煙（2026-08-23 事故教訓）

**`/health` 200 與未簽章 401 都不會碰到 channel secret 或 DB**——驗簽壞掉時回的**照樣是 401**。
只驗這兩項就宣告成功，會讓一個 100% 收不到訊息的 revision 上線而無人察覺（本次實際發生 33 分鐘）。
憑證或連線字串改動後**必須**加驗下列兩項：

```bash
# ① 用 secret 算出正確簽章打回去，預期 200（空 events 無副作用）
URL=https://golf-reserv-chatbot-1006751446489.asia-east1.run.app/webhook
SIG=$(gcloud secrets versions access latest --secret=line-channel-secret | python -c "
import sys,hmac,hashlib,base64
s=sys.stdin.read().encode()
print(base64.b64encode(hmac.new(s,b'{\"events\":[]}',hashlib.sha256).digest()).decode(),end='')")
curl -s -o /dev/null -w '%{http_code}
' -X POST "$URL" -H 'Content-Type: application/json'   -H "x-line-signature: $SIG" -d '{"events":[]}'

# ② 用該連線字串跑一次真實查詢，證明 verify-full 下 DB 可通
gcloud secrets versions access latest --secret=database-url | node --input-type=module -e "
let s='';process.stdin.setEncoding('utf8');for await (const c of process.stdin) s+=c;
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: s.trim(), max: 1 });
console.log((await pool.query('select 1 as ok')).rows[0]); await pool.end();"
```

> **取值陷阱（本次根因）**：`gcloud ... --format="value(env.filter(...).extract(value))"` 對 list 欄位
> 會輸出 **`['…']` 包裝**，三個憑證因此全部多了 4 個字元存進 Secret Manager。
> **取單一值一律走 `--format=json` 再解析**，並在寫入前核對長度
> （LINE channel secret = 32 字元、access token = 172 字元）。

### 4.3 告警（資安 M3）

已建立 Cloud Monitoring 政策 **「webhook 驗簽失敗異常（資安 M3）」**：
5 分鐘內 `/webhook` 回 401 超過 20 次 → 寄信至通知管道 `chatbot-owner-email`。
正常情況 401 幾乎為 0（LINE 送來的請求必帶正確簽章），持續 401 ＝ 網址已被掃到，或 channel secret 不符。
> 未做主動阻擋：Cloud Armor 需先架 Load Balancer（約 $18+/月起），以 `--max-instances` 限制損失上限取代。

---

## 5. LINE Console：設 Webhook URL

1. LINE Developers Console → 你的 Messaging API channel → **Webhook URL** 設為 `https://golf-reserv-chatbot-xxxx.a.run.app/webhook`（固定、永久）。
2. **Use webhook** 開啟；點 **Verify**（應回 200）。
3. 確認 **Response mode = Bot**（非 Chat）、**自動回應訊息關閉**（否則訊息事件不會進 webhook——見 LESSONS 踩雷）。

---

## 6. 冒煙測試（真機）

1. 把 bot 加進 LINE 群組。
2. （首次無活動）需先有一場 open 活動——由主辦 `開團 …` → `確認`（M3 開團流程），或用 `npm run db:seed`（`DATABASE_URL` 指 pooled、帶 `GROUP_ID`）。
3. 群組輸入 `+1`、`名單`、`-1` → bot 即時回覆名單與剩餘名額。
4. **冷啟不漏送檢查**：讓服務閒置（縮回 0 實例）後打第一則指令，確認回覆送達。

> **冷啟延遲窗口（誠實界定，D-007 §4）**：`min-instances=0` 首擊需 Cloud Run 拉起實例（~1–3s）+ Neon 喚醒（~數百 ms）。極端首擊可能逼近 LINE webhook 逾時 → LINE 重送 → 因去重（`processed_events` 已提交）該則**回覆偶發遺失**（副作用不重複，使用者可重打指令或以 `名單` 確認）。MVP 接受此權衡。若要消除：設 `--min-instances=1`（犧牲 $0）。

---

## 附錄：上線座標（2026-08-02 已部署）

> 本節記錄實際上線的環境參數，供重部署 / 交接查閱。

| 項目 | 值 |
|---|---|
| **GCP 專案 / region** | `group-chatbot-504305` / `asia-east1` |
| **Cloud Run service** | `golf-reserv-chatbot`（`min-instances=0`、`max-instances=3`、`concurrency=4`、`--allow-unauthenticated`；secret 走 Secret Manager） |
| **Service URL** | `https://golf-reserv-chatbot-1006751446489.asia-east1.run.app`（Cloud Run 另配發新式網址 `https://golf-reserv-chatbot-ree7igdzeq-de.a.run.app`，兩者指向同一 service、皆回 200；**LINE Webhook 沿用上列舊式網址，勿更動**） |
| **LINE Webhook URL** | `https://golf-reserv-chatbot-1006751446489.asia-east1.run.app/webhook`（已 Verify + 真機冒煙通過） |
| **Artifact Registry** | repo `golf-reserv`，image `asia-east1-docker.pkg.dev/group-chatbot-504305/golf-reserv/chatbot`，現行 tag **`:v8`**（revision **`golf-reserv-chatbot-00011-98d`**，**2026-09-02 部署 T-034 `編輯 費用` 切換計費模式**（同批含 T-032 測試檔型別檢查、harness 檢查修正，皆非執行期程式碼）；**本次無 migration**（最新仍 `0005_groups`，2026-08-28 已套用）⇒ 無不相容窗口，回滾至 `:v7` 無 schema 顧慮。本次無憑證變動，僅換 image（`gcloud run deploy --image` 保留既有設定）。⚠️ **`00010-h6f` 與 `00011-98d` 的 image digest 與 spec 完全相同**（同一次部署重跑兩次），流量 100% 在 `00011-98d`，`00010` 留作同版回滾點。冒煙（部署後 02:24 CST 由下一個 session 補跑，走完 §4.4 四項）：`/health` 200、未簽章 `POST /webhook` 401、錯誤簽章 401、**帶正確簽章 200**、**pooled 連線真實查詢成功**（`schema_migrations` 為 0001–0005、`events` 15 列）、revision log 無錯誤（唯二 WARNING 為冒煙自身的 401）；**真機驗證通過**：群組實測 `編輯 費用` 切換計費模式（2026-09-02））；`:v7`（revision **`golf-reserv-chatbot-00009-8zt`**，**2026-08-28 部署 T-029 觸及觀測 + T-030 指標 dashboard**；**本次有 migration `0005_groups`**——已於部署前對 Neon 直連套用，backfill 建出 5 列（既有 5 個群組）。`0005` 為純新增（CREATE TABLE + INSERT SELECT），舊 revision 不認得 `groups` 亦不受影響 ⇒ **migrate 與部署之間無不相容窗口**，回滾至 `:v6` 無 schema 顧慮（`groups` 留著不用即可）。本次無憑證變動，僅換 image（`gcloud run deploy --image` 保留既有設定）。冒煙：`/health` 200、未簽章 `POST /webhook` 401、**帶正確簽章 200**、pooled 連線可讀 `groups`、revision log 無錯誤（唯一 WARNING 為冒煙自身的 401）。**待真機驗證**：`join`/`leave` 事件、`getGroupSummary` 取群組名稱）；`:v6`（revision **`golf-reserv-chatbot-00008-q52`**，**2026-08-23 部署 T-028 文案與驗證一致性收斂**；冒煙走完 §4.4 四項：`/health` 200、**正確簽章 200**、錯誤簽章 401、**DB 真實查詢成功**。本次無 migration、無憑證變動，回滾至 `:v5` 無顧慮）；`:v5`（revision `golf-reserv-chatbot-00007-pdv`，**2026-08-23 部署 T-027 資安加固 H1/M2–M5**；冒煙：`/health` 200、**帶正確簽章 `POST /webhook` 200**、未簽章 401、**真實查詢連上 Neon（verify-full）**、cold start log 已無 pg SSL 別名警告、**使用者群組實測 `名單` 正常回覆**。⚠️ 中途 `00005-89q`／`00006-9hc` 為修正過程（見 §4.4）。**本次無 migration**，回滾至 `:v4` 無 schema 顧慮）；`:v4`（revision `golf-reserv-chatbot-00004-f5l`，**2026-08-23 部署 T-026 編輯活動資訊**；冒煙：`/health` 200、未簽章 `POST /webhook` 401。**本次無 migration**，故回滾至 `:v3` 無 schema 顧慮）；`:v3`/`00003-7lc`（T-018~T-022）、`:v2`/`00002-dhd`、`:v1`/`00001-sr7` 可回滾，但**退回 v2 以前需同時處理 0004 退版**，見 §2.1 ⚠️ |
| **DB（Neon）** | host `ep-old-cherry-az822uzr`（Singapore）；app runtime 用 **pooled**（`-pooler`）、migrate 用直連（同 host 去掉 `-pooler`）；已套用 migration 0001/0002/0003/0004/**0005**（`groups`，2026-08-28） |
| **憑證來源** | **Secret Manager**（T-027／資安 M2）：`database-url`／`line-channel-secret`／`line-channel-access-token`，皆授予 runtime SA `1006751446489-compute@developer.gserviceaccount.com` 的 `roles/secretmanager.secretAccessor`。僅 `ADMIN_USER_IDS` 維持明文 env var（非憑證） |
| **告警** | Cloud Monitoring 政策「webhook 驗簽失敗異常（資安 M3）」：5 分鐘內 401 > 20 次 → 通知管道 `chatbot-owner-email` |
| **驗證** | `GET /health` → 200 `{"status":"ok"}`；`POST /webhook` 未簽章 → 401；三個憑證於 `services describe` 皆為 `valueFrom.secretKeyRef`（無明文 `value`）；cold start log **不再出現** pg-connection-string 的 SSL 別名警告（**D-014 AC-6／AC-7 通過**，revision `00005-89q`）；`DEBUG_WEBHOOK` 未設，且 `NODE_ENV=production` 下程式強制忽略（資安 M5） |

> **2026-08-23 T-027（資安 H1／M2–M5）**：secret 已全數遷入 **Secret Manager**（`--set-secrets`）；
> `DATABASE_URL` 收斂為 `sslmode=verify-full`；`--max-instances=3` 帳單天花板 + 401 告警。
> **仍待辦**：①輪替 LINE token 並刪除仍帶明文 secret 的舊 revision（00001–00004，見 §4.2）；
> ②`--min-instances=0` 冷啟遺失窗口 → 需消除可切 `--min-instances=1`（犧牲 $0）。

## 附錄：常見問題

- **改了程式要重新部署**：重跑步驟 3（build/push 新 tag，如 `:v2`）+ 步驟 4（`gcloud run deploy` 指新 image）。
- **改了 schema（新 migration）**：先步驟 2（對直連 `npm run db:migrate`）再步驟 3/4。
- **SSL**：目前連線 `ssl.rejectUnauthorized=false`（僅加密不驗 CA，MVP 相容 Neon）。要更嚴謹可改為驗證 Neon CA 鏈（架構 nit N1，post-MVP）。
- **健康檢查**：`GET /health` 回 `{status:'ok'}`（不依賴 DB），Cloud Run 探活用。
- **e2e/AC-4 端到端、AC-11 真 image build**：屬本部署階段驗證（D-007 §9 step6/step7），於冒煙測試 + `docker build` 成功即涵蓋。
