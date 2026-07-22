# harness/checks/ — 可執行的品質關卡

原則：**Definition of Done 的每一項，能自動化的就自動化**，不依賴模型自我宣稱。

## 慣例
1. 每條 Acceptance Check 都有 ID（AC-1、AC-2…），在設計文件中定義。
2. 對應測試必須在測試名稱或註解中標記 `[D-xxx AC-n]`，例：
   - `test("[D-001 AC-1] 未登入建立 todo 應回 401", ...)`
   - Python: `def test_d001_ac1_reject_unauthenticated(): ...`（docstring 內含 `[D-001 AC-1]`）
3. `check_ac_coverage.py` 掃描所有 APPROVED 設計文件的 AC 清單，
   比對測試目錄中的標記，輸出覆蓋報告；有缺漏 → exit code 1。

## 執行
```bash
python3 harness/checks/check_ac_coverage.py          # AC ↔ 測試覆蓋檢查
bash    harness/checks/check_commit_trace.sh          # commit 訊息可追溯性檢查
```
建議掛進 CI 或 pre-push hook；Orchestrator 在標記任務 DONE 前必須跑過。

## 擴充
專案特有的 guardrail 若可機器判定（如「前端不得直接 import ORM」），
寫成 `check_*.py` / `check_*.sh` 放進本目錄，並在對應設計文件的 Guardrail 條目
註明「自動檢查：checks/check_xxx.py」。
