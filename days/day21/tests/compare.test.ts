import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { COMPARE_TASKS } from '../data/compare-tasks.ts';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { countCalls, formatSummary, measure, missingFacts, summarize } = await loadTarget<typeof import('../solution/compare.ts')>(
  import.meta.url,
  'compare.ts',
);
const { researchWorkflow } = await loadTarget<typeof import('../solution/workflow.ts')>(import.meta.url, 'workflow.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { emptyUsage } = await loadTarget<typeof import('../solution/usage.ts')>(import.meta.url, 'usage.ts');

const usage = (inputTokens: number, outputTokens: number) => ({ ...emptyUsage(), inputTokens, outputTokens });
const task = { question: '迁移要改什么？', expected: ['handshake.attempts', ['12 月 31', '12-31']] };

describeMock('countCalls', () => {
  test('数调用次数，累加用量', async () => {
    llm.reply({ content: '一', usage: { prompt_tokens: 10, completion_tokens: 2 } }).reply({ content: '二', usage: { prompt_tokens: 20, completion_tokens: 3 } });
    const model = countCalls(createModel('openai'));
    await model.chat({ messages: [{ role: 'user', content: '1' }] });
    await model.chat({ messages: [{ role: 'user', content: '2' }] });
    expect(model.calls).toBe(2);
    expect(model.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 });
  });
});

describe('第 21 天：记录一次运行（TODO 4）', () => {
  test('missingFacts：忽略空白；几种写法出现一种就行', () => {
    expect(missingFacts('改成 handshake.attempts，2026 年 12月31日 停止维护', task.expected)).toEqual([]);
    expect(missingFacts('改成 handshake.attempts', task.expected)).toEqual(['12 月 31/12-31']);
  });

  test('答对、引用、调用次数、用量、花费和耗时', async () => {
    const times = [1000, 3500];
    const metrics = await measure(
      'workflow',
      task,
      async () => ({ answer: 'handshake.attempts，12-31', usage: usage(1_000_000, 0), modelCalls: 2, citationsOk: true }),
      { price: { input: 2, output: 8 }, clock: () => times.shift()! },
    );
    expect(metrics).toEqual({
      approach: 'workflow',
      question: '迁移要改什么？',
      correct: true,
      missing: [],
      citationsOk: true,
      modelCalls: 2,
      usage: usage(1_000_000, 0),
      cost: 2,
      ms: 2500,
    });
  });

  test('没有单价时 cost 是 undefined；出错记成一次失败，不抛出', async () => {
    const times = [0, 800];
    const metrics = await measure('agent', task, async () => {
      throw new Error('模型超时');
    }, { clock: () => times.shift()! });
    expect(metrics).toMatchObject({ approach: 'agent', correct: false, citationsOk: false, modelCalls: 0, ms: 800, error: '模型超时' });
    expect(metrics.missing).toHaveLength(2);
    expect(metrics.cost).toBeUndefined();
  });
});

describe('第 21 天：汇总（TODO 5）', () => {
  const run = (approach: string, correct: boolean, modelCalls: number, tokens: number, ms: number, cost?: number) => ({
    approach,
    question: 'q',
    correct,
    missing: [],
    citationsOk: correct,
    modelCalls,
    usage: usage(tokens, 0),
    cost,
    ms,
  });

  test('按做法分组：答对的比例、平均调用次数和 token、耗时的中位数和最慢的一次', () => {
    const [workflow, agent] = summarize([
      run('workflow', true, 2, 1000, 3000, 0.01),
      run('agent', true, 4, 5000, 9000, 0.05),
      run('workflow', false, 2, 3000, 9000, 0.03),
      run('agent', true, 6, 7000, 20000, 0.07),
      run('workflow', true, 2, 2000, 4000, 0.02),
    ]);
    expect(workflow).toEqual({
      approach: 'workflow',
      runs: 3,
      accuracy: 2 / 3,
      citationRate: 2 / 3,
      avgCalls: 2,
      avgTokens: 2000,
      avgCost: 0.02,
      medianMs: 4000,
      maxMs: 9000,
    });
    expect(agent).toMatchObject({ runs: 2, accuracy: 1, avgCalls: 5, medianMs: 14500, maxMs: 20000 });
    expect(agent.avgCost).toBeCloseTo(0.06);
  });

  test('有一次没有单价，平均花费就是 undefined；表格里显示成 —', () => {
    const summaries = summarize([run('agent', true, 4, 100, 1000, 0.01), run('agent', true, 4, 100, 1000)]);
    expect(summaries[0].avgCost).toBeUndefined();
    expect(formatSummary(summaries)).toContain('| agent | 2 | 100% | 100% | 4.0 | 100 | — | 1.0 秒 | 1.0 秒 |');
  });
});

describeE2E('第 21 天：用真实模型对比固定流程和 Agent（网页和搜索用本地的假服务）', () => {
  test('同一组任务各跑一遍，打印对比表', { timeout: 600_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const metrics = [];
    for (const t of COMPARE_TASKS) {
      metrics.push(
        await measure('workflow', t, async () => {
          const r = await researchWorkflow(t.question, setup, { model: createModel('openai') });
          return { answer: r.answer, usage: r.usage, modelCalls: r.modelCalls, citationsOk: r.report.ok };
        }),
        await measure('agent', t, async () => {
          const r = await research(t.question, { workspace: setup.workspace, search: setup.search, fetchOptions: setup.fetchOptions }, { model: createModel('openai') });
          return { answer: r.result.answer, usage: r.result.usage, modelCalls: r.result.steps, citationsOk: r.report.ok };
        }),
      );
    }
    for (const m of metrics.filter((m) => !m.correct)) console.log(`✗ ${m.approach}：${m.question}（缺少 ${m.missing.join('、')}${m.error ? `；${m.error}` : ''}）`);
    console.log(`\n${formatSummary(summarize(metrics))}`);
    expect(metrics.filter((m) => m.error), '两种做法都应该能跑完').toEqual([]);
    expect(metrics.filter((m) => m.approach === 'workflow').every((m) => m.modelCalls === 2), '固定流程总是调用 2 次模型').toBe(true);
  });
});
