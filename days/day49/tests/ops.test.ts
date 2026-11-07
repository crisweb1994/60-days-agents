import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const pr = await loadTarget<typeof import('../solution/prompt-registry.ts')>(import.meta.url, 'prompt-registry.ts');
const { openPromptRegistry, versionId } = pr;
const ro = await loadTarget<typeof import('../solution/rollout.ts')>(import.meta.url, 'rollout.ts');
const { bucket, chooseVariant, canary, compareRates, normalCdf } = ro;
const me = await loadTarget<typeof import('../solution/metrics.ts')>(import.meta.url, 'metrics.ts');
const { createMetrics, evaluateAlerts, sendWebhook, DEFAULT_RULES } = me;
const fb = await loadTarget<typeof import('../solution/feedback.ts')>(import.meta.url, 'feedback.ts');
const { feedbackToCase, feedbackCaseId, appendCases, createMemoryFeedbackStore, handleFeedback, ratingStats } = fb;
const { parseDataset, validateDataset } = await loadTarget<typeof import('../solution/eval/dataset.ts')>(import.meta.url, 'eval/dataset.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { RESEARCH_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const tmp = () => mkdtemp(join(tmpdir(), 'day49-'));
type Feedback = import('../solution/feedback.ts').Feedback;
const feedback = (over: Partial<Feedback> = {}): Feedback => ({
  runId: 'r1',
  userId: 'u1',
  rating: 'down',
  comment: '端口说错了，我的电话 13812345678',
  question: '潮汐协议 3.0 的默认端口是多少？',
  answer: '默认端口是 8443 [1]。',
  sources: ['https://tide.example/forum.html'],
  promptVersion: 'research@1a2b3c4d',
  variant: 'canary',
  createdAt: '2026-11-07T00:00:00Z',
  ...over,
});

describe('第 49 天：prompt 的版本（TODO 1）', () => {
  test('发布：内容一样就是同一版；标签上线、回滚；重新打开还在', async () => {
    const file = join(await tmp(), 'prompts.json');
    const registry = await openPromptRegistry(file, () => new Date('2026-11-07T00:00:00Z'));
    const v1 = await registry.publish('research', `  ${RESEARCH_PROMPT}  `, '第 15 天的版本');
    expect(v1).toEqual({ id: versionId('research', RESEARCH_PROMPT.trim()), name: 'research', content: RESEARCH_PROMPT.trim(), note: '第 15 天的版本', createdAt: '2026-11-07T00:00:00.000Z' });
    expect(v1.id).toMatch(/^research@[0-9a-f]{8}$/);
    expect(await registry.publish('research', RESEARCH_PROMPT), '内容一样不重复记').toEqual(v1);
    const v2 = await registry.publish('research', `${RESEARCH_PROMPT}\n- 不确定的时候说不确定`, '加一条');
    expect(registry.history('research').map((v) => v.id)).toEqual([v2.id, v1.id]);
    expect(registry.get('research'), '还没上线').toBeUndefined();
    await registry.setLabel('research', 'production', v1.id);
    await registry.setLabel('research', 'production', v2.id);
    await registry.setLabel('research', 'production', v2.id);
    await registry.setLabel('research', 'canary', v2.id);
    expect(registry.get('research')?.id).toBe(v2.id);
    expect((await registry.rollback('research')).id).toBe(v1.id);
    expect(registry.get('research')?.id).toBe(v1.id);
    expect(registry.get('research', 'canary')?.id, '回滚只动这一个标签').toBe(v2.id);
    await expect(registry.rollback('research'), '没有可以退回的').rejects.toThrow('没有可以退回的版本');
    await expect(registry.setLabel('research', 'production', 'report@00000000')).rejects.toThrow();
    const reopened = await openPromptRegistry(file);
    expect(reopened.get('research')?.id).toBe(v1.id);
    expect(reopened.byId(v2.id)?.note).toBe('加一条');
  });
});

describe('第 49 天：灰度和 A/B（TODO 2、6）', () => {
  test('bucket：同一个人永远同一个桶；不同实验互相独立；分布大致均匀', () => {
    expect(bucket('alice', 'exp-1')).toBe(bucket('alice', 'exp-1'));
    const users = Array.from({ length: 2000 }, (_, i) => `user-${i}`);
    const counts = new Array(10).fill(0);
    for (const u of users) counts[Math.floor(bucket(u, 'exp-1') / 10)]++;
    expect(Math.min(...counts)).toBeGreaterThan(140);
    expect(Math.max(...counts)).toBeLessThan(260);
    const same = users.filter((u) => bucket(u, 'exp-1') < 50 === bucket(u, 'exp-2') < 50).length;
    expect(same / users.length, '两个实验的分组没有关联').toBeGreaterThan(0.4);
    expect(same / users.length).toBeLessThan(0.6);
  });

  test('chooseVariant 和 canary', () => {
    const exp = canary('prompt-v2', 10, 'research@aaaa', 'research@bbbb');
    expect(exp.variants.map((v) => [v.name, v.weight])).toEqual([
      ['canary', 10],
      ['stable', 90],
    ]);
    const users = Array.from({ length: 2000 }, (_, i) => `u${i}`);
    const inCanary = users.filter((u) => chooseVariant(exp, u).name === 'canary');
    expect(inCanary.length / users.length).toBeGreaterThan(0.07);
    expect(inCanary.length / users.length).toBeLessThan(0.13);
    expect(inCanary.every((u) => bucket(u, 'prompt-v2') < 10)).toBe(true);
    expect(chooseVariant(exp, 'u1'), '同一个人每次一样').toEqual(chooseVariant(exp, 'u1'));
    expect(() => chooseVariant({ name: 'bad', variants: [{ name: 'a', weight: 60, value: 1 }] }, 'u')).toThrow('应该是 100');
  });

  test('compareRates：样本不够、没有显著差别、显著更好', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(compareRates({ successes: 9, total: 10 }, { successes: 2, total: 10 }).verdict).toBe('样本不够');
    const close = compareRates({ successes: 700, total: 1000 }, { successes: 715, total: 1000 });
    expect(close.verdict).toBe('没有显著差别');
    expect(close.pValue).toBeGreaterThan(0.05);
    const better = compareRates({ successes: 700, total: 1000 }, { successes: 780, total: 1000 });
    expect(better.verdict).toBe('B 更好');
    expect(better.diff).toBeCloseTo(0.08, 6);
    expect(better.pValue).toBeLessThan(0.001);
    expect(compareRates({ successes: 780, total: 1000 }, { successes: 700, total: 1000 }).verdict).toBe('A 更好');
    expect(compareRates({ successes: 200, total: 200 }, { successes: 200, total: 200 })).toMatchObject({ verdict: '没有显著差别', pValue: 1 });
  });
});

describe('第 49 天：监控和告警（TODO 3、4）', () => {
  test('滑动窗口：错误率、p50、p95、每小时花费；过期的不算；按变体分开', () => {
    let now = 0;
    const m = createMetrics({ windowMs: 60_000, now: () => now });
    for (let i = 1; i <= 20; i++) m.record({ ok: i % 10 !== 0, latencyMs: i * 100, cost: 0.01, variant: i % 2 ? 'a' : 'b' });
    expect(m.snapshot()).toEqual({ count: 20, errorRate: 0.1, p50Ms: 1000, p95Ms: 1900, costPerHour: expect.closeTo(0.2 * 60, 6) });
    expect(m.snapshot('b').count).toBe(10);
    expect(m.snapshot('b').errorRate, '10 和 20 都在 b 组').toBe(0.2);
    now = 61_000;
    expect(m.snapshot()).toEqual({ count: 0, errorRate: 0, p50Ms: 0, p95Ms: 0, costPerHour: 0 });
  });

  test('evaluateAlerts：样本少不告警；超了告警一次，冷却期内不再告；恢复时发一条', () => {
    const state = new Map();
    const rules = [{ name: 'errors', metric: 'errorRate' as const, op: '>' as const, threshold: 0.05, minCount: 20, cooldownMs: 600_000 }];
    const snap = (count: number, errorRate: number) => ({ count, errorRate, p50Ms: 0, p95Ms: 0, costPerHour: 0 });
    expect(evaluateAlerts(snap(5, 0.6), rules, state, 0), '半夜只有 5 个请求').toEqual([]);
    expect(evaluateAlerts(snap(40, 0.125), rules, state, 1000)).toEqual([{ rule: 'errors', status: 'firing', value: 0.125, threshold: 0.05, message: '错误率 12.5%，超过了 5.0%' }]);
    expect(evaluateAlerts(snap(40, 0.2), rules, state, 60_000), '冷却期内').toEqual([]);
    expect(evaluateAlerts(snap(40, 0.2), rules, state, 700_000).map((a) => a.status), '冷却过了还没好，再告一次').toEqual(['firing']);
    expect(evaluateAlerts(snap(40, 0.01), rules, state, 710_000)).toEqual([{ rule: 'errors', status: 'resolved', value: 0.01, threshold: 0.05, message: '错误率恢复到 1.0%' }]);
    expect(evaluateAlerts(snap(40, 0.01), rules, state, 720_000)).toEqual([]);
    expect(DEFAULT_RULES.map((r) => r.metric)).toEqual(['errorRate', 'p95Ms', 'costPerHour']);
  });

  test('sendWebhook：发一段文字；失败只返回 false', async () => {
    const sent: unknown[] = [];
    const ok = await sendWebhook('https://hooks.example/x', [{ rule: 'errors', status: 'firing', value: 0.1, threshold: 0.05, message: '错误率 10.0%，超过了 5.0%' }], async (_url, init) => (sent.push(JSON.parse(String(init!.body))), new Response('ok')));
    expect(ok).toBe(true);
    expect(JSON.stringify(sent[0])).toContain('🔴 [研究助手] 错误率 10.0%，超过了 5.0%');
    expect(await sendWebhook('https://x', [{ rule: 'r', status: 'resolved', value: 0, threshold: 0, message: 'm' }], async () => Promise.reject(new Error('网络断了')))).toBe(false);
    expect(await sendWebhook('https://x', [], async () => Promise.reject(new Error('不该发')))).toBe(true);
  });
});

describe('第 49 天：反馈回流到评估集（TODO 5）', () => {
  test('feedbackToCase：脱敏、打标签、notes 里带着当时的回答和来源', () => {
    const c = feedbackToCase(feedback());
    expect(c.id).toBe(feedbackCaseId('潮汐协议 3.0 的默认端口是多少？'));
    expect(c.id).toMatch(/^fb-[0-9a-f]{10}$/);
    expect(c.tags).toEqual(['feedback', 'prompt:research@1a2b3c4d', 'variant:canary']);
    expect(c.notes).toContain('用户反馈：端口说错了，我的电话 138****5678');
    expect(c.notes).toContain('当时的回答：默认端口是 8443 [1]。');
    expect(c.notes).toContain('当时的来源：https://tide.example/forum.html');
    expect(c.notes).toContain('待审核');
    expect(c.expected).toMatchObject({ facts: [], sources: [] });
    expect(feedbackToCase(feedback({ question: '我是 13812345678，端口多少？', variant: undefined, comment: undefined }))).toMatchObject({ question: '我是 138****5678，端口多少？', tags: ['feedback', 'prompt:research@1a2b3c4d'] });
  });

  test('appendCases：追加到 JSONL，同样的编号跳过，文件仍然是合法的评估集', async () => {
    const file = join(await tmp(), 'eval', 'feedback-pending.jsonl');
    expect(await appendCases(file, [feedbackToCase(feedback())])).toBe(1);
    expect(await appendCases(file, [feedbackToCase(feedback({ runId: 'r2' })), feedbackToCase(feedback({ question: '3.0 有什么变化？' }))])).toBe(1);
    const cases = parseDataset(await readFile(file, 'utf8'));
    expect(cases).toHaveLength(2);
    expect(validateDataset(cases).length, '期望是空的，校验会提醒还没审核').toBeGreaterThan(0);
  });

  test('handleFeedback 和 ratingStats', async () => {
    const store = createMemoryFeedbackStore();
    const file = join(await tmp(), 'pending.jsonl');
    expect(await handleFeedback(store, feedback({ rating: 'up', variant: 'canary' }), file)).toBe(false);
    expect(await handleFeedback(store, feedback({ variant: 'canary' }), file)).toBe(true);
    expect(await handleFeedback(store, feedback({ variant: 'canary', runId: 'r3' }), file), '同一个问题已经有用例了').toBe(false);
    await handleFeedback(store, feedback({ rating: 'up', variant: 'stable' }), file);
    expect(await ratingStats(store, 'canary')).toEqual({ successes: 1, total: 3 });
    expect(await ratingStats(store, 'stable')).toEqual({ successes: 1, total: 1 });
  });
});

describeMock('第 49 天：把它们串起来', () => {
  test('灰度的用户用新的 prompt；指标按变体记；差评带着版本号进评估集', async () => {
    const dir = await tmp();
    const registry = await openPromptRegistry(join(dir, 'prompts.json'));
    const stable = await registry.publish('research', RESEARCH_PROMPT, '基线');
    const next = await registry.publish('research', `${RESEARCH_PROMPT}\n- 回答的第一句直接给出结论`, '结论先行');
    await registry.setLabel('research', 'production', stable.id);
    await registry.setLabel('research', 'canary', next.id);
    const exp = canary('research-prompt', 50, stable.id, next.id);
    const user = Array.from({ length: 100 }, (_, i) => `user-${i}`).find((u) => chooseVariant(exp, u).name === 'canary')!;
    const variant = chooseVariant(exp, user);
    const prompt = registry.byId(variant.value)!;

    const metrics = createMetrics();
    llm.reply({ content: '默认端口是 8443。' });
    const started = performance.now();
    const r = await research('3.0 的默认端口是多少？', await makeSetup(import.meta.url, fixture), { model: createModel('openai'), system: prompt.content });
    metrics.record({ ok: r.result.status === 'completed', latencyMs: performance.now() - started, cost: 0, variant: variant.name });
    expect(llm.requests[0].messages[0], '用的是灰度的那一版').toEqual({ role: 'system', content: next.content });
    expect(metrics.snapshot('canary').count).toBe(1);

    const store = createMemoryFeedbackStore();
    const pending = join(dir, 'pending.jsonl');
    await handleFeedback(store, { runId: 'r1', userId: user, rating: 'down', comment: '端口不对', question: '3.0 的默认端口是多少？', answer: r.answer, sources: [], promptVersion: prompt.id, variant: variant.name, createdAt: new Date().toISOString() }, pending);
    const [c] = parseDataset(await readFile(pending, 'utf8'));
    expect(c.tags).toEqual(['feedback', `prompt:${next.id}`, 'variant:canary']);
  });
});

describeE2E('第 49 天：真实模型用新一版 prompt', () => {
  test('结论先行的 prompt 照样答对', { timeout: 300_000 }, async () => {
    const r = await research('潮汐协议 3.0 的默认端口是多少？', await makeSetup(import.meta.url, fixture), { model: createModel('openai'), system: `${RESEARCH_PROMPT}\n- 回答的第一句直接给出结论` });
    console.log(r.answer);
    expect(r.answer).toContain('7443');
  });
});
