# design/ — 功能設計文件

> 規則：**沒有 APPROVED 的設計文件，不得動工實作。**

## 命名慣例
`D-{{三位數編號}}-{{feature-slug}}.md`，例：`D-001-user-auth.md`。
任務看板、commit 訊息一律引用此 ID，形成「設計 → 任務 → 程式碼」的可追溯鏈。

## 撰寫者分派
- 前端功能 → frontend-engineer 撰寫
- 後端功能 → backend-engineer 撰寫
- 跨端/跨模組功能 → architect 撰寫（或前後端各寫一份、architect 整合）
- Orchestrator 不代寫設計，只負責發起、主持與使用者的規格討論、記錄裁決。

## 文件狀態機
```
DRAFT → IN_DISCUSSION → APPROVED → (SUPERSEDED)
```
- **DRAFT**：撰寫中，其他人不需回應。
- **IN_DISCUSSION**：Orchestrator 拿此文件與使用者討論規格；使用者的裁決由
  Orchestrator 直接更新回文件並記錄於「討論紀錄」段。
- **APPROVED**：使用者確認。此後 Guardrails 與 Acceptance Checks 即為驗收依據；
  變更需回到 IN_DISCUSSION 重新確認。
- **SUPERSEDED**：被新版設計取代，檔案保留、標註接替文件 ID。

## 三段式結構的下游用途
| 段落 | 誰在用 | 怎麼用 |
|---|---|---|
| 設計內容 | 實作 agent | 實作的唯一規格來源 |
| Guardrails（Must NOT） | reviewer | 逐條檢查，違反即 blocker，無討論空間 |
| Acceptance Checks | unit-tester / e2e-tester | 逐條轉為測試案例；全過才可標 DONE |
