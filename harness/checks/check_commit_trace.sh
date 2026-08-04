#!/usr/bin/env bash
# 檢查 commit 是否符合可追溯格式：type(D-xxx/T-xxx): 描述
# 允許無 scope 的維運型 commit：chore:/docs:/ci: 開頭。
#
# 用法：
#   check_commit_trace.sh [N]              檢查最近 N 筆（預設 20）
#   check_commit_trace.sh --since <date>   只檢查該日期之後的 commit
#
# --since 供 CI 使用：可追溯格式自 harness 導入日 2026-08-05 起生效（CLAUDE.md §4.5），
# 更早的歷史不符新格式屬預期，不應讓 CI 全紅。
#
# 日期務必帶時區（如 2026-08-05T00:00:00+08:00）：git 把裸日期當 UTC 解讀，
# 於 +08:00 會把當天 08:00 前的 commit 全部排除在外（實測會靜默漏掉當日的 commit）。
if [ "${1:-}" = "--since" ]; then
  SINCE="${2:?用法: check_commit_trace.sh --since <date>（建議帶時區）}"
  subjects=$(git log --pretty=%s --since="$SINCE" 2>/dev/null)
  scope="自 $SINCE 起"
else
  N="${1:-20}"
  subjects=$(git log --pretty=%s -n "$N" 2>/dev/null)
  scope="最近 $N 筆"
fi
pattern='^(feat|fix|refactor|test|perf)\((D-[0-9]+\/)?T-[0-9]+\): .+|^(chore|docs|ci|build)(\(.+\))?: .+|^Merge '
fail=0
count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  count=$((count + 1))
  if ! echo "$line" | grep -Eq "$pattern"; then
    echo "  ✗ $line"; fail=1
  fi
done <<< "$subjects"
if [ "$fail" -eq 1 ]; then
  echo ""; echo "不符可追溯格式。功能型 commit 應為：feat(D-003/T-014): 描述"; exit 1
fi
echo "✓ $scope commit（共 $count 筆）皆符合可追溯格式"
