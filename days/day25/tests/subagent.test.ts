import { expect, test } from 'vitest';
import { z } from 'zod';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const s = await loadTarget<typeof import('../solution/subagent.ts')>(import.meta.url, 'subagent.ts');
const { runSubagent, createDelegateTool, subagentTools, formatFindings, SUBAGENT_PROMPT } = s;
const { orchestrate, createResearchTools } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { defineTool, runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');

const lookup = defineTool({ name: 'lookup', description: '查一查', schema: z.object({ q: z.string() }), execute: ({ q }) => `「${q}」的资料` });
const call = (args: object) => ({ id: 'call_1', type: 'function' as const, function: { name: 'delegate_research', arguments: JSON.stringify(args) } });

describeMock('第 25 天：运行一个子 Agent（TODO 1）', () => {
  test('全新的上下文：只有子 Agent 的 prompt、子问题和背景', async () => {
    llm.reply({ toolCalls: [{ name: 'lookup', arguments: { q: '端口' } }] }).reply({ content: '默认端口是 7443 [1]。' });
    const result = await runSubagent({ question: '潮汐协议 3.0 的默认端口', context: '用户在准备升级' }, { model: createModel('openai'), tools: [lookup] });
    expect(llm.requests[0].messages).toEqual([
      { role: 'system', content: SUBAGENT_PROMPT },
      { role: 'user', content: '子问题：潮汐协议 3.0 的默认端口\n\n背景：用户在准备升级' },
    ]);
    expect(result).toMatchObject({ status: 'completed', findings: '默认端口是 7443 [1]。', steps: 2, toolCalls: 1 });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test('只交回精简的结论：超过 maxChars 就截短', async () => {
    llm.reply({ content: '很长的结论。'.repeat(100) });
    const result = await runSubagent({ question: '问题' }, { model: createModel('openai'), tools: [lookup], maxChars: 50 });
    expect(result.findings).toContain('只保留了前 50 个字符');
  });

  test('没有查完：结论后面注明原因', async () => {
    llm.reply({ toolCalls: [{ name: 'lookup', arguments: { q: 'a' } }] }).reply({ toolCalls: [{ name: 'lookup', arguments: { q: 'b' } }] });
    const result = await runSubagent({ question: '问题' }, { model: createModel('openai'), tools: [lookup], maxSteps: 2 });
    expect(result.status).toBe('max_steps');
    expect(result.findings).toBe('（没有查完：调用了 2 次模型还没有完成，已停止）');
  });

  test('调用模型出错：不抛出，记成 error', async () => {
    llm.fail({ status: 400, message: '参数不对' });
    const result = await runSubagent({ question: '问题' }, { model: createModel('openai'), tools: [lookup] });
    expect(result).toMatchObject({ status: 'error', steps: 0 });
    expect(result.findings).toContain('出错了');
  });
});

describeMock('第 25 天：同时派出几个子 Agent（TODO 2）', () => {
  test('几个子 Agent 同时跑，结论按子问题的顺序交回；记下每个子 Agent 的结果', async () => {
    // 同时跑的子 Agent，请求到达的顺序不固定：用 match 按子问题对上回复
    llm
      .reply({ content: 'B 的结论 [2]。', match: '子问题：问题 B', delayMs: 200 })
      .reply({ content: 'A 的结论 [1]。', match: '子问题：问题 A', delayMs: 200 })
      .reply({ content: 'C 的结论。', match: '子问题：问题 C', delayMs: 200 });
    const events: string[] = [];
    const delegate = createDelegateTool({
      model: createModel('openai'),
      tools: [lookup],
      onSubagent: (e) => events.push(`${e.type} ${e.index}`),
    });
    const start = performance.now();
    const result = await runToolCall([delegate.tool], call({ tasks: [{ question: '问题 A' }, { question: '问题 B' }, { question: '问题 C' }] }));
    expect(performance.now() - start, '三个子 Agent 要同时跑（一个接一个要 600 毫秒）').toBeLessThan(450);
    expect(result.content).toBe(
      '## 子问题 1：问题 A\nA 的结论 [1]。\n\n## 子问题 2：问题 B\nB 的结论 [2]。\n\n## 子问题 3：问题 C\nC 的结论。\n\n汇总时保留结论里的 [编号]。哪个子问题没有查到，就在回答里说明',
    );
    expect(delegate.results.map((r) => r.findings)).toEqual(['A 的结论 [1]。', 'B 的结论 [2]。', 'C 的结论。']);
    expect(events.filter((e) => e.startsWith('done'))).toHaveLength(3);
  });

  test('同时最多 concurrency 个；一次最多 maxTasks 个', async () => {
    for (const q of ['1', '2', '3']) llm.reply({ content: `结论 ${q}`, match: `子问题：问题 ${q}`, delayMs: 40 });
    const delegate = createDelegateTool({ model: createModel('openai'), tools: [lookup], concurrency: 1, maxTasks: 3 });
    const start = performance.now();
    await runToolCall([delegate.tool], call({ tasks: [{ question: '问题 1' }, { question: '问题 2' }, { question: '问题 3' }] }));
    expect(performance.now() - start, '并发 1：一个接一个').toBeGreaterThanOrEqual(115);
    const tooMany = await runToolCall([delegate.tool], call({ tasks: ['a', 'b', 'c', 'd'].map((question) => ({ question })) }));
    expect(tooMany.isError).toBe(true);
  });
});

test('子 Agent 不用有副作用的工具，也不能再派子 Agent', async () => {
  const setup = await makeSetup(import.meta.url, fixture);
  const names = subagentTools(createResearchTools({ ...setup, subagents: { model: createModel('openai') } }).tools).map((t) => t.name);
  expect(names).toContain('web_search');
  expect(names).toContain('read_doc');
  for (const name of ['write_file', 'http_request', 'remember', 'forget', 'delegate_research']) expect(names).not.toContain(name);
  expect(formatFindings([])).toBe('');
});

describeMock('第 25 天：主 Agent 加子 Agent 的研究（TODO 3）', () => {
  test('主 Agent 派出两个子 Agent，汇总它们的结论；编号共用；用量分开算', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ toolCalls: [{ name: 'delegate_research', arguments: { tasks: [{ question: '潮汐协议 3.0 的默认端口' }, { question: '潮汐云托管专业版的价格' }] } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } })
      // 子 Agent A 先搜，登记 [1] [2]；子 Agent B 晚一点搜，登记 [3]
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0' } }], match: '子问题：潮汐协议 3.0', usage: { prompt_tokens: 300, completion_tokens: 10 } })
      .reply({ content: '默认端口是 7443 [1]。', match: '子问题：潮汐协议 3.0', usage: { prompt_tokens: 600, completion_tokens: 10 } })
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐云托管 价格' } }], match: '子问题：潮汐云托管', delayMs: 80, usage: { prompt_tokens: 300, completion_tokens: 10 } })
      .reply({ content: '专业版每月 499 元 [3]。', match: '子问题：潮汐云托管', usage: { prompt_tokens: 600, completion_tokens: 10 } })
      .reply({ content: '默认端口是 7443 [1]，专业版每月 499 元 [3]。', usage: { prompt_tokens: 1500, completion_tokens: 30 } });
    const result = await orchestrate('潮汐协议 3.0 的默认端口和托管价格？', setup, { model: createModel('openai') });

    const main = llm.requests.filter((r) => r.messages[0].content!.includes('# 子 Agent'));
    expect(main, '主 Agent 用 ORCHESTRATOR_PROMPT，调用了两次模型').toHaveLength(2);
    expect(main[0].tools!.map((t) => t.function.name)).toContain('delegate_research');
    const subRequests = llm.requests.filter((r) => r.messages[0].content === SUBAGENT_PROMPT);
    expect(subRequests).toHaveLength(4);
    expect(subRequests.every((r) => !r.tools!.some((t) => t.function.name === 'delegate_research')), '子 Agent 不能再派子 Agent').toBe(true);
    const finalMain = main[1].messages.at(-1)!.content!;
    expect(finalMain, '主 Agent 只拿到精简的结论，不是网页原文').toContain('## 子问题 1：潮汐协议 3.0 的默认端口\n默认端口是 7443 [1]。');
    expect(finalMain).not.toContain('潮汐协议 3.0 于 2026 年 3 月发布……');

    expect(result.subagents.map((r) => r.status)).toEqual(['completed', 'completed']);
    expect(result.usage.main).toMatchObject({ inputTokens: 2500, outputTokens: 80 });
    expect(result.usage.subagents).toMatchObject({ inputTokens: 1800, outputTokens: 40 });
    expect(result.usage.total).toMatchObject({ inputTokens: 4300, outputTokens: 120 });
    expect(result.report.problems).toEqual([]);
    expect(result.text).toContain('[1] 潮汐协议 3.0 发布说明');
    expect(result.text).toContain('[3] 潮汐云托管 价格');
  });

  test('简单的问题：主 Agent 自己查，不派子 Agent', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0' } }] }).reply({ content: '发布了 [1]。' });
    const result = await orchestrate('潮汐协议 3.0 发布了吗？', setup, { model: createModel('openai') });
    expect(result.subagents).toEqual([]);
    expect(result.usage.subagents.inputTokens).toBe(0);
    expect(result.usage.total).toEqual(result.usage.main);
  });
});

describeE2E('第 25 天：真实模型的主 Agent 和子 Agent', () => {
  test('一个有几个方面的问题：派出子 Agent，汇总，打印用量', { timeout: 600_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const result = await orchestrate('分别查一下：潮汐协议 3.0 比 2.x 快了多少？从 2.x 迁移要改哪个配置项？潮汐云托管专业版多少钱？', setup, {
      model: createModel('openai'),
      onSubagent: (e) => e.type === 'start' && console.log(`↳ ${e.task.question}`),
    });
    console.log(`\n${result.text}\n\n主 Agent ${result.usage.main.inputTokens} tokens，子 Agent ${result.usage.subagents.inputTokens} tokens`);
    expect(result.subagents.length, '应该派出子 Agent').toBeGreaterThanOrEqual(2);
    expect(result.answer).toContain('499');
  });
});
