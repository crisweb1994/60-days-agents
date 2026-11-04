import { describe, expect, test } from 'vitest';
import { describeE2E, loadTarget, setupModel } from '#testing';
import type { BenchTask } from '../solution/bench.ts';

await setupModel();
const { runBench, formatReports } = await loadTarget<typeof import('../solution/bench.ts')>(import.meta.url, 'bench.ts');
const { createScriptedModel } = await loadTarget<typeof import('../solution/testing/scripted-model.ts')>(
  import.meta.url,
  'testing/scripted-model.ts',
);
const { createLibraryTools } = await loadTarget<typeof import('../solution/tools/library.ts')>(import.meta.url, 'tools/library.ts');
const { createBadLibraryTools } = await loadTarget<typeof import('../solution/tools/library-bad.ts')>(
  import.meta.url,
  'tools/library-bad.ts',
);
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { TASKS } = await loadTarget<typeof import('../solution/data/tasks.ts')>(import.meta.url, 'data/tasks.ts');

const tasks: BenchTask[] = [
  { name: '甲', question: '问题甲', check: (answer) => answer.includes('42') },
  { name: '乙', question: '问题乙', check: (answer) => answer.includes('对') },
];

describe('第 11 天：比较两套工具（TODO 6）', () => {
  test('统计每个任务的通过次数、平均步数和输入 token，以及总的成功率', async () => {
    const model = createScriptedModel([
      // 甲，第 1 次：查了一次再回答，答对
      { toolCalls: [{ name: 'search_articles', arguments: { query: 'x' } }], usage: { inputTokens: 100 } },
      { text: '答案是 42', usage: { inputTokens: 200 } },
      // 甲，第 2 次：直接回答，答错
      { text: '不知道', usage: { inputTokens: 100 } },
      // 乙，第 1 次：调用模型出错，算失败
      new Error('网络断了'),
      // 乙，第 2 次：答对
      { text: '对', usage: { inputTokens: 50 } },
    ]);
    const report = await runBench({ name: '改后', tasks, tools: createLibraryTools(), model, runs: 2 });
    expect(report.tasks[0]).toEqual({ task: '甲', runs: 2, passed: 1, avgSteps: 1.5, avgInputTokens: 200 });
    expect(report.tasks[1], '出错的那次不计入步数和 token 的平均').toMatchObject({ passed: 1, avgSteps: 1, avgInputTokens: 50 });
    expect(report.successRate).toBe(0.5);
    expect(model.remaining).toBe(0);
  });

  test('没有正常完成的运行，哪怕回答里碰巧有答案，也不算成功', async () => {
    const model = createScriptedModel([{ text: '答案是 42……', finishReason: 'length' }, { text: '对' }]);
    const report = await runBench({ name: '改后', tasks, tools: [], model });
    expect(report.tasks[0].passed, '被截断的回答不算').toBe(0);
    expect(report.tasks[1].passed).toBe(1);
  });

  test('formatReports：每个任务一行，最后一行是总计', async () => {
    const model = createScriptedModel([{ text: '42' }, { text: '对' }, { text: '?' }, { text: '?' }]);
    const good = await runBench({ name: '改后', tasks, tools: [], model });
    const bad = await runBench({ name: '改前', tasks, tools: [], model });
    const table = formatReports([bad, good]);
    expect(table).toContain('| 任务 | 改前 | 改后 |');
    expect(table).toContain('总计');
    expect(table).toContain('100%');
    expect(table).toContain('0%');
  });
});

describeE2E('第 11 天：真实模型（需真实模型）', () => {
  test('改后的工具成功率不低于改前', { timeout: 600_000 }, async () => {
    const model = createModel('openai');
    const bad = await runBench({ name: '改前', tasks: TASKS, tools: createBadLibraryTools(), model });
    const good = await runBench({ name: '改后', tasks: TASKS, tools: createLibraryTools(), model });
    console.log(`\n${formatReports([bad, good])}`);
    expect(good.successRate).toBeGreaterThanOrEqual(bad.successRate);
    expect(good.successRate).toBeGreaterThanOrEqual(0.75);
  });
});
