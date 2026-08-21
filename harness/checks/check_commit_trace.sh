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
# GitHub squash merge 的 commit 訊息直接抄 PR 標題，結尾為 `(#N)`，scope 位置常沒有 T 編號
# （例：`feat: 分組／加開名額／多行報名（T-018/019/020/021/022） (#12)`）。這類 commit 永久留在
# 歷史裡，若一律判失敗會讓 CI 從此**永遠紅**——一個永遠紅的關卡等同沒有關卡。
# 故對 squash merge 放寬「位置」但不放寬「追溯性」：標題任一處出現 T-xxx 或 D-xxx 即通過。
squash_pattern='\(#[0-9]+\)$'
trace_id_pattern='(T|D)-[0-9]+'
fail=0
count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  count=$((count + 1))
  if echo "$line" | grep -Eq "$squash_pattern" && echo "$line" | grep -Eq "$trace_id_pattern"; then
    continue
  fi
  if ! echo "$line" | grep -Eq "$pattern"; then
    echo "  ✗ $line"; fail=1
  fi
done <<< "$subjects"
if [ "$fail" -eq 1 ]; then
  echo ""; echo "不符可追溯格式。功能型 commit 應為：feat(D-003/T-014): 描述"; exit 1
fi
echo "✓ $scope commit（共 $count 筆）皆符合可追溯格式"
