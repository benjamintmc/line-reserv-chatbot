#!/usr/bin/env bash
# 檢查最近 N 筆 commit 是否符合可追溯格式：type(D-xxx/T-xxx): 描述
# 允許無 scope 的維運型 commit：chore:/docs:/ci: 開頭。
N="${1:-20}"
pattern='^(feat|fix|refactor|test|perf)\((D-[0-9]+\/)?T-[0-9]+\): .+|^(chore|docs|ci|build)(\(.+\))?: .+|^Merge '
fail=0
while IFS= read -r line; do
  if ! echo "$line" | grep -Eq "$pattern"; then
    echo "  ✗ $line"; fail=1
  fi
done < <(git log --pretty=%s -n "$N" 2>/dev/null)
if [ "$fail" -eq 1 ]; then
  echo ""; echo "不符可追溯格式。功能型 commit 應為：feat(D-003/T-014): 描述"; exit 1
fi
echo "✓ 最近 $N 筆 commit 皆符合可追溯格式"
