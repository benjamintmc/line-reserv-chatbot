#!/usr/bin/env python3
"""看板同步檢查：
1. worklist 中的「狀態提議」是否都已被 Orchestrator 在 task-board 裁定（避免提議被遺忘）。
2. worklist 佇列中的任務 ID 是否都存在於 task-board（避免幽靈任務）。
用法: python3 harness/checks/check_board_sync.py
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
BOARD = ROOT / "docs/task-board.md"
WL = ROOT / "docs/worklists"

def main():
    if not BOARD.exists():
        print("找不到 task-board.md"); return 1
    board = BOARD.read_text(encoding="utf-8")
    board_ids = set(re.findall(r"\b(T-\d+)\b", board))
    issues = []
    for f in sorted(WL.glob("*.md")):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8")
        # 提議段落
        m = re.search(r"## 狀態提議.*?(?=\n## |\Z)", text, re.S)
        if m:
            for tid, target in re.findall(r"\|\s*(T-\d+)\s*\|\s*(?:PROPOSE\s*→\s*)?(\w+)", m.group(0)):
                # 檢查 board 上該任務是否已是該狀態
                row = re.search(rf"\|[^\n]*\b{tid}\b[^\n]*\|", board)
                if row and target.upper() not in row.group(0).upper():
                    issues.append(f"  ! {f.name}: {tid} 提議 → {target}，但 task-board 尚未裁定")
        for tid in set(re.findall(r"\b(T-\d+)\b", text)):
            if tid not in board_ids:
                issues.append(f"  ! {f.name}: {tid} 不存在於 task-board（幽靈任務）")
    if not issues:
        print("✓ worklist 與 task-board 同步"); return 0
    print("同步問題："); print("\n".join(sorted(set(issues))))
    return 1

if __name__ == "__main__":
    sys.exit(main())
