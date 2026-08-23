import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * D-014／D-016 中「以設定與文件為落點」的 AC——無法由執行期行為斷言，
 * 改以釘住檔案內容防止回退（同 `d013-docs.test.ts` 的既有做法）。
 */
const root = resolve(__dirname, '..', '..');
const read = (...seg: string[]): string => readFileSync(resolve(root, ...seg), 'utf8');

describe('D-014 / D-016 設定與文件落點', () => {
  it('[D-014 AC-5] 四條回歸關卡指令俱在（lint/build/test/harness:check）', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const s of ['lint', 'build', 'test', 'harness:check']) {
      expect(pkg.scripts[s], `package.json 缺少 script: ${s}`).toBeTruthy();
    }
  });

  it('[D-014 AC-6] runbook 附錄記錄 T-027 部署 revision 與 /health 驗證', () => {
    const rb = read('docs', 'deployment-runbook.md');
    expect(rb).toContain('golf-reserv-chatbot-00005-89q');
    expect(rb).toContain('/health');
  });

  it('[D-014 AC-7] runbook 附錄記錄 cold start log 已無 pg SSL 別名警告', () => {
    const rb = read('docs', 'deployment-runbook.md');
    expect(rb).toMatch(/不再出現.*SSL 別名警告|已無 pg SSL 別名警告/);
  });

  it('[D-016 AC-5] production 下 DEBUG_WEBHOOK 被強制關閉（fail-safe）', () => {
    const cfg = read('src', 'config.ts');
    expect(cfg).toMatch(/process\.env\.NODE_ENV !== 'production'/);
    // Dockerfile 的 runtime 階段必須實際設 production，fail-safe 才會在 PROD 生效。
    expect(read('Dockerfile')).toContain('ENV NODE_ENV=production');
  });

  it('[D-016 AC-6] runbook 部署段以 --set-secrets 帶憑證，不再用 --set-env-vars 帶明文', () => {
    const rb = read('docs', 'deployment-runbook.md');
    expect(rb).toContain('--set-secrets=');
    // ADMIN_USER_IDS 非憑證、仍走 env var；三個憑證不得出現在 set-env-vars 內。
    const envVarLines = rb.split('\n').filter((l) => l.includes('--set-env-vars'));
    for (const l of envVarLines) {
      expect(l).not.toContain('LINE_CHANNEL_ACCESS_TOKEN=');
      expect(l).not.toContain('LINE_CHANNEL_SECRET=');
      expect(l).not.toMatch(/DATABASE_URL=(?!database-url)/);
    }
    // 輪替程序（M2 明確要求）必須存在。
    expect(rb).toContain('憑證輪替程序');
  });

  it('[D-016 AC-7] runbook 記錄 max-instances 帳單天花板與 401 告警', () => {
    const rb = read('docs', 'deployment-runbook.md');
    expect(rb).toContain('--max-instances=3');
    expect(rb).toContain('webhook 驗簽失敗異常');
  });

  it('[D-016 AC-8] .env.example 標明 verify-full 與 DEBUG_WEBHOOK 的 production 行為', () => {
    const env = read('.env.example');
    expect(env).toContain('sslmode=verify-full');
    expect(env).toMatch(/NODE_ENV=production/);
  });
});
