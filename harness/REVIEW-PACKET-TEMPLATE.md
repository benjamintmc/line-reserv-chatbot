# 審查包（Review Packet）— 實作者交付時填寫

> 目的：讓 reviewer 只讀這一頁 + diff 就能完成審查，不必重載整個 codebase。
> 存放：與任務同編號，`docs/reviews/RP-{{T-xxx}}.md`。

- 任務：T-xxx ／ 設計：D-xxx ／ 風險：R0 / R1 / R2
- 變更檔案清單（含行數增減）：

## 1. 變更摘要（≤ 5 行）
（做了什麼、用什麼方式做）

## 2. Guardrails 自檢表
| Guardrail 條目 | 遵守？ | 證據（檔案:行） |
|---|---|---|
| 不得 … | ✓ | src/x.ts:42 |

## 3. Acceptance Checks 對照
| AC | 測試位置（含 `[D-xxx AC-n]` 標記） | 狀態 |
|---|---|---|

## 3.5 diff 範圍自檢（實作者交付前必做）
- [ ] §3 AC 對照表點名的**每一個檔案**，都出現在本包所附的 diff 中
- [ ] R2 任務已附**全部受影響檔案**的 diff，未以「與他任務共用」為由省略任何 hunk
- [ ] 產 diff 用**目錄層級路徑**（`src/webhook/`）而非逐檔列舉，減少手誤漏檔

## 4. 機器關卡結果
- [ ] lint / build 通過
- [ ] unit test 通過（X passed / Y total）
- [ ] `check_ac_coverage.py` 通過

## 5. 需要 reviewer 特別留意的地方（≤ 3 點）
（自己覺得有疑慮、或偏離慣例的部分——誠實列出可大幅減少來回次數）
-
