import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { ROUTE_CASES } from '../data/routes.ts';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { classify, evaluateRouter, formatConfusion, parseRoute, routeQuestion, ROUTER_PROMPT } = await loadTarget<
  typeof import('../solution/router.ts')
>(import.meta.url, 'router.ts');
const { createOpenAIModel } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');
const { createCheapModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const cheap = () => createOpenAIModel({ baseURL: llm.baseURL, apiKey: 'mock-key', model: 'cheap-model' });
const strong = () => createOpenAIModel({ baseURL: llm.baseURL, apiKey: 'mock-key', model: 'strong-model' });

describe('第 22 天：解析分类结果（TODO 3）', () => {
  test('JSON、包在代码块里的 JSON、只提到一个类别的文字', () => {
    expect(parseRoute('{"route": "docs", "reason": "问的是我们的网关"}')).toBe('docs');
    expect(parseRoute('```json\n{"route": "chat"}\n```')).toBe('chat');
    expect(parseRoute('这个问题应该走 research。')).toBe('research');
  });

  test('不认识的类别、提到好几个类别、什么都没有：解析不了', () => {
    expect(parseRoute('{"route": "web"}')).toBeUndefined();
    expect(parseRoute('可以是 chat 也可以是 docs')).toBeUndefined();
    expect(parseRoute('我不知道')).toBeUndefined();
  });
});

describeMock('第 22 天：用便宜的模型分类（TODO 3）', () => {
  test('分类一次：用 ROUTER_PROMPT，限制输出长度', async () => {
    llm.reply({ content: '{"route": "chat"}', usage: { prompt_tokens: 300, completion_tokens: 8 } });
    const result = await classify('你好', cheap());
    expect(result).toMatchObject({ route: 'chat', votes: ['chat'], agreement: 1, fallback: false });
    expect(result.usage.inputTokens).toBe(300);
    expect(llm.requests[0]).toMatchObject({ model: 'cheap-model', max_tokens: 200 });
    expect(llm.requests[0].messages).toEqual([
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: '你好' },
    ]);
  });

  test('分类三次：同时发出三个请求，取多数，用量加在一起', async () => {
    for (const route of ['docs', 'research', 'docs']) llm.reply({ content: `{"route": "${route}"}`, delayMs: 200, usage: { prompt_tokens: 100, completion_tokens: 5 } });
    const start = performance.now();
    const result = await classify('潮汐网关怎么部署？', cheap(), { votes: 3 });
    expect(performance.now() - start, '三个请求要同时发，不是一个接一个（那要 600 毫秒）').toBeLessThan(450);
    expect(result).toMatchObject({ route: 'docs', agreement: 2 / 3, fallback: false });
    expect(result.votes.toSorted()).toEqual(['docs', 'docs', 'research']);
    expect(result.usage.inputTokens).toBe(300);
  });

  test('一次都解析不了：走最稳妥的 research', async () => {
    llm.reply({ content: '嗯……' }).reply({ content: '{"route": "unknown"}' });
    expect(await classify('？', cheap(), { votes: 2 })).toMatchObject({ route: 'research', votes: [], fallback: true });
  });
});

describeMock('第 22 天：按类别交给不同的模型和工具（TODO 4）', () => {
  test('chat：便宜的模型直接回答，不带工具', async () => {
    llm.reply({ content: '{"route": "chat"}', usage: { prompt_tokens: 100, completion_tokens: 5 } }).reply({ content: '你好！', usage: { prompt_tokens: 50, completion_tokens: 3 } });
    const setup = await makeSetup(import.meta.url, fixture);
    const answer = await routeQuestion('你好', { router: cheap(), cheap: cheap(), strong: strong(), setup, now: () => new Date(2026, 10, 4) });
    expect(answer).toMatchObject({ route: 'chat', text: '你好！', model: 'openai:cheap-model' });
    expect(llm.requests[1].model).toBe('cheap-model');
    expect(llm.requests[1].tools).toBeUndefined();
    expect(llm.requests[1].messages.at(-1)!.content).toContain('今天是 2026-11-04');
    expect(answer.usage, '分类和回答的用量都要算上').toMatchObject({ inputTokens: 150, outputTokens: 8 });
  });

  test('docs：便宜的模型，只带本地文档的工具，回答后面附上来源', async () => {
    llm
      .reply({ content: '{"route": "docs"}' })
      .reply({ toolCalls: [{ name: 'grep_docs', arguments: { pattern: 'tide rollback' } }] })
      .reply({ toolCalls: [{ name: 'read_doc', arguments: { path: 'ops/oncall.md' } }] })
      .reply({ content: '执行 tide rollback --to previous [1]。' });
    const setup = await makeSetup(import.meta.url, fixture);
    const answer = await routeQuestion('我们的网关怎么回滚？', { router: cheap(), cheap: cheap(), strong: strong(), setup });
    expect(answer.route).toBe('docs');
    expect(llm.requests[1].model).toBe('cheap-model');
    expect(llm.requests[1].tools!.map((t) => t.function.name).toSorted()).toEqual(['grep_docs', 'read_doc', 'search_docs']);
    expect(llm.requests[1].messages[0].content).toContain('内部文档');
    expect(answer.text).toContain('来源：\n[1] 本地文档 ops/oncall.md');
  });

  test('research：强的模型，完整的研究助手', async () => {
    llm.reply({ content: '{"route": "research"}' }).reply({ content: '我没有查到。' });
    const setup = await makeSetup(import.meta.url, fixture);
    const answer = await routeQuestion('潮汐协议 3.0 什么时候发布？', { router: cheap(), cheap: cheap(), strong: strong(), setup });
    expect(answer).toMatchObject({ route: 'research', model: 'openai:strong-model' });
    expect(llm.requests[1].model).toBe('strong-model');
    expect(llm.requests[1].messages[0].content).toContain('研究助手');
    expect(llm.requests[1].tools!.map((t) => t.function.name)).toContain('web_search');
  });

  test('分到 docs，但没有配置本地文档：改走 research', async () => {
    llm.reply({ content: '{"route": "docs"}' }).reply({ content: '没有本地文档可查。' });
    const setup = await makeSetup(import.meta.url, fixture);
    const answer = await routeQuestion('我们的网关怎么回滚？', { router: cheap(), cheap: cheap(), strong: strong(), setup: { ...setup, docs: undefined } });
    expect(answer.route).toBe('research');
    expect(llm.requests[1].model).toBe('strong-model');
  });
});

describe('第 22 天：评估路由器（TODO 5）', () => {
  const cases = [
    { question: 'a', route: 'chat' as const },
    { question: 'b', route: 'docs' as const },
    { question: 'c', route: 'docs' as const },
    { question: 'd', route: 'research' as const },
    { question: 'e', route: 'research' as const },
  ];
  const answers: Record<string, string> = { a: 'chat', b: 'docs', c: 'research', d: 'research', e: 'error' };

  test('准确率、混淆矩阵、分错的问题；分类出错也算分错', async () => {
    const result = await evaluateRouter(cases, async (q) => {
      if (answers[q] === 'error') throw new Error('超时');
      return answers[q] as 'chat' | 'docs' | 'research';
    });
    expect(result).toMatchObject({ total: 5, correct: 3, accuracy: 0.6 });
    expect(result.confusion.docs).toEqual({ chat: 0, docs: 1, research: 1 });
    expect(result.confusion.research, '出错的不算进混淆矩阵').toEqual({ chat: 0, docs: 0, research: 1 });
    expect(result.mistakes).toEqual([
      { question: 'c', expected: 'docs', actual: 'research' },
      { question: 'e', expected: 'research', actual: 'error' },
    ]);
    expect(formatConfusion(result.confusion)).toContain('| docs | 0 | 1 | 1 |');
  });

  test('问题之间同时评估，但不超过并发上限', async () => {
    let active = 0;
    let max = 0;
    await evaluateRouter(cases, async () => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return 'chat';
    }, 2);
    expect(max).toBe(2);
  });
});

describeE2E('第 22 天：真实模型的路由准确率（需真实模型）', () => {
  test('在评估集上算准确率，打印混淆矩阵和分错的问题', { timeout: 300_000 }, async () => {
    const model = createCheapModel();
    const result = await evaluateRouter(ROUTE_CASES, async (q) => (await classify(q, model)).route, 2);
    console.log(`\n分类模型 ${model.name}：准确率 ${Math.round(result.accuracy * 100)}%\n\n${formatConfusion(result.confusion)}`);
    for (const m of result.mistakes) console.log(`✗ ${m.question}：应该是 ${m.expected}，分成了 ${m.actual}`);
    expect(result.accuracy).toBeGreaterThanOrEqual(0.7);
  });
});
