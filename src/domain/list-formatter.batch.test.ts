import { describe, it, expect } from 'vitest';
import { formatBatchSummary, type BatchSummaryItem } from './list-formatter';

// D-012 §一.3 / 裁決 #1（使用者裁決 2026-08-18：改實作、不改設計）：
// 批次摘要**依類別聚合**——報名一行「已報名：{名字、名字…}」、取消一行「已取消：{名字、名字…}」，
// 落候補者**各自**於名字後標「（候補）」。用語沿用既有「正取/候補」，不新增第二種措辭。

describe('formatBatchSummary（D-012 §一.3 聚合摘要）', () => {
  it('[D-012 AC-1] 多筆報名聚合為一行「已報名：陳小姐、張先生」（非逐項各一行）', () => {
    const items: BatchSummaryItem[] = [
      { kind: 'signup', subjectDisplayName: '陳小姐', waitlisted: false },
      { kind: 'signup', subjectDisplayName: '張先生', waitlisted: false },
    ];
    expect(formatBatchSummary(items).text).toBe('已報名：陳小姐、張先生');
  });

  it('[D-012 AC-5] 落候補者各自標「（候補）」，仍聚合於同一行', () => {
    const items: BatchSummaryItem[] = [
      { kind: 'signup', subjectDisplayName: '陳小姐', waitlisted: false },
      { kind: 'signup', subjectDisplayName: '張先生', waitlisted: true },
    ];
    expect(formatBatchSummary(items).text).toBe('已報名：陳小姐、張先生（候補）');
  });

  it('[D-012 AC-6] 多筆取消聚合為一行「已取消：A、B」', () => {
    const items: BatchSummaryItem[] = [
      { kind: 'cancel', subjectDisplayName: 'A' },
      { kind: 'cancel', subjectDisplayName: 'B' },
    ];
    expect(formatBatchSummary(items).text).toBe('已取消：A、B');
  });

  it('[D-012 AC-3] 報名 + 取消混合 → 兩行（報名行在前、取消行在後），順序沿用執行順序', () => {
    const items: BatchSummaryItem[] = [
      { kind: 'signup', subjectDisplayName: 'A', waitlisted: false },
      { kind: 'cancel', subjectDisplayName: 'B' },
      { kind: 'signup', subjectDisplayName: 'C', waitlisted: true },
    ];
    expect(formatBatchSummary(items).text).toBe('已報名：A、C（候補）\n已取消：B');
  });

  it('單筆維持既有字串（零回歸）、無 mention', () => {
    const one = formatBatchSummary([
      { kind: 'signup', subjectDisplayName: '阿明', waitlisted: false },
    ]);
    expect(one.text).toBe('已報名：阿明');
    expect(one.mentionees).toHaveLength(0);
    expect(formatBatchSummary([]).text).toBe('');
  });
});
