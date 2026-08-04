#!/usr/bin/env python3
"""文件預算檢查：超過行數上限的文件應切檔，避免載入成本膨脹。
用法: python3 harness/checks/check_doc_budget.py [--strict]
--strict 時超標即 exit 1；預設僅警告（exit 0）。
"""
import sys, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIMITS = {
    "design/D-": 120,
    "docs/01-architecture": 300,
    "docs/02-api-contract.md": 300,
    "docs/task-board.md": 80,
    "CLAUDE.md": 150,
}
SKIP = ("examples/", "archive", "TEMPLATE", "handoffs/")

def main():
    strict = "--strict" in sys.argv
    warns = []
    for f in ROOT.rglob("*.md"):
        rel = str(f.relative_to(ROOT))
        if any(s in rel for s in SKIP):
            continue
        limit = next((v for k, v in LIMITS.items() if rel.startswith(k)), None)
        if limit is None:
            continue
        n = len(f.read_text(encoding="utf-8").splitlines())
        if n > limit:
            warns.append(f"  ! {rel}: {n} 行 > 上限 {limit} → 建議切檔或精簡")
    # task-board DONE 歸檔提醒
    tb = ROOT / "docs/task-board.md"
    if tb.exists():
        done = len(re.findall(r"\|\s*DONE\s*\|", tb.read_text(encoding="utf-8")))
        if done > 10:
            warns.append(f"  ! task-board 有 {done} 筆 DONE（>10）→ 請歸檔至 docs/task-board-archive.md")
    if not warns:
        print("✓ 文件預算檢查通過"); return 0
    print("文件預算警告："); print("\n".join(warns))
    return 1 if strict else 0

if __name__ == "__main__":
    sys.exit(main())
