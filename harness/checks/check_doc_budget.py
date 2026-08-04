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


def main():
    strict = "--strict" in sys.argv
    exempt = load_exempt()
    warns, skipped = [], 0
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
        n = len(f.read_text(encoding="utf-8").splitlines())
        if n > limit:
            warns.append(f"  ! {rel}: {n} 行 > 上限 {limit} → 建議切檔或精簡")
    # task-board DONE 歸檔提醒（`\*{0,2}` 容許 `**DONE（2026-08-02）**` 這類粗體/附註寫法）
    tb = ROOT / "docs/task-board.md"
    if tb.exists():
        done = len(re.findall(r"\|\s*\*{0,2}DONE", tb.read_text(encoding="utf-8")))
        if done > 10:
            warns.append(f"  ! task-board 有 {done} 筆 DONE（>10）→ 請歸檔至 docs/task-board-archive.md")
    suffix = f"（{skipped} 份豁免）" if skipped else ""
    if not warns:
        print(f"✓ 文件預算檢查通過{suffix}"); return 0
    print(f"文件預算警告{suffix}："); print("\n".join(warns))
    return 1 if strict else 0


if __name__ == "__main__":
    sys.exit(main())
