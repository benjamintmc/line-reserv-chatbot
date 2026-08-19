import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../db/__tests__/test-db';
import { EventService } from './event-service';

/**
 * D-013 §3（(N2) 精確收斂）與 G2/G6 的靜態＋行為驗收。
 * 靜態掃描存在的理由：`'create'` 死碼與「只以 line_user_id 查詢」的殘留無法用一般行為測試證明**不存在**
 * （AC-5③/AC-6 明載須以全庫掃描核對，且測試檔不受 `tsc` 檢查）。
 */
const SRC = join(__dirname, '..');
const HOST = 'U-host';
const G = 'G-1';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 去掉 // 與 /* *\/ 註解，避免說明文字被當成 SQL 掃描。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 取 `needle(` 之後至配對右括號為止的引數字串（可跨行；處理巢狀括號）。 */
function callArgs(src: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf(needle, from);
    if (i === -1) return out;
    let depth = 0;
    let j = i + needle.length - 1; // 指向 '('
    for (; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i + needle.length, j));
    from = j;
  }
}

describe('D-013 (N2) 收斂與查詢鍵掃描', () => {
  const files = tsFiles(SRC);

  it('[D-013 AC-5] `create` 分支徹底移除：無告知句、無死參數、錯誤推理不留在碼裡', () => {
    // ③ grep 範圍限 src/（程式碼＋測試）；design/ 與 docs/ 不歸本任務所有，刻意不掃。
    // 需求字串以拼接構成，避免本檔自身成為命中來源。
    const gone = '已放棄' + '你先前未完成的開團';
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(gone));
    expect(hits).toEqual([]);

    const svc = readFileSync(join(SRC, 'domain', 'event-service.ts'), 'utf8');
    // ① AbandonedKind 不再含 'create'。
    expect(svc).toContain("export type AbandonedKind = 'grouping';");
    // ④ detectAbandoned 的 groupId 死參數已移除，且 body 逐字為 D-013 §3 所載語意。
    expect(svc).toContain(
      'private detectAbandoned(prev: ConversationStateRow | undefined): AbandonedKind | undefined {',
    );
    expect(svc).toContain("return prev?.state === GROUPING_STATE ? 'grouping' : undefined;");
    // ② doc-comment 不得續留舊的錯誤理由（D-013 §3 已判定其為誤），且須寫出正確的「構造性」理由。
    expect(svc).not.toContain('該情形 handler 已攔截為流程答案');
    expect(svc).toContain('構造性');

    const fmt = readFileSync(join(SRC, 'domain', 'event-formatter.ts'), 'utf8');
    // ② withAbandonedNotice 去參數（字面型別 'create' | 'grouping' 一併消失），註解不再述「別群開團」。
    expect(fmt).toContain('export function withAbandonedNotice(base: MessageDescriptor): MessageDescriptor {');
    expect(fmt).not.toContain("'create'");
    expect(fmt).not.toContain('別群開團');
  });

  it('[D-013 AC-6] 無殘留單鍵查詢：repository SQL 皆帶 group_id、無自拼 SQL、呼叫點皆雙參數', () => {
    const repoPath = join(SRC, 'db', 'repositories', 'conversation-repository.ts');
    const repo = readFileSync(repoPath, 'utf8');
    // 簽名為 (groupId, lineUserId)，ConversationReader 同步。
    expect(repo).toContain('get(groupId: string, lineUserId: string)');
    expect(repo).toContain('delete(groupId: string, lineUserId: string)');
    expect(repo).toContain('ON CONFLICT (group_id, line_user_id)');
    // G6：UpsertConversationInput.groupId 不得再允許 null。
    expect(repo).not.toMatch(/groupId:\s*string\s*\|\s*null/);
    // 本表每一段 SQL 都必須帶 group_id（讀/寫/刪皆然）。註解先剝除，避免說明文字混入。
    const sqlChunks = stripComments(repo)
      .split(/[`']/)
      .filter((x) => x.includes('conversation_states'));
    expect(sqlChunks).toHaveLength(3); // upsert / get / delete
    for (const stmt of sqlChunks) expect(stmt).toContain('group_id');

    // G2：domain/handler 等非測試碼不得自拼本表 SQL 繞過 repository。
    for (const f of files) {
      if (f === repoPath || f.endsWith('.test.ts') || f.includes('__tests__')) continue;
      expect(readFileSync(f, 'utf8')).not.toMatch(/(FROM|INTO|UPDATE|TABLE)\s+conversation_states/);
    }

    // 所有呼叫點（**含測試檔**——測試不受 tsc 檢查）皆須帶兩個引數。
    for (const f of files) {
      if (f.endsWith('d013-conversation-scope.test.ts')) continue; // 本檔的 needle 字面值非呼叫點
      const src = readFileSync(f, 'utf8');
      for (const needle of ['conversations.get(', 'conversations.delete(']) {
        for (const args of callArgs(src, needle)) {
          // 被斷言者必須「只有引數字串」——舊寫法把絕對路徑併進待測字串，
          // repo 路徑一旦含逗號即無條件通過（假綠，architect nit-1）。
          // 失敗訊息改走 vitest 第二引數，不污染斷言標的。
          expect(args, `${f} → ${needle}${args})`).toContain(',');
        }
      }
    }
  });
});

describe('D-013 (N2) 並發行為', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('[D-013 AC-5] 同群無 grouping session 時，並發雙「開團」（Promise.all）不得出現任何告知句', async () => {
    const svc = new EventService({
      events: t.events,
      users: t.users,
      conversations: t.conversations,
      runInTransaction: t.runInTransaction,
      superAdminUserIds: [HOST],
      logError: () => {},
    });
    // server.ts 以 Promise.all 並行處理同一 webhook body 的多個事件 ⇒ 兩則 `開團` 可同時通過 handler 攔截。
    const [r1, r2] = await Promise.all([
      svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 'p1' }),
      svc.startCreation({ groupId: G, executorLineUserId: HOST, messageId: 'p2' }),
    ]);
    expect(r1.kind).toBe('flow_started');
    expect(r2.kind).toBe('flow_started');
    expect(r1.kind === 'flow_started' ? r1.abandoned : 'x').toBeUndefined();
    expect(r2.kind === 'flow_started' ? r2.abandoned : 'x').toBeUndefined();
    // 同一 (群, 人) 仍只有一列。
    const cnt = await t.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM conversation_states WHERE group_id = $1 AND line_user_id = $2',
      [G, HOST],
    );
    expect(Number(cnt.rows[0]!.n)).toBe(1);
  });
});
