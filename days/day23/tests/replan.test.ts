import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { planAndExecute, parseSteps, describeProgress, formatPlan, PLANNER_PROMPT, REPLANNER_PROMPT } = await loadTarget<
  typeof import('../solution/plan.ts')
>(import.meta.url, 'plan.ts');
const { planResearch } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

type Outcome = { ok: boolean; output: string };

/** 一个假的执行者：按准备好的结果回答每一步，并记下执行了哪些步骤 */
function fakeExecutor(outcomes: Record<string, Outcome>) {
  const executed: { step: string; done: string[] }[] = [];
  return {
    executed,
    async execute(step: string, { done }: { done: { step: string }[] }) {
      executed.push({ step, done: done.map((d) => d.step) });
      return outcomes[step] ?? { ok: false, output: `测试没有准备「${step}」的结果` };
    },
  };
}

const synthesize = async (_question: string, done: { step: string; output: string }[]) => ({ answer: done.map((d) => d.output).join('；') });

test('parseSteps 和 describeProgress', () => {
  expect(parseSteps('{"steps": ["a", " ", "b"]}')).toEqual(['a', 'b']);
  expect(parseSteps('{"steps": []}')).toEqual([]);
  expect(parseSteps('好的')).toBeUndefined();
  expect(parseSteps('{"steps": [1]}')).toBeUndefined();
  const text = describeProgress('问题', [{ step: '查端口', output: '7443' }], { step: '查定价', reason: '网页打不开' }, ['汇总价格']);
  expect(text).toContain('已经完成的步骤：\n1. 查端口\n结果：7443');
  expect(text).toContain('失败的步骤：查定价\n原因：网页打不开');
  expect(text).toContain('原来剩下的步骤：\n1. 汇总价格');
});

describeMock('第 23 天：先规划后执行（TODO 4）', () => {
  test('按计划一步步执行，每一步都能看到前面的结果，最后汇总', async () => {
    llm.reply({ content: '{"steps": ["查端口", "查性能"]}' });
    const executor = fakeExecutor({ 查端口: { ok: true, output: '端口是 7443' }, 查性能: { ok: true, output: '延迟 18 毫秒' } });
    const result = await planAndExecute('潮汐协议 3.0 怎么样？', { planner: createModel('openai'), execute: executor.execute, synthesize });
    expect(llm.requests[0].messages[0].content).toBe(PLANNER_PROMPT);
    expect(executor.executed).toEqual([
      { step: '查端口', done: [] },
      { step: '查性能', done: ['查端口'] },
    ]);
    expect(result).toMatchObject({ answer: '端口是 7443；延迟 18 毫秒', replans: 0, stopped: undefined });
    expect(result.plan.map((s) => s.status)).toEqual(['completed', 'completed']);
  });

  test('某一步失败了：带着已有的结果和失败的原因重新规划，用新的步骤替换剩下的', async () => {
    llm
      .reply({ content: '{"steps": ["查端口", "查官方定价", "对比价格"]}' })
      .reply({ content: '{"steps": ["搜索潮汐云托管 价格", "对比价格"]}' });
    const executor = fakeExecutor({
      查端口: { ok: true, output: '端口是 7443' },
      查官方定价: { ok: false, output: '官网的定价页打不开' },
      '搜索潮汐云托管 价格': { ok: true, output: '专业版每月 499 元' },
      对比价格: { ok: true, output: '专业版更贵' },
    });
    const plans: string[] = [];
    const result = await planAndExecute('潮汐协议怎么样？要多少钱？', {
      planner: createModel('openai'),
      execute: executor.execute,
      synthesize,
      onPlan: (steps) => plans.push(formatPlan(steps)),
    });
    expect(llm.requests).toHaveLength(2);
    const replan = llm.requests[1].messages;
    expect(replan[0].content).toBe(REPLANNER_PROMPT);
    expect(replan[1].content, '重新规划时要告诉模型：完成了什么、哪一步为什么失败、原来还剩什么').toBe(
      describeProgress('潮汐协议怎么样？要多少钱？', [{ step: '查端口', output: '端口是 7443' }], { step: '查官方定价', reason: '官网的定价页打不开' }, ['对比价格']),
    );
    expect(executor.executed.map((e) => e.step)).toEqual(['查端口', '查官方定价', '搜索潮汐云托管 价格', '对比价格']);
    expect(result.replans).toBe(1);
    expect(result.plan).toEqual([
      { content: '查端口', status: 'completed' },
      { content: '查官方定价', status: 'failed', note: '官网的定价页打不开' },
      { content: '搜索潮汐云托管 价格', status: 'completed' },
      { content: '对比价格', status: 'completed' },
    ]);
    expect(result.answer, '失败的步骤不进汇总').toBe('端口是 7443；专业版每月 499 元；专业版更贵');
    expect(plans[0], '一开始就让用户看到计划').toBe('[ ] 查端口\n[ ] 查官方定价\n[ ] 对比价格\n进度：0/3');
    expect(plans, '每开始一步都显示出来').toContain('[x] 查端口\n[>] 查官方定价\n[ ] 对比价格\n进度：1/3');
    expect(plans.at(-1)).toBe(formatPlan(result.plan));
  });

  test('重新规划说没有别的办法（空计划）：不再往下做，用已有的结果汇总', async () => {
    llm.reply({ content: '{"steps": ["查端口", "查定价"]}' }).reply({ content: '{"steps": []}' });
    const executor = fakeExecutor({ 查端口: { ok: true, output: '7443' }, 查定价: { ok: false, output: '查不到' } });
    const result = await planAndExecute('问题', { planner: createModel('openai'), execute: executor.execute, synthesize });
    expect(result).toMatchObject({ answer: '7443', replans: 1, stopped: undefined });
  });

  test('计划解析不了：把问题本身当作唯一的一步；重新规划解析不了：保留原来剩下的步骤', async () => {
    llm.reply({ content: '我会先搜索' });
    const one = fakeExecutor({ 问题本身: { ok: true, output: '答案' } });
    expect((await planAndExecute('问题本身', { planner: createModel('openai'), execute: one.execute, synthesize })).answer).toBe('答案');

    llm.reply({ content: '{"steps": ["a", "b"]}' }).reply({ content: '换个办法吧' });
    const two = fakeExecutor({ a: { ok: false, output: '出错' }, b: { ok: true, output: 'b 的结果' } });
    const result = await planAndExecute('问题', { planner: createModel('openai'), execute: two.execute, synthesize });
    expect(two.executed.map((e) => e.step)).toEqual(['a', 'b']);
    expect(result.answer).toBe('b 的结果');
  });

  test('重新规划的次数用完：停下来，用已有的结果汇总，注明原因', async () => {
    llm.reply({ content: '{"steps": ["a"]}' }).reply({ content: '{"steps": ["b"]}' }).reply({ content: '{"steps": ["c"]}' });
    const executor = fakeExecutor({ a: { ok: false, output: '1' }, b: { ok: false, output: '2' } });
    const result = await planAndExecute('问题', { planner: createModel('openai'), execute: executor.execute, synthesize, maxReplans: 1 });
    expect(executor.executed.map((e) => e.step)).toEqual(['a', 'b']);
    expect(result).toMatchObject({ replans: 1, stopped: 'max_replans', answer: '' });
    expect(llm.pending, '用完以后不再重新规划').toBe(1);
  });

  test('执行的步数用完：停下来，没做的步骤留在计划里', async () => {
    llm.reply({ content: '{"steps": ["a", "b", "c"]}' });
    const executor = fakeExecutor({ a: { ok: true, output: 'A' }, b: { ok: true, output: 'B' }, c: { ok: true, output: 'C' } });
    const result = await planAndExecute('问题', { planner: createModel('openai'), execute: executor.execute, synthesize, maxSteps: 2 });
    expect(result.stopped).toBe('max_steps');
    expect(result.plan.map((s) => s.status)).toEqual(['completed', 'completed', 'pending']);
  });
});

describeMock('第 23 天：先规划后执行的研究助手', () => {
  test('每一步交给一个 Agent；一步失败后重新规划；汇总时引用的编号对得上', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ content: '{"steps": ["查潮汐协议 3.0 的默认端口", "查潮汐云托管的价格"]}' })
      // 第一步的 Agent
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 端口' } }] })
      .reply({ content: '默认端口是 7443 [1]。' })
      // 第二步的 Agent：做不成
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/missing.html` } }] })
      .reply({ content: '失败：官方价格页打不开' })
      // 重新规划
      .reply({ content: '{"steps": ["搜索潮汐云托管的价格"]}' })
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐云托管 价格' } }] })
      .reply({ content: '专业版每月 499 元 [3]。' })
      // 汇总
      .reply({ content: '默认端口是 7443 [1]，专业版每月 499 元 [3]。' });
    const result = await planResearch('潮汐协议 3.0 的端口和托管价格？', setup, { model: createModel('openai') });
    expect(result.replans).toBe(1);
    expect(result.plan.map((s) => s.status)).toEqual(['completed', 'failed', 'completed']);
    expect(result.plan[1].note).toBe('官方价格页打不开');
    const thirdStep = llm.requests[6].messages.at(-1)!.content!;
    expect(thirdStep, '执行者能看到前面步骤的结果').toContain('默认端口是 7443 [1]');
    expect(llm.requests[6].tools!.map((t) => t.function.name), '执行者不用再列计划').not.toContain('update_plan');
    expect(result.report.problems).toEqual([]);
    expect(result.text).toContain('来源：\n[1] 潮汐协议 3.0 发布说明');
    expect(result.text).toContain('[3] 潮汐云托管 价格');
  });
});

describeE2E('第 23 天：真实模型先规划后执行', () => {
  test('要查好几件事的问题：列出计划、执行、汇总', { timeout: 600_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const result = await planResearch('潮汐协议 3.0 有什么变化？性能提升了多少？从 2.x 迁移要改哪个配置项？', setup, {
      model: createModel('openai'),
      onPlan: (steps) => console.log(`\n${formatPlan(steps)}`),
    });
    console.log(`\n${result.text}\n\n引用检查：${result.report.problems.join('；') || '通过'}`);
    expect(result.plan.length).toBeGreaterThanOrEqual(2);
    expect(result.done.length).toBeGreaterThanOrEqual(1);
    expect(result.answer).toContain('handshake.attempts');
  });
});
