# D-022: `名單` 的 0-候選回退修正

- 狀態：**APPROVED（繼承 D-020，2026-09-01）**——設計內容自 D-020 §5.4 **逐字**切出，未改動任何已核可決定。
- 風險等級：**R2（高）**——`src/domain/registration-service.ts` 屬 CLAUDE.md §4.5 預設高風險模組（D-020 風險列已明列）；隨 T-033a 一併審查。**〔切檔複審修正〕原標 R1 為未申報降級，已更正**。
- 來源：D-020 §5.4；內文所有 `§x` 皆指 **D-020 的舊章節編號**（轉址表見 umbrella `D-020`）。**〔切檔複審修正〕本檔併入 T-033a**：§5.4 明文要求 `getListView` 的候選數判斷「必須先跑 §5.2 的消歧義流程」，是 §5.1／§5.2 接線的約束（G9）而非後續修補；獨立成任務會使 T-033a 交付時即違反 G9。同屬 T-033a：D-021、D-023、D-024、D-026。

## 一、設計內容

#### 5.4 `名單`（list）的 0-候選回退——不可直接套用通用模式的原因

多場並行下，`findLatestDisplayable(groupId)`（`{draft,open,closed}` 依 id 取最新）**不再安全**
當作「候選數 ≤ 1」的通用回退：群組可能同時有一場**仍 open** 的活動（id 較小、較早建立）與一場
**較晚建立且已 closed** 的活動（id 較大）——舊碼在單場限制下這兩者不可能共存，新碼下可以。
若沿用「latest by id」，`名單` 會顯示錯誤的（已結束的）那場，蓋掉仍在報名中的那場。

**修正**：`getListView` 的候選數判斷**必須先跑 §5.2 的消歧義流程**（`listActiveByGroup` 為準）：
`candidates.length>=1` 時一律用消歧義解出的 `eventId`（`getById`，必為 open/draft，天然正確）；
只有 `candidates.length===0`（群組完全沒有 active 活動）才退回 `findLatestDisplayable`
（此時只剩 closed/cancelled 可選，不存在「蓋掉仍開放活動」的風險，行為零回歸）。

**`編輯`（editEvent）不受此問題影響**：其既有「0 候選 → `findLatestDisplayable` 判斷是否
`closed_not_editable`」分支，本就只在 candidates.length===0 時執行（editEvent 從未在有 active
活動時去查 closed 事件），無需修正、直接沿用（附註於 §5.1 表格）。

## 二、Guardrails（Must NOT）

- **G9（`名單` 0-候選回退的正確順序）**：`getListView` 不得在候選數未知的情況下直接呼叫
  `findLatestDisplayable`；必須先以 `listActiveByGroup` 判斷候選數，`>=1` 時一律使用消歧義解出
  的 `eventId`（`getById`），**只有** `===0` 時才退回 `findLatestDisplayable`（見 §5.4，防止較新
  的 closed 活動蓋掉仍 open 的較舊活動）。

## 三、Acceptance Checks

> **〔切檔新增〕測試標記一律用本檔編號**：`[D-022 AC-18] …`（AC 編號沿用 D-020 原號不變，但 `check_ac_coverage.py` 依**檔名**判定文件編號，寫 `[D-020 AC-18]` 會對不上）。

- [ ] **[D-020 AC-18]（`名單` 不被較新 closed 活動蓋掉）**：群組同時有活動 A（id 較小、仍 open）
  與活動 B（id 較大、已 closed），`名單`（無 selector/引言，因 candidates.length===1 只有 A）
  → 顯示活動 A 的即時名單，**不是** B 的截止名單。
- [ ] **[D-020 AC-19]（0 候選時 `名單` 回退不變）**：群組目前 0 場 active、僅有 1 場歷史 closed
  活動 → `名單` 顯示該 closed 活動（`findLatestDisplayable` 回退，既有行為零回歸）。
