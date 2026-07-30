import { describe, it, expect } from 'vitest';
import type { RegistrationRow } from '../db/schema';
import { buildRoster } from './roster';

/** 測試用最小 RegistrationRow 工廠。 */
function mkRow(over: Partial<RegistrationRow> & { id: number; owner_user_id: number; display_name: string; seq: number }): RegistrationRow {
  return {
    id: over.id,
    event_id: over.event_id ?? 1,
    owner_user_id: over.owner_user_id,
    display_name: over.display_name,
    kind: over.kind ?? 'self',
    status: over.status ?? 'confirmed',
    seq: over.seq,
    cancelled_at: over.cancelled_at ?? null,
    cancelled_by_user_id: over.cancelled_by_user_id ?? null,
    created_at: over.created_at ?? '2026-08-01T00:00:00Z',
  };
}

describe('buildRoster（名字後綴與序號）', () => {
  it('[D-003 AC-1] 同一人多名額依序加後綴、整體序號 1-based', () => {
    const rows = [
      mkRow({ id: 1, owner_user_id: 10, display_name: '王小明', seq: 1 }),
      mkRow({ id: 2, owner_user_id: 10, display_name: '王小明', seq: 2 }),
      mkRow({ id: 3, owner_user_id: 10, display_name: '王小明', seq: 3 }),
    ];
    expect(buildRoster(rows)).toEqual([
      { index: 1, label: '王小明', row: rows[0] },
      { index: 2, label: '王小明(2)', row: rows[1] },
      { index: 3, label: '王小明(3)', row: rows[2] },
    ]);
  });

  it('[D-003 AC-13] 分組鍵含 owner：兩位不同 owner 同顯示名各自不加後綴', () => {
    const rows = [
      mkRow({ id: 1, owner_user_id: 10, display_name: '陳大哥', seq: 1 }),
      mkRow({ id: 2, owner_user_id: 20, display_name: '陳大哥', seq: 2 }),
    ];
    expect(buildRoster(rows).map((e) => e.label)).toEqual(['陳大哥', '陳大哥']);
  });

  it('[D-003 AC-13] 同一 owner 代報同名多列依此加後綴', () => {
    const rows = [
      mkRow({ id: 1, owner_user_id: 10, display_name: '陳大哥', kind: 'proxy', seq: 5 }),
      mkRow({ id: 2, owner_user_id: 10, display_name: '陳大哥', kind: 'proxy', seq: 6 }),
    ];
    expect(buildRoster(rows).map((e) => e.label)).toEqual(['陳大哥', '陳大哥(2)']);
  });

  it('[D-003 AC-1] 未排序輸入亦依 seq 升冪渲染', () => {
    const rows = [
      mkRow({ id: 3, owner_user_id: 10, display_name: '王小明', seq: 3 }),
      mkRow({ id: 1, owner_user_id: 10, display_name: '王小明', seq: 1 }),
      mkRow({ id: 2, owner_user_id: 10, display_name: '王小明', seq: 2 }),
    ];
    expect(buildRoster(rows).map((e) => `${e.index}. ${e.label}`)).toEqual([
      '1. 王小明',
      '2. 王小明(2)',
      '3. 王小明(3)',
    ]);
  });
});
