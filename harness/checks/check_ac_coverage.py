#!/usr/bin/env python3
"""AC 覆蓋檢查：所有 APPROVED 設計文件中的 Acceptance Checks 必須有對應測試標記。

用法: python3 harness/checks/check_ac_coverage.py [--test-dirs dir1 dir2 ...]
預設測試目錄: tests, test, src, app, e2e (存在者才掃)
測試標記格式: [D-001 AC-1]（大小寫不拘，允許 D-001/AC-1、D-001-AC-1）
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
DESIGN = ROOT / "design"
DEFAULT_DIRS = ["tests", "test", "src", "app", "e2e"]
TEST_EXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt", ".rb", ".cs"}

def approved_docs():
    for p in sorted(DESIGN.glob("D-*.md")):
        if "TEMPLATE" in p.name or "examples" in str(p.parent):
            continue
        text = p.read_text(encoding="utf-8")
        m = re.search(r"狀態[:：]\s*(\w+)", text)
        if m and m.group(1).upper() == "APPROVED":
            did = re.match(r"(D-\d+)", p.name).group(1)
            acs = sorted(set(re.findall(r"\bAC-(\d+)", text)), key=int)
            yield did, [f"AC-{n}" for n in acs], p.name

def collect_markers(dirs):
    pat = re.compile(r"(D-\d+)[\s/\-_]*(AC-\d+)", re.I)
    found = set()
    for d in dirs:
        base = ROOT / d
        if not base.is_dir():
            continue
        for f in base.rglob("*"):
            if f.suffix in TEST_EXT and ("test" in f.name.lower() or "spec" in f.name.lower()):
                try:
                    for m in pat.finditer(f.read_text(encoding="utf-8", errors="ignore")):
                        found.add((m.group(1).upper(), m.group(2).upper()))
                except OSError:
                    pass
    return found

def main():
    dirs = sys.argv[sys.argv.index("--test-dirs")+1:] if "--test-dirs" in sys.argv else DEFAULT_DIRS
    markers = collect_markers(dirs)
    missing, total = [], 0
    for did, acs, fname in approved_docs():
        for ac in acs:
            total += 1
            if (did, ac) not in markers:
                missing.append(f"  ✗ {did} {ac}  （{fname}）")
    if total == 0:
        print("沒有 APPROVED 設計文件或其中沒有 AC，略過。"); return 0
    print(f"AC 覆蓋：{total - len(missing)}/{total}")
    if missing:
        print("缺少對應測試標記："); print("\n".join(missing))
        print("\n請在測試中加入標記，例：test(\"[D-001 AC-1] ...\", ...)")
        return 1
    print("✓ 全部 AC 皆有對應測試標記"); return 0

if __name__ == "__main__":
    sys.exit(main())
