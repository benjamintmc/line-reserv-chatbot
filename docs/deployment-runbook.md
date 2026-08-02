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
   - **Pooled（app runtime 用）**：host 含 `-pooler`，例 `postgres://user:pw@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/dbname?sslmode=require`
   - **Direct（migrate 用）**：host **不含** `-pooler`，例 `postgres://user:pw@ep-xxx.ap-southeast-1.aws.neon.tech/dbname?sslmode=require`

> 為何分兩條：migrate 是一次性、走直連即可；app runtime 走 pooler（PgBouncer）控管連線數。**不要**把 app runtime 指到直連（多實例會撞連線上限）。

---

## 2. Migrate（一次性，對 Neon 直連跑）

在**本機**（專案根目錄）對 Neon **直連**字串跑 migration（建 5 表 + schema_migrations + 索引/約束）：

PowerShell：
```powershell
$env:DATABASE_URL = "postgres://user:pw@ep-xxx.ap-southeast-1.aws.neon.tech/dbname?sslmode=require"  # 直連（非 -pooler）
npm run db:migrate
```
預期輸出（全新 DB）：`[migrate] 本次套用：0001_init, 0002_billing_modes, 0003_merge_event_datetime`。重跑會顯示 `已套用略過`（冪等）。

> `0003_merge_event_datetime`（D-008 T-014，單場自動釋放）已交付：合併 `event_date`+`event_time` → `event_datetime`（UTC）並重定義 `ux_events_active_group` 為 {draft,open}。既有已上線環境升級時，對直連再跑一次 `npm run db:migrate` 即會套用 0003（backfill 台灣本地→UTC 等義、drop 舊兩欄）。

**驗證**（可用 Neon Console SQL Editor）：`\dt` 或 `SELECT tablename FROM pg_tables WHERE schemaname='public';` 應見 `users`、`events`、`registrations`、`conversation_states`、`processed_events`、`schema_migrations`。

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

```bash
gcloud run deploy golf-reserv-chatbot \
  --image=asia-east1-docker.pkg.dev/PROJECT_ID/golf-reserv/chatbot:v1 \
  --region=asia-east1 \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --concurrency=4 \
  --set-env-vars="DATABASE_URL=<POOLED 連線字串>,LINE_CHANNEL_SECRET=<...>,LINE_CHANNEL_ACCESS_TOKEN=<...>,ADMIN_USER_IDS=<你的userId>"
```
- **`DATABASE_URL` 用 POOLED（-pooler）字串**（步驟 1 的第一條）。
- `--allow-unauthenticated`：LINE 平台要能 POST 到 `/webhook`（驗簽在應用層做，見下）。
- **不要**設 `DEBUG_WEBHOOK`（生產關閉）。
- 部署完取得服務 URL：`https://golf-reserv-chatbot-xxxx.a.run.app`。

> **憑證安全（建議升級，非 MVP 阻擋）**：上面用 `--set-env-vars` 直接帶 secret 最省事，但更安全的做法是走 **Secret Manager** + `--set-secrets`（避免 secret 出現在 Cloud Run 設定明文）。MVP 可先用 env vars，之後再收斂。

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
| **Cloud Run service** | `golf-reserv-chatbot`（`min-instances=0`、`concurrency=4`、`--allow-unauthenticated`） |
| **Service URL** | `https://golf-reserv-chatbot-1006751446489.asia-east1.run.app` |
| **LINE Webhook URL** | `https://golf-reserv-chatbot-1006751446489.asia-east1.run.app/webhook`（已 Verify + 真機冒煙通過） |
| **Artifact Registry** | repo `golf-reserv`，image `asia-east1-docker.pkg.dev/group-chatbot-504305/golf-reserv/chatbot`，現行 tag `:v1` |
| **DB（Neon）** | host `ep-old-cherry-az822uzr`（Singapore）；app runtime 用 **pooled**（`-pooler`）、migrate 用直連；已套用 migration 0001/0002/0003 |
| **驗證** | `GET /health` → 200 `{"status":"ok"}`；4 個 env vars 已設（`DATABASE_URL`/`LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`/`ADMIN_USER_IDS`），`DEBUG_WEBHOOK` 未設（生產關閉） |

> 待收斂（post-MVP）：secret 目前以 `--set-env-vars` 明文帶 → 可改 Secret Manager；`--min-instances=0` 冷啟遺失窗口 → 需消除可切 `--min-instances=1`（犧牲 $0）。

## 附錄：常見問題

- **改了程式要重新部署**：重跑步驟 3（build/push 新 tag，如 `:v2`）+ 步驟 4（`gcloud run deploy` 指新 image）。
- **改了 schema（新 migration）**：先步驟 2（對直連 `npm run db:migrate`）再步驟 3/4。
- **SSL**：目前連線 `ssl.rejectUnauthorized=false`（僅加密不驗 CA，MVP 相容 Neon）。要更嚴謹可改為驗證 Neon CA 鏈（架構 nit N1，post-MVP）。
- **健康檢查**：`GET /health` 回 `{status:'ok'}`（不依賴 DB），Cloud Run 探活用。
- **e2e/AC-4 端到端、AC-11 真 image build**：屬本部署階段驗證（D-007 §9 step6/step7），於冒煙測試 + `docker build` 成功即涵蓋。
