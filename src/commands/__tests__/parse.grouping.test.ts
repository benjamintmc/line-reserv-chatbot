import { describe, it, expect } from 'vitest';
import { parseCommand } from '../parse';

describe('D-011 §1 分組指令解析', () => {
  it('[D-011 AC-16] 分組 ２場 ５輪（全形）→ rounds/courts=2/rounds=5/mode=doubles', () => {
    const cmd = parseCommand('分組 ２場 ５輪');
    expect(cmd).toEqual({ type: 'group', strategy: 'rounds', mode: 'doubles', courts: 2, rounds: 5 });
  });

  it('[D-011 AC-16] 分組 0場 / 超上限 → invalid(group, group_bad_args)', () => {
    expect(parseCommand('分組 0場')).toEqual({
      type: 'invalid',
      command: 'group',
      reason: 'group_bad_args',
      raw: '分組 0場',
    });
    expect(parseCommand('分組 99場').type).toBe('invalid');
  });

  it('[D-011 AC-17] 分組 ２場 ５輪 單打（全形）→ mode=singles/courts=2/rounds=5', () => {
    const cmd = parseCommand('分組 ２場 ５輪 單打');
    expect(cmd).toEqual({ type: 'group', strategy: 'rounds', mode: 'singles', courts: 2, rounds: 5 });
  });

  it('分組（無參數）→ strategy=balanced、mode=doubles', () => {
    expect(parseCommand('分組')).toEqual({ type: 'group', strategy: 'balanced', mode: 'doubles' });
  });

  it('分組 2場（未帶輪）→ rounds、courts=2、rounds 未帶', () => {
    expect(parseCommand('分組 2場')).toEqual({
      type: 'group',
      strategy: 'rounds',
      mode: 'doubles',
      courts: 2,
    });
  });

  it('分組 單打（未帶場）→ rounds、mode=singles、courts 未帶（service 以 floor(N/2) 預設）', () => {
    expect(parseCommand('分組 單打')).toEqual({
      type: 'group',
      strategy: 'rounds',
      mode: 'singles',
    });
  });

  it('下一輪 → group_next', () => {
    expect(parseCommand('下一輪')).toEqual({ type: 'group_next' });
  });

  it('分組 abc（無法辨識 token）→ invalid(group_bad_args)', () => {
    expect(parseCommand('分組 abc').type).toBe('invalid');
  });
});
