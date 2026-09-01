#!/usr/bin/env python3
"""文件預算檢查：超過行數上限的文件應切檔，避免載入成本膨脹。
用法: python3 harness/checks/check_doc_budget.py [--strict]
--strict 時超標即 exit 1；預設僅警告（exit 0）。

豁免：harness/doc-budget-exempt.txt 列出的路徑不受行數上限約束
（既有專案導入前的文件不回溯，見 CLAUDE.md §4.5）。
"""
import sys, pathlib, re

# Windows 主控台常為 cp950/cp437，直接 print ✓ 會丟 UnicodeEncodeError，
# 使成功的檢查反而以 exit≠0 收場（假紅）。強制 UTF-8 輸出，並以 replace 保底。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIMITS = {
    "design/D-": 120,
    "docs/01-architecture": 300,
    "docs/02-api-contract.md": 300,
    "docs/task-board.md": 80,
    "CLAUDE.md": 150,
}
SKIP = ("examples/", "archive", "TEMPLATE", "handoffs/")
EXEMPT_FILE = ROOT / "harness/doc-budget-exempt.txt"


def load_exempt():
    """讀豁免清單；每行一個相對路徑（posix 格式），# 開頭為註解。"""
    if not EXEMPT_FILE.exists():
        return set()
    lines = EXEMPT_FILE.read_text(encoding="utf-8").splitlines()
    return {s.strip() for s in lines if s.strip() and not s.lstrip().startswith("#")}


# errata 不計入行數上限。理由：上限管的是「設計內容的篇幅」——TOKEN-BUDGET 規則七寫得很白，
# 「超出預算多半代表任務該再拆一層」，抓的是任務過大。errata 是**事後**追加的更正註記，是
# CLAUDE.md §2 文件契約明文要求的行為（設計變更必須回填既有文件），與任務大小無關。
# 兩者混在一起計數的後果：每補一條 errata 就得先砍掉別的內容才能過關 —— 這正是 2026-08-22
# 把 Backlog 自 task-board 切出來的同一個理由（成長曲線不同的東西不該共用一個預算）。
# 實例：D-011 與 D-015 在 main 上恰好都是 120 行（貼著上限），任何一條 errata 都會使其超標。
#
# 兩種既有寫法都要認（勿只認其一，否則規則對半數文件失效）：
#   (a) `## errata（…）` 標題區段 —— 直到下一個 `## ` 標題為止（D-015）
#   (b) `> **errata（…）**` 引用區塊 —— 該段連續的 `>` 行（D-011）
# 「討論紀錄」表同理：每發生一次 errata 就多一列，是隨**時間**成長的決策日誌，
# 不是隨**任務大小**成長的設計內容。兩者一併排除，預算才真的只在管 CLAUDE.md §5 所說的
# 「設計內容 → Guardrails → Acceptance Checks」三段式本體。
ERRATA_HEADING = re.compile(r"^##\s+(errata|討論紀錄)", re.I)
ANY_H2 = re.compile(r"^##\s")


def content_lines(text: str) -> int:
    """回傳排除 errata 區段後的行數。"""
    n, in_section, in_quote = 0, False, False
    for line in text.splitlines():
        if ERRATA_HEADING.match(line):
            in_section, in_quote = True, False
            continue
        if in_section:
            if ANY_H2.match(line):
                in_section = False  # 落到下方一般計數
            else:
                continue
        if line.startswith(">"):
            # 引用區塊：只有「首行含 errata」的整段才排除；其餘引用照常計數。
            if not in_quote:
                in_quote = "errata" in line.lower()
            if in_quote:
                continue
        else:
            in_quote = False
        n += 1
    return n


# 120 行只適用 R1。`harness/TOKEN-BUDGET.md` 在兩個地方獨立寫明這件事：
#   規則四表格：「R2｜完整 D-xxx，**不設上限**｜雙 reviewer｜e2e 必要」
#   規則七表格：「設計文件**（R1）**｜120 行」
# 本檢查原先對所有 design/D-*.md 一律套 120，**比它要實作的規則更嚴**，等於用 R1 的尺去量
# R2 文件（2026-09-02 實際後果：D-020〔R2〕被判 6 倍超標並因此被移出 PR，理由是錯的）。
# 未宣告風險者按 CLAUDE.md §5「R1（中，預設）」視為 R1。
#
# R2 不設上限不代表放棄訊號：超過 R1 上限時仍印一行 ℹ 提示（**不影響 exit code**），
# 讓「文件很長＝任務可能該再拆一層」（規則七）這個判斷留在人眼前，而不是靜默消失。
RISK = re.compile(r"風險(?:等級)?[:：]\s*\*{0,2}(R[0-2])")


def risk_of(text: str) -> str:
    m = RISK.search(text)
    return m.group(1) if m else "R1"


def main():
    strict = "--strict" in sys.argv
    exempt = load_exempt()
    warns, notes, skipped = [], [], 0
    for f in ROOT.rglob("*.md"):
        # as_posix()：Windows 的 relative_to() 回 'design\\D-001.md'，用預設 str() 比對
        # 'design/D-' 永遠不匹配，整支檢查會靜默退化成 no-op（假綠）。
        rel = f.relative_to(ROOT).as_posix()
        if any(s in rel for s in SKIP):
            continue
        limit = next((v for k, v in LIMITS.items() if rel.startswith(k)), None)
        if limit is None:
            continue
        if rel in exempt:
            skipped += 1
            continue
        text = f.read_text(encoding="utf-8")
        raw = len(text.splitlines())
        is_design = rel.startswith("design/D-")
        n = content_lines(text) if is_design else raw
        if n <= limit:
            continue
        extra = f"（不含 errata；全檔 {raw} 行）" if n != raw else ""
        if is_design and risk_of(text) == "R2":
            notes.append(
                f"  ℹ {rel}: {n} 行{extra} —— R2 依 TOKEN-BUDGET 規則四不設上限，不判失敗；"
                f"但已超過 R1 的 {limit} 行，請評估規則七「任務該再拆一層」"
            )
            continue
        warns.append(f"  ! {rel}: {n} 行 > 上限 {limit}{extra} → 建議切檔或精簡")
    # task-board DONE 歸檔提醒（`\*{0,2}` 容許 `**DONE（2026-08-02）**` 這類粗體/附註寫法）
    tb = ROOT / "docs/task-board.md"
    if tb.exists():
        done = len(re.findall(r"\|\s*\*{0,2}DONE", tb.read_text(encoding="utf-8")))
        if done > 10:
            warns.append(f"  ! task-board 有 {done} 筆 DONE（>10）→ 請歸檔至 docs/task-board-archive.md")
    suffix = f"（{skipped} 份豁免）" if skipped else ""
    # ℹ 一律印出（含通過時），否則 R2 的長度訊號會在全綠的情況下靜默消失。
    if notes:
        print("\n".join(notes))
    if not warns:
        print(f"✓ 文件預算檢查通過{suffix}"); return 0
    print(f"文件預算警告{suffix}："); print("\n".join(warns))
    return 1 if strict else 0


if __name__ == "__main__":
    sys.exit(main())
