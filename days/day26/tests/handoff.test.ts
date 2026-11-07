import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const h = await loadTarget<typeof import('../solution/handoff.ts')>(import.meta.url, 'handoff.ts');
const { createTransferTool, runTeam, validateTeam, handoffInput, createResearchTeam, teamResearch, TRIAGE_PROMPT, WEB_PROMPT, DOCS_PROMPT } = h;
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { defineTool, runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const lookup = defineTool({ name: 'lookup', description: '查一查', schema: z.object({ q: z.string() }), execute: ({ q }) => `「${q}」的资料` });
const spec = (name: string, handoffs: string[], tools = [lookup]) => ({ name, description: `${name} 的职责`, instructions: `你是 ${name}`, tools, handoffs });
const team = () => [spec('triage', ['web', 'docs'], []), spec('web', ['docs']), spec('docs', ['web'])];
const transfer = (to: string, summary = '用户想知道端口') => ({ name: `transfer_to_${to}`, arguments: { reason: `归 ${to} 管`, summary } });

describeMock('第 26 天：成功执行了交接工具就停下（TODO 1）', () => {
  const stop = defineTool({ name: 'hand_over', description: '交出去', schema: z.object({ ok: z.boolean() }), execute: ({ ok }) => {
    if (!ok) throw new Error('不能交');
    return '交出去了';
  } });

  test('执行成功：停下，status 是 stopped，不再调用模型', async () => {
    llm.reply({ toolCalls: [{ name: 'hand_over', arguments: { ok: true } }] }).reply({ content: '不该用到这一轮' });
    const result = await runAgent('问题', { model: createModel('openai'), tools: [stop], stopOn: ['hand_over'] });
    expect(result.status).toBe('stopped');
    expect(llm.requests).toHaveLength(1);
    expect(result.messages.at(-1), '工具结果照样放进历史').toMatchObject({ role: 'tool', content: '交出去了' });
  });

  test('执行出错：不停下，把错误交回模型，让它自己处理', async () => {
    llm.reply({ toolCalls: [{ name: 'hand_over', arguments: { ok: false } }] }).reply({ content: '那我自己回答吧。' });
    const result = await runAgent('问题', { model: createModel('openai'), tools: [stop], stopOn: ['hand_over'] });
    expect(result).toMatchObject({ status: 'completed', answer: '那我自己回答吧。' });
  });
});

describe('第 26 天：交接工具和防循环（TODO 2）', () => {
  const call = (to: string) => ({ id: 'c', type: 'function' as const, function: { name: `transfer_to_${to}`, arguments: JSON.stringify(transfer(to).arguments) } });

  test('交接成功：记下谁交给谁、为什么、交接说明', async () => {
    const [triage, web] = team();
    const state = { visited: new Set(['triage']), handoffs: [] as any[], maxHandoffs: 3 };
    const tool = createTransferTool(triage, web, state);
    expect(tool.name).toBe('transfer_to_web');
    expect(tool.description).toContain('web 的职责');
    const result = await runToolCall([tool], call('web'));
    expect(result).toEqual({ content: '已经交给 web', isError: false });
    expect(state.handoffs).toEqual([{ from: 'triage', to: 'web', reason: '归 web 管', summary: '用户想知道端口' }]);
  });

  test('不能交回已经经手过的 Agent：返回错误，让它自己回答', async () => {
    const [, web, docs] = team();
    const state = { visited: new Set(['triage', 'web', 'docs']), handoffs: [] as any[], maxHandoffs: 3 };
    const result = await runToolCall([createTransferTool(docs, web, state)], call('web'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('web 已经处理过这个问题，不能再交回去');
    expect(state.handoffs).toEqual([]);
  });

  test('交接次数用完：返回错误', async () => {
    const [triage, web] = team();
    const state = { visited: new Set(['triage']), handoffs: [{ from: 'x', to: 'y', reason: '', summary: '' }], maxHandoffs: 1 };
    const result = await runToolCall([createTransferTool(triage, web, state)], call('web'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('交接次数已经用完（最多 1 次）');
  });

  test('validateTeam：入口、交接对象、名字', () => {
    expect(() => validateTeam(team(), 'triage')).not.toThrow();
    expect(() => validateTeam(team(), 'boss')).toThrow('入口 boss 不在团队里');
    expect(() => validateTeam([spec('a', ['b'])], 'a')).toThrow('a 要交接给 b，但团队里没有它');
    expect(() => validateTeam([spec('Web-Expert', [])], 'Web-Expert')).toThrow('名字只能用');
  });
});

describeMock('第 26 天：运行团队（TODO 3）', () => {
  test('分诊交给 web，web 用自己的 prompt 和工具回答；它只看到问题和交接说明', async () => {
    llm.reply({ toolCalls: [transfer('web')], usage: { prompt_tokens: 100, completion_tokens: 10 } }).reply({ content: '端口是 7443。', usage: { prompt_tokens: 200, completion_tokens: 20 } });
    const handoffs: string[] = [];
    const result = await runTeam('潮汐协议的端口？', { model: createModel('openai'), agents: team(), entry: 'triage', onHandoff: (x) => handoffs.push(`${x.from}→${x.to}`) });
    expect(result).toMatchObject({ status: 'completed', answer: '端口是 7443。', agent: 'web', steps: 2 });
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    expect(handoffs).toEqual(['triage→web']);
    expect(llm.requests[0].tools!.map((t) => t.function.name)).toEqual(['transfer_to_web', 'transfer_to_docs']);
    expect(llm.requests[1].messages, 'web 从一个新的上下文开始：它的 prompt、问题和交接说明').toEqual([
      { role: 'system', content: '你是 web' },
      { role: 'user', content: handoffInput('潮汐协议的端口？', result.handoffs[0]) },
    ]);
    expect(llm.requests[1].tools!.map((t) => t.function.name)).toEqual(['lookup', 'transfer_to_docs']);
  });

  test('互相踢皮球：web 交给 docs，docs 想交回 web 被拒绝，只好自己回答', async () => {
    llm
      .reply({ toolCalls: [transfer('web')] })
      .reply({ toolCalls: [transfer('docs', '其实是问我们自己的网关')] })
      .reply({ toolCalls: [transfer('web', '文档里没有')] })
      .reply({ content: '文档里没有写，没能查到。' });
    const result = await runTeam('网关的端口？', { model: createModel('openai'), agents: team(), entry: 'triage' });
    expect(result).toMatchObject({ status: 'completed', agent: 'docs', answer: '文档里没有写，没能查到。' });
    expect(result.handoffs.map((x) => `${x.from}→${x.to}`)).toEqual(['triage→web', 'web→docs']);
    expect(llm.requests[3].messages.at(-1)!.content, '拒绝的原因交回给 docs').toContain('不能再交回去');
  });

  test('超出 token 预算：不再交接，停下', async () => {
    llm.reply({ toolCalls: [transfer('web')], usage: { prompt_tokens: 900, completion_tokens: 200 } }).reply({ content: '不该用到这一轮' });
    const result = await runTeam('问题', { model: createModel('openai'), agents: team(), entry: 'triage', tokenBudget: 1000 });
    expect(result).toMatchObject({ status: 'budget', agent: 'triage' });
    expect(llm.pending).toBe(1);
  });

  test('所有 Agent 加起来的步数有上限', async () => {
    llm.reply({ toolCalls: [transfer('web')] }).reply({ toolCalls: [{ name: 'lookup', arguments: { q: '1' } }] }).reply({ toolCalls: [{ name: 'lookup', arguments: { q: '2' } }] });
    const result = await runTeam('问题', { model: createModel('openai'), agents: team(), entry: 'triage', maxTotalSteps: 3 });
    expect(result).toMatchObject({ status: 'max_steps', agent: 'web', steps: 3 });
  });

  test('分诊自己就能回答：不交接', async () => {
    llm.reply({ content: '你好！' });
    const result = await runTeam('你好', { model: createModel('openai'), agents: team(), entry: 'triage' });
    expect(result).toMatchObject({ status: 'completed', agent: 'triage', handoffs: [] });
  });
});

describeMock('第 26 天：研究助手的团队', () => {
  test('三个 Agent 各自的工具；分诊交给 docs，docs 查文档带引用回答', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const { agents } = createResearchTeam(setup);
    expect(Object.fromEntries(agents.map((a) => [a.name, a.tools.map((t) => t.name)]))).toEqual({
      triage: [],
      web: ['calculator', 'web_search', 'fetch_page'],
      docs: ['search_docs', 'grep_docs', 'read_doc'],
    });
    llm
      .reply({ toolCalls: [transfer('docs', '用户问我们网关的回滚命令')] })
      .reply({ toolCalls: [{ name: 'read_doc', arguments: { path: 'ops/oncall.md' } }] })
      .reply({ content: '执行 tide rollback --to previous [1]。' });
    const result = await teamResearch('网关怎么回滚？', setup, { model: createModel('openai') });
    expect(llm.requests[0].messages[0].content).toBe(TRIAGE_PROMPT);
    expect(llm.requests[1].messages[0].content).toBe(DOCS_PROMPT);
    expect(result.agent).toBe('docs');
    expect(result.report.problems).toEqual([]);
    expect(result.text).toContain('来源：\n[1] 本地文档 ops/oncall.md');
    expect(WEB_PROMPT).toContain('交给 docs');
  });
});

describeE2E('第 26 天：真实模型的分诊和交接', () => {
  test('网页的问题交给 web，文档的问题交给 docs，闲聊自己回答', { timeout: 300_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const cases = [
      { question: '潮汐协议 3.0 的发布说明里，默认端口改成了多少？', agent: 'web' },
      { question: '按我们的值班手册，半夜线上出故障应该先做什么？', agent: 'docs' },
      { question: '你好，你是谁？', agent: 'triage' },
    ];
    for (const c of cases) {
      const result = await teamResearch(c.question, setup, { model: createModel('openai') });
      console.log(`\n${c.question}\n→ ${result.handoffs.map((x) => x.to).join(' → ') || '没有交接'}：${result.answer.slice(0, 80)}`);
      expect(result.agent, c.question).toBe(c.agent);
    }
  });
});
