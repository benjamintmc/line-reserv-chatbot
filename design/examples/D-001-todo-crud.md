# D-001: Todo 基本 CRUD（黃金範例）

> 這是一份**已填寫完成的範例**，示範設計文件應有的完成度。撰寫新設計時請對齊此標準。

- 狀態：APPROVED（範例，僅供參考，不參與 checks 掃描——位於 examples/ 下）
- 撰寫者：backend-engineer（後端部分）
- 關聯：Brief §MVP 功能第 1 條 / 契約 `POST,GET,PATCH,DELETE /todos` / 任務 T-010, T-011

## 一、設計內容

使用者登入後可建立、查看、編輯、刪除自己的 todo。每筆 todo 含
`id, title(1–200字), done(bool), createdAt, updatedAt`，僅擁有者可存取。

流程：前端呼叫 `GET /todos?done=&page=` 取得分頁清單（預設每頁 20 筆、
`createdAt` 倒序）；建立走 `POST /todos`，成功回 201 與完整物件；
編輯用 `PATCH /todos/:id`（僅允許 `title`、`done` 兩欄位）；刪除為軟刪除
（`deletedAt` 欄位），清單與單筆查詢一律排除已軟刪資料。

資料層：`todos` 資料表，`userId` 外鍵 + `(userId, createdAt)` 複合索引。
權限檢查在 service 層以 `assertOwner(userId, todoId)` 統一處理，
查無資料與無權限一律回 404（不洩漏資源存在性）。

### 範圍內
- 單人 CRUD、分頁、done 篩選、軟刪除

### 範圍外
- 共享/協作、標籤、排序自訂、還原已刪除項目（進 Backlog）

## 二、Guardrails（Must NOT）
- 不得在 handler/router 層直接操作資料庫；一律經 service → repository。
- 不得回傳他人的 todo，即使是 404 錯誤訊息也不得暗示資源存在（禁用 403 區分）。
- 不得允許 PATCH 修改 `id, userId, createdAt` 等系統欄位（未知欄位一律 400）。
- 不得物理刪除資料列。
- 前端不得自行計算分頁總數；一律使用回應中的 `meta.total`。

## 三、Acceptance Checks（可驗證的驗收條件）
- [ ] AC-1：未帶有效 token 呼叫任一 endpoint → 401 與統一錯誤格式。（unit）
- [ ] AC-2：`POST /todos` 帶合法 title → 201，回應含伺服器產生的 `id, createdAt`。（unit）
- [ ] AC-3：title 為空或超過 200 字 → 400，`code: "VALIDATION_ERROR"`。（unit）
- [ ] AC-4：使用者 A 以任何方法存取使用者 B 的 todo → 404。（unit）
- [ ] AC-5：DELETE 後，該筆不再出現在清單與單筆查詢，但資料列仍存在且 `deletedAt` 非空。（unit）
- [ ] AC-6：建立 25 筆後 `GET /todos` → 第一頁 20 筆、`meta.total = 25`、第二頁 5 筆。（unit）
- [ ] AC-7：登入 → 建立 → 勾選完成 → 刪除，全流程 UI 正常且清單即時更新。（e2e）

## 討論紀錄（Orchestrator 維護）
| 日期 | 議題 | 使用者裁決 |
|---|---|---|
| 2026-07-10 | 刪除採軟刪或硬刪？ | 軟刪；還原功能進 Backlog |
| 2026-07-10 | 無權限回 403 或 404？ | 404，避免洩漏資源存在性 |
