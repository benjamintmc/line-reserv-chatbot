import { describe, it, expect } from 'vitest';
import { buildModel, renderHtml, formatValue, TARGET_METRICS } from './report';

/**
 * 指標 dashboard 的呈現邏輯。這裡驗的**不是 SQL**（那由 D-018 AC-9 對真 PG 覆蓋），
 * 而是「數字有沒有接對指標」與「算不出來時會不會靜默顯示成 0」——後者是這種報表最容易
 * 出的錯：一個假的 0 看起來就像「還沒成長」，不像壞掉。
 */

const FULL = {
  real_users: 120,
  events_created: 12,
  repeat_hosts: 10,
  returning_pct: '35.5', // pg 對 numeric 回傳字串。
  groups_organic_est: 3,
  groups_reached: 9,
  groups_activated: 4,
};

const OPTS = { selfLineUserIdProvided: true };

function byKey(model: ReturnType<typeof buildModel>, key: string) {
  return [...model.targets, ...model.context].find((m) => m.key === key);
}

describe('指標 dashboard 呈現模型', () => {
  it('五項目標指標各自接到正確欄位，並算出達成率', () => {
    const model = buildModel(FULL, OPTS);
    expect(model.targets.map((m) => m.key)).toEqual(TARGET_METRICS.map((s) => s.key));

    expect(byKey(model, 'real_users')?.value).toBe(120);
    expect(byKey(model, 'real_users')?.pct).toBe(120);
    expect(byKey(model, 'events_created')?.pct).toBe(40); // 12 / 30
    expect(byKey(model, 'returning_pct')?.value).toBe(35.5); // 字串已正規化為數字
  });

  it('達標與未達標分得開（達成率 100% 為分界）', () => {
    const model = buildModel(FULL, OPTS);
    expect(byKey(model, 'real_users')?.reached).toBe(true); // 120 / 100
    expect(byKey(model, 'repeat_hosts')?.reached).toBe(true); // 10 / 10 恰好達標
    expect(byKey(model, 'events_created')?.reached).toBe(false);
    expect(byKey(model, 'returning_pct')?.reached).toBe(false); // 35.5% < 40%
  });

  it('「加了卻沒用」為衍生值：觸及數減去開過團的群數', () => {
    const model = buildModel(FULL, OPTS);
    expect(byKey(model, 'groups_dormant')?.value).toBe(5); // 9 - 4
  });

  it('缺少我的 LINE userId 時，擴散群組標為算不出來而非顯示錯誤數字', () => {
    const model = buildModel(FULL, { selfLineUserIdProvided: false });
    const m = byKey(model, 'groups_organic_est');
    // 硬跑會把所有群組都算成「非我建立」而灌水，寧可空白也不給錯的數字。
    expect(m?.value).toBeNull();
    expect(m?.unavailableReason).toContain('LINE userId');
  });

  it('欄位不存在（metrics.md 改名）時標為算不出來，不得靜默顯示 0', () => {
    const model = buildModel({ real_users: 5 }, OPTS);
    const missing = byKey(model, 'events_created');
    expect(missing?.value).toBeNull();
    expect(missing?.unavailableReason).toContain('events_created');
    // 對比：真的查到 0 就顯示 0，兩者不可混淆。
    expect(byKey(buildModel({ ...FULL, events_created: 0 }, OPTS), 'events_created')?.value).toBe(0);
  });

  it('回訪率查得到但為 null（一個使用者都沒有）時顯示 0%，不是算不出來', () => {
    const model = buildModel({ ...FULL, returning_pct: null }, OPTS);
    const m = byKey(model, 'returning_pct');
    expect(m?.value).toBe(0);
    expect(m?.unavailableReason).toBeUndefined();
    expect(formatValue(m!)).toBe('0%');
  });
});

describe('指標 dashboard HTML', () => {
  it('自足：不引用任何外部資源，也不含連線字串', () => {
    const html = renderHtml(buildModel(FULL, OPTS), {
      generatedAt: '2026年8月28日 下午5:00',
      source: 'ep-xxx.neon.tech/golf',
    });
    expect(html).not.toMatch(/<script|https?:\/\/|<link/);
    expect(html).not.toContain('password');
    expect(html).toContain('ep-xxx.neon.tech/golf');
  });

  it('推估值與達標狀態都帶文字標籤，不單靠顏色表達', () => {
    const html = renderHtml(buildModel(FULL, OPTS), { generatedAt: 't', source: 's' });
    expect(html).toContain('推估值');
    expect(html).toContain('已達標');
  });

  it('表格檢視涵蓋每一項指標（含脈絡數字）', () => {
    const model = buildModel(FULL, OPTS);
    const html = renderHtml(model, { generatedAt: 't', source: 's' });
    for (const m of [...model.targets, ...model.context]) {
      expect(html).toContain(m.label);
    }
  });

  it('外部字串一律跳脫，避免群組名稱之類的內容破壞版面', () => {
    const html = renderHtml(buildModel(FULL, OPTS), {
      generatedAt: 't',
      source: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
