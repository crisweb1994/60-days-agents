import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterAll, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const c = await loadTarget<typeof import('../solution/cost.ts')>(import.meta.url, 'cost.ts');
const { createBudget, withBudget, BudgetExceededError, estimateRequest, createLedger, costBreakdown, formatCostBreakdown, cacheSavings, measureLatency, latencyStats } = c;
const { toBatchJSONL, parseBatchOutput, createBatchClient } = await loadTarget<typeof import('../solution/batch.ts')>(import.meta.url, 'batch.ts');
const { costReduction, withConfig } = await loadTarget<typeof import('../solution/eval/optimize.ts')>(import.meta.url, 'eval/optimize.ts');
const { createModel, createCheapModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { withFailover } = await loadTarget<typeof import('../solution/failover.ts')>(import.meta.url, 'failover.ts');
const { withRetry } = await loadTarget<typeof import('../solution/retry.ts')>(import.meta.url, 'retry.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { evaluate } = await loadTarget<typeof import('../solution/eval/ci.ts')>(import.meta.url, 'eval/ci.ts');
const { compareRecords, formatComparison } = await loadTarget<typeof import('../solution/eval/regression.ts')>(import.meta.url, 'eval/regression.ts');
const { parseDataset, selectCases } = await loadTarget<typeof import('../solution/eval/dataset.ts')>(import.meta.url, 'eval/dataset.ts');
const { factsGrader } = await loadTarget<typeof import('../solution/eval/graders.ts')>(import.meta.url, 'eval/graders.ts');
const { researchTarget } = await loadTarget<typeof import('../solution/eval/run.ts')>(import.meta.url, 'eval/run.ts');

type Model = import('../solution/types.ts').Model;
const PRICE = { input: 2, cachedInput: 0.2, output: 8 }; // 元/百万 token
const usage = (input: number, output: number, cached = 0) => ({ inputTokens: input, cachedTokens: cached, outputTokens: output, reasoningTokens: 0 });
const ask = (model: Model, content = '你好') => model.chat({ messages: [{ role: 'user', content }] });

describe('第 36 天：预算（TODO 1）', () => {
  test('charge 记账，check 超了就抛出；任务花的钱也算在上级里', () => {
    const user = createBudget({ name: '用户 u1 今天', limit: 0.01, price: PRICE });
    const task = createBudget({ name: '这个任务', limit: 0.008, price: PRICE, parent: user });
    task.charge(usage(1000, 500)); // 0.002 + 0.004 = 0.006 元
    expect(task.spent()).toBeCloseTo(0.006);
    expect(user.spent(), '上级也要记上').toBeCloseTo(0.006);
    expect(task.remaining()).toBeCloseTo(0.002);
    expect(() => task.check(0.001)).not.toThrow();
    expect(() => task.check(0.003)).toThrow(BudgetExceededError);
    const other = createBudget({ name: '另一个任务', limit: 1, price: PRICE, parent: user });
    let error: unknown;
    try {
      other.check(0.005);
    } catch (e) {
      error = e;
    }
    expect((error as Error).message, '自己的预算够，但上级不够了，说的是上级').toBe('用户 u1 今天的预算不够了：已经花了 0.0060 元，上限 0.0100 元，这次调用估计还要 0.0050 元');
  });

  test('createLedger：同一个用户同一天的任务共用一个上级；第二天重新算', () => {
    let now = new Date('2026-11-07T10:00:00Z');
    const ledger = createLedger({ price: PRICE, perUserDaily: 1, perTask: 0.5, now: () => now });
    ledger.taskBudget('u1').charge(usage(100_000, 0)); // 0.2 元
    ledger.taskBudget('u1').charge(usage(100_000, 0));
    ledger.taskBudget('u2').charge(usage(100_000, 0));
    expect(ledger.spentToday('u1')).toBeCloseTo(0.4);
    expect(ledger.spentToday('u2')).toBeCloseTo(0.2);
    now = new Date('2026-11-08T10:00:00Z');
    expect(ledger.spentToday('u1')).toBe(0);
  });
});

describeMock('第 36 天：带预算的模型（TODO 2）', () => {
  test('withBudget：调用之后按实际用量记账；估计会超就不调用', async () => {
    const budget = createBudget({ name: '这次研究', limit: 0.002, price: PRICE });
    const model = withBudget(createModel('openai'), budget, { expectedOutput: 100 });
    llm.reply({ content: '好', usage: { prompt_tokens: 500, completion_tokens: 50 } });
    await ask(model);
    expect(budget.spent()).toBeCloseTo((500 * 2 + 50 * 8) / 1e6);
    // 还剩 0.0006 元；一条很长的消息估计要 1000 多 token，加上 100 输出，超了
    await expect(ask(model, '长'.repeat(2000))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(llm.requests, '超了就不该调用模型').toHaveLength(1);
  });

  test('估算包括消息和工具定义', () => {
    const plain = estimateRequest({ messages: [{ role: 'user', content: '你好' }] }, 10);
    const withTools = estimateRequest({ messages: [{ role: 'user', content: '你好' }], tools: [{ type: 'function', function: { name: 'web_search', description: '搜索'.repeat(50), parameters: {} } }] }, 10);
    expect(plain.outputTokens).toBe(10);
    expect(withTools.inputTokens).toBeGreaterThan(plain.inputTokens);
  });

  test('预算用完不是模型的错误：不重试，也不换模型', async () => {
    const budget = createBudget({ name: '这次研究', limit: 0, price: PRICE });
    let backupCalls = 0;
    const backup: Model = { name: 'backup', chat: async () => (backupCalls++, { message: { role: 'assistant', content: '' }, finishReason: 'stop', usage: usage(0, 0) }) };
    const model = withFailover([withRetry(withBudget(createModel('openai'), budget)), backup]);
    await expect(ask(model)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(backupCalls).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });
});

describe('第 36 天：成本分解和缓存（TODO 3）', () => {
  test('costBreakdown：按花费从多到少，算出占比', () => {
    const rows = costBreakdown({ plan: usage(500, 50), subagents: usage(40_000, 2000), report: usage(6000, 800), verify: usage(0, 0) }, PRICE);
    expect(rows.map((r) => r.step)).toEqual(['subagents', 'report', 'plan', 'verify']);
    expect(rows[0].cost).toBeCloseTo((40_000 * 2 + 2000 * 8) / 1e6);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1);
    expect(rows[3].share).toBe(0);
    expect(formatCostBreakdown(rows)).toContain('| subagents | 40000 | 2000 | 0.0960 元 |');
    expect(costBreakdown({ a: usage(0, 0) }, PRICE)[0].share, '总花费是 0 时占比是 0').toBe(0);
  });

  test('cacheSavings：命中缓存省了多少', () => {
    const s = cacheSavings([usage(10_000, 100, 8000), usage(10_000, 100, 0)], PRICE);
    expect(s.withoutCache).toBeCloseTo((20_000 * 2 + 200 * 8) / 1e6);
    expect(s.actual).toBeCloseTo((2000 * 2 + 8000 * 0.2 + 10_000 * 2 + 200 * 8) / 1e6);
    expect(s.saved).toBeCloseTo(8000 * 1.8 / 1e6);
    expect(s.hitRate).toBe(0.4);
  });
});

describeMock('第 36 天：延迟（TODO 4）', () => {
  test('measureLatency：首字延迟和总耗时；只调用了工具时没有首字延迟', async () => {
    let t = 0;
    const fakeClock = () => (t += 100);
    const model = measureLatency(createModel('openai'), fakeClock);
    llm.reply({ content: '你好呀' }).reply({ toolCalls: [{ name: 'web_search', arguments: { query: 'x' } }] });
    const seen: string[] = [];
    await model.chat({ messages: [{ role: 'user', content: '你好' }] }, { onText: (x) => seen.push(x) });
    await ask(model);
    expect(seen.join(''), '调用方的 onText 照样能收到').toBe('你好呀');
    expect(model.records[0].ttftMs).toBe(100);
    expect(model.records[0].ms).toBeGreaterThan(model.records[0].ttftMs!);
    expect(model.records[1]).not.toHaveProperty('ttftMs');
  });

  test('latencyStats', () => {
    const stats = latencyStats([{ ms: 1000, ttftMs: 200 }, { ms: 3000, ttftMs: 400 }, { ms: 2000 }]);
    expect(stats).toEqual({ calls: 3, p50: 2000, p90: 3000, ttftP50: 200, ttftP90: 400 });
    expect(latencyStats([{ ms: 5 }])).toEqual({ calls: 1, p50: 5, p90: 5 });
  });
});

/** 假的批处理接口：/files 收文件，/batches 建任务，立刻完成，结果文件里每个请求回一句话（倒序，故意打乱） */
const uploads: string[] = [];
const batchServer = createServer(async (req, res) => {
  const json = (data: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  if (req.headers.authorization !== 'Bearer k') return res.writeHead(401).end('{"error":{"message":"bad key"}}');
  const url = req.url ?? '';
  if (url === '/v1/files' && req.method === 'POST') {
    const body = await text(req);
    uploads.push(body);
    return json({ id: 'file-in', purpose: 'batch' });
  }
  if (url === '/v1/batches' && req.method === 'POST') return json({ id: 'batch_1', status: 'validating', ...JSON.parse(await text(req)) });
  if (url === '/v1/batches/batch_1') return json({ id: 'batch_1', status: 'completed', output_file_id: 'file-out' });
  if (url === '/v1/files/file-out/content') {
    const lines = uploads.at(-1)!.split(/\r?\n/).filter((l) => l.startsWith('{"custom_id"'));
    const out = lines.reverse().map((l) => {
      const { custom_id } = JSON.parse(l);
      return JSON.stringify({ id: `r-${custom_id}`, custom_id, response: { status_code: 200, body: { choices: [{ message: { role: 'assistant', content: `答 ${custom_id}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } } }, error: null });
    });
    return res.writeHead(200).end(out.join('\n'));
  }
  res.writeHead(404).end('{}');
});
await new Promise<void>((resolve) => batchServer.listen(0, '127.0.0.1', resolve));
const batchURL = `http://127.0.0.1:${(batchServer.address() as AddressInfo).port}/v1`;
afterAll(() => new Promise<void>((resolve) => batchServer.close(() => resolve())));

describe('第 36 天：批处理（TODO 5）', () => {
  test('toBatchJSONL：每行一个请求，body 和实时调用一样但不带 stream', () => {
    const jsonl = toBatchJSONL([{ customId: 'a', request: { messages: [{ role: 'user', content: '你好' }], temperature: 0 } }, { customId: 'b', request: { messages: [{ role: 'user', content: '再见' }] } }], 'my-model');
    const lines = jsonl.split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ custom_id: 'a', method: 'POST', url: '/v1/chat/completions', body: { model: 'my-model', messages: [{ role: 'user', content: '你好' }], temperature: 0 } });
    expect(lines[1].custom_id).toBe('b');
    expect(() => toBatchJSONL([{ customId: 'a', request: { messages: [] } }, { customId: 'a', request: { messages: [] } }], 'm')).toThrow('custom_id 重复');
  });

  test('parseBatchOutput：按 custom_id 对上；失败的记下原因', () => {
    const out = [
      JSON.stringify({ custom_id: 'b', response: { status_code: 200, body: { choices: [{ message: { role: 'assistant', content: '再见' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } } }, error: null }),
      JSON.stringify({ custom_id: 'a', response: { status_code: 400, body: { error: { message: '参数不对' } } }, error: null }),
      JSON.stringify({ custom_id: 'c', response: null, error: { code: 'batch_expired', message: '过期了' } }),
      '',
    ].join('\n');
    const results = parseBatchOutput(out);
    expect(results.get('b')).toEqual({ ok: true, result: { message: { role: 'assistant', content: '再见' }, finishReason: 'stop', usage: usage(7, 2, 4) } });
    expect(results.get('a')).toEqual({ ok: false, error: '参数不对' });
    expect(results.get('c')).toEqual({ ok: false, error: '过期了' });
  });

  test('createBatchClient：上传、创建、等待、下载结果', async () => {
    const client = createBatchClient({ baseURL: batchURL, apiKey: 'k' });
    const job = await client.submit(toBatchJSONL([{ customId: 'q1', request: { messages: [{ role: 'user', content: '1' }] } }, { customId: 'q2', request: { messages: [{ role: 'user', content: '2' }] } }], 'm'));
    expect(job).toMatchObject({ id: 'batch_1', input_file_id: 'file-in', endpoint: '/v1/chat/completions', completion_window: '24h' });
    const done = await client.wait(job.id, { intervalMs: 1 });
    const results = await client.results(done);
    expect([...results.keys()].sort()).toEqual(['q1', 'q2']);
    expect(results.get('q1')).toMatchObject({ ok: true, result: { message: { content: '答 q1' } } });
    await expect(createBatchClient({ baseURL: batchURL, apiKey: 'wrong' }).get('batch_1')).rejects.toThrow('401');
  });
});

describe('第 36 天：省了多少', () => {
  test('costReduction：有单价比花费，没有就按加权的 token 比', () => {
    const cost = (base: number | undefined, cand: number | undefined, bu = usage(1000, 100), cu = usage(500, 50)) =>
      ({ cost: { baseline: { usage: bu, costPerCase: base, medianMs: 0, errors: 0 }, candidate: { usage: cu, costPerCase: cand, medianMs: 0, errors: 0 } } }) as any;
    expect(costReduction(cost(0.01, 0.006))).toBeCloseTo(0.4);
    expect(costReduction(cost(undefined, undefined))).toBeCloseTo(0.5);
    expect(costReduction(cost(undefined, undefined, usage(1000, 0), usage(0, 250)))).toBeCloseTo(0);
  });
});

describeMock('第 36 天：网页分页是一个省钱的旋钮', () => {
  test('pageSize 调小，fetch_page 交给模型的正文就短了', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/long.html` } }] }).reply({ content: '答案藏在最后一段 [1]。' });
    await research('长文章说了什么？', await withConfig(async () => setup, { name: 'lean', model: createModel('openai'), pageSize: 500 })(), { model: createModel('openai') });
    const toolMessage = llm.requests[1].messages.find((m) => m.role === 'tool')!;
    expect(String(toolMessage.content).length).toBeLessThan(1000);
    expect(toolMessage.content).toContain('用 page=2 读下一页');
  });
});

describeE2E('第 36 天：在评估分数不下降的前提下降低成本', () => {
  test('精简版（便宜的模型、更短的分页、更少的步数）对比基线', { timeout: 1_800_000 }, async () => {
    const text = await (await import('node:fs/promises')).readFile(new URL('../data/eval/research.jsonl', import.meta.url), 'utf8');
    const cases = selectCases(parseDataset(text), { tags: ['web', 'docs'], limit: 8 });
    const configs = [
      { name: 'baseline', model: createModel('openai') },
      { name: 'lean', model: createCheapModel(), pageSize: 2000, maxSteps: 8 },
    ];
    const records = [];
    for (const config of configs) {
      const target = researchTarget(withConfig(() => makeSetup(import.meta.url, fixture), config), config.model, { maxSteps: config.maxSteps });
      records.push(await evaluate(cases, target, { name: config.name, model: config.model, datasetText: text, graders: [factsGrader] }));
    }
    const comparison = compareRecords(records[0], records[1]);
    const reduction = costReduction(comparison);
    console.log(`\n${formatComparison(comparison)}\n\n成本降低了 ${Math.round(reduction * 100)}%（没有单价时按加权的 token 估算）`);
    expect(comparison.graders[0].delta, '分数掉了超过 10 个百分点：精简得太狠了').toBeGreaterThanOrEqual(-0.1);
    expect(reduction, '成本应该降低 30% 以上。CHEAP_MODEL 没配的话，两边是同一个模型，只靠分页和步数很难降够').toBeGreaterThanOrEqual(0.3);
  });
});
