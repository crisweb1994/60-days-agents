import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const f = await loadTarget<typeof import('../solution/failover.ts')>(import.meta.url, 'failover.ts');
const { createCooldowns, runWithFailover, withFailover, withSearchFailover, AllFailedError } = f;
const { createDeadline, withDeadline, DeadlineExceededError } = await loadTarget<typeof import('../solution/deadline.ts')>(import.meta.url, 'deadline.ts');
const { openCheckpoint } = await loadTarget<typeof import('../solution/checkpoint.ts')>(import.meta.url, 'checkpoint.ts');
const { idempotent, memoryIdempotencyStore, defaultKey } = await loadTarget<typeof import('../solution/idempotency.ts')>(import.meta.url, 'idempotency.ts');
const { faultyModel, faults, failOn, failAlways, failRate, slowModel } = await loadTarget<typeof import('../solution/testing/faults.ts')>(import.meta.url, 'testing/faults.ts');
const { deepResearch } = await loadTarget<typeof import('../solution/deep-research.ts')>(import.meta.url, 'deep-research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { withRetry } = await loadTarget<typeof import('../solution/retry.ts')>(import.meta.url, 'retry.ts');
const { defineTool } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { z } = await import('zod');

type Model = import('../solution/types.ts').Model;

const zero = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
/** 不走网络的假模型：直接回一句话 */
const fake = (name: string, content = `${name} 的回答`): Model => ({ name, chat: async () => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: zero }) });
const ask = (model: Model, options?: Parameters<Model['chat']>[1]) => model.chat({ messages: [{ role: 'user', content: '你好' }] }, options);

describe('第 35 天：递增的冷却（TODO 1）', () => {
  test('连续失败，冷却翻倍，最多 maxMs；成功一次就清零', () => {
    let now = 0;
    const c = createCooldowns({ baseMs: 1000, maxMs: 5000, now: () => now });
    expect(c.available('a')).toBe(true);
    expect(c.fail('a')).toBe(1000);
    expect(c.available('a')).toBe(false);
    expect(c.remaining('a')).toBe(1000);
    now = 1000;
    expect(c.available('a'), '冷却到点就能用了').toBe(true);
    expect(c.fail('a'), '第二次失败：2 秒').toBe(2000);
    expect(c.fail('a')).toBe(4000);
    expect(c.fail('a'), '最多 5 秒').toBe(5000);
    expect(c.failures('a')).toBe(4);
    c.succeed('a');
    expect(c.available('a')).toBe(true);
    expect(c.failures('a')).toBe(0);
    expect(c.fail('a'), '清零以后从头算').toBe(1000);
  });
});

describe('第 35 天：故障转移（TODO 2）', () => {
  test('首选挂了换备用；挂了的那家在冷却期间直接跳过', async () => {
    let now = 0;
    const cooldowns = createCooldowns({ baseMs: 1000, now: () => now });
    const primary = faultyModel(fake('primary'), failOn([1]));
    const backup = faultyModel(fake('backup'), () => undefined);
    const switched: string[] = [];
    const model = withFailover([primary, backup], { cooldowns, onFailover: (e) => switched.push(`${e.from} → ${e.to}（冷却 ${e.cooldownMs}）`) });
    expect(model.name).toBe('failover(primary, backup)');
    expect((await ask(model)).message.content).toBe('backup 的回答');
    expect(switched).toEqual(['primary → backup（冷却 1000）']);
    expect((await ask(model)).message.content, '冷却期间不再去撞首选').toBe('backup 的回答');
    expect(primary.calls).toBe(1);
    now = 1000;
    expect((await ask(model)).message.content, '冷却结束，回到首选').toBe('primary 的回答');
    expect(cooldowns.failures('primary'), '成功一次就清零').toBe(0);
  });

  test('请求本身有问题（400）：换一家也没用，直接抛出', async () => {
    const backup = faultyModel(fake('backup'), () => undefined);
    const model = withFailover([faultyModel(fake('primary'), failAlways(faults.badRequest)), backup]);
    await expect(ask(model)).rejects.toThrow('参数不对');
    expect(backup.calls).toBe(0);
  });

  test('都失败了：AllFailedError 带着每一次的错误', async () => {
    const model = withFailover([faultyModel(fake('a'), failAlways(faults.rateLimit)), faultyModel(fake('b'), failAlways(faults.quota))]);
    const error = await ask(model).catch((e) => e);
    expect(error).toBeInstanceOf(AllFailedError);
    expect(error.attempts.map((a: { name: string; kind: string }) => [a.name, a.kind])).toEqual([['a', 'rate_limit'], ['b', 'quota']]);
  });

  test('都在冷却中：按冷却剩得最少的先试，总比直接报错好', async () => {
    let now = 0;
    const cooldowns = createCooldowns({ baseMs: 1000, now: () => now });
    cooldowns.fail('a');
    cooldowns.fail('a'); // a 冷却 2 秒
    cooldowns.fail('b'); // b 冷却 1 秒
    const tried: string[] = [];
    const result = await runWithFailover([{ name: 'a' }, { name: 'b' }], async (c) => {
      tried.push(c.name);
      return c.name;
    }, { cooldowns });
    expect(result).toBe('b');
    expect(tried).toEqual(['b']);
  });

  test('用户取消了：不换', async () => {
    const controller = new AbortController();
    const backup = faultyModel(fake('backup'), () => undefined);
    const primary = faultyModel(fake('primary'), () => {
      controller.abort();
      return faults.overloaded();
    });
    await expect(ask(withFailover([primary, backup]), { signal: controller.signal })).rejects.toThrow();
    expect(backup.calls).toBe(0);
  });

  test('已经输出了一部分文字再出错：不换，免得用户看到两段不一样的开头', async () => {
    const halfway: Model = {
      name: 'halfway',
      async chat(_req, options) {
        options?.onText?.('潮汐协议');
        throw faults.overloaded();
      },
    };
    const backup = faultyModel(fake('backup'), () => undefined);
    const shown: string[] = [];
    await expect(ask(withFailover([halfway, backup]), { onText: (t) => shown.push(t) })).rejects.toThrow('503');
    expect(shown).toEqual(['潮汐协议']);
    expect(backup.calls).toBe(0);
  });

  test('搜索服务也能这样切换：出什么错都换下一家', async () => {
    const broken = { name: 'tavily', search: async () => { throw new Error('Tavily 搜索出错：HTTP 432 额度用完'); } };
    const ok = { name: 'bocha', search: async (q: string) => [{ title: q, url: 'https://x', snippet: '' }] };
    const search = withSearchFailover([broken, ok]);
    expect(search.name).toBe('tavily>bocha');
    expect(await search.search('潮汐')).toEqual([{ title: '潮汐', url: 'https://x', snippet: '' }]);
  });
});

describe('第 35 天：总时间预算（TODO 3）', () => {
  test('createDeadline：remaining、expired、within', async () => {
    let now = 0;
    const d = createDeadline(1000, { now: () => now });
    expect(d.remaining()).toBe(1000);
    now = 400;
    expect(d.remaining()).toBe(600);
    expect(d.expired()).toBe(false);
    now = 2000;
    expect(d.remaining(), '不会小于 0').toBe(0);
    expect(d.expired()).toBe(true);
    const short = createDeadline(10_000).within(20);
    await new Promise((r) => setTimeout(r, 40));
    expect(short.aborted, 'within 划出来的那一段先到点').toBe(true);
  });

  test('withDeadline：到点就打断正在进行的调用；过了期限不再发起新的调用', async () => {
    const deadline = createDeadline(50);
    const slow = withDeadline(slowModel(fake('slow'), 1000), deadline);
    const start = Date.now();
    await expect(ask(slow)).rejects.toThrow();
    expect(Date.now() - start, '不用等满 1 秒').toBeLessThan(500);
    const counted = faultyModel(fake('x'), () => undefined);
    await expect(ask(withDeadline(counted, deadline))).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(counted.calls, '期限过了就不该再调用模型').toBe(0);
  });

  test('withDeadline 包在 withRetry 外面：期限到了不再重试', async () => {
    const flaky = faultyModel(slowModel(fake('x'), 30), failAlways(faults.overloaded));
    const model = withDeadline(withRetry(flaky, { maxRetries: 10, sleep: (ms, signal) => new Promise((r, j) => { const t = setTimeout(r, 20); signal?.addEventListener('abort', () => { clearTimeout(t); j(signal.reason); }); }) }), createDeadline(80));
    await expect(ask(model)).rejects.toThrow();
    expect(flaky.calls).toBeLessThan(5);
  });
});

describe('第 35 天：检查点（TODO 4）', () => {
  test('做过的步骤直接拿存下的结果；出错的不存；重新打开还在', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'day35-')), 'run', 'checkpoint.json');
    const cp = await openCheckpoint(file);
    let runs = 0;
    expect(await cp.step('plan', async () => (runs++, { steps: ['甲'] }))).toEqual({ steps: ['甲'] });
    expect(await cp.step('plan', async () => (runs++, { steps: ['乙'] }))).toEqual({ steps: ['甲'] });
    expect(runs).toBe(1);
    await expect(cp.step('report', async () => { throw new Error('模型挂了'); })).rejects.toThrow('模型挂了');
    expect(cp.has('report'), '出错的步骤不存，下次还要再做').toBe(false);
    await Promise.all([cp.set('a', 1), cp.set('b', 2), cp.set('c', 3)]);
    const reopened = await openCheckpoint(file);
    expect(reopened.keys()).toEqual(['plan', 'a', 'b', 'c']);
    expect(JSON.parse(await readFile(file, 'utf8')).c).toBe(3);
  });
});

describe('第 35 天：幂等和故障注入', () => {
  test('idempotent：有副作用的调用同样的参数只执行一次；只读的照常执行', async () => {
    let sent = 0;
    let read = 0;
    const post = defineTool({ name: 'post', description: '发出去', risk: 'irreversible', schema: z.object({ to: z.string(), body: z.string() }), execute: () => `已发送（第 ${++sent} 次）` });
    const get = defineTool({ name: 'get', description: '读', schema: z.object({}), execute: () => `读了 ${++read} 次` });
    const store = memoryIdempotencyStore();
    const [p, g] = idempotent([post, get], store);
    expect(await p.execute({ to: 'a', body: 'x' }, {})).toBe('已发送（第 1 次）');
    expect(await p.execute({ body: 'x', to: 'a' }, {}), '参数顺序不同也是同一个调用').toBe('（这个操作已经执行过，没有重复执行）\n已发送（第 1 次）');
    expect(await p.execute({ to: 'b', body: 'x' }, {})).toBe('已发送（第 2 次）');
    await g.execute({}, {});
    expect(await g.execute({}, {})).toBe('读了 2 次');
    expect(store.size).toBe(2);
    expect(defaultKey('t', { b: 1, a: { d: 2, c: 3 } })).toBe('t:{"a":{"c":3,"d":2},"b":1}');
  });

  test('failRate 用固定的随机数序列，结果可以复现', async () => {
    const sequence = [0.1, 0.9, 0.2, 0.8];
    let i = 0;
    const model = faultyModel(fake('x'), failRate(0.5, faults.overloaded, () => sequence[i++]));
    const results = await Promise.allSettled([ask(model), ask(model), ask(model), ask(model)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'rejected', 'fulfilled']);
  });
});

describeMock('第 35 天：深度研究的优雅降级和检查点（TODO 5）', () => {
  test('时间预算：慢的子 Agent 不等了，用已经查到的写报告；剩的时间不够就跳过核查', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ content: '{"steps": ["查甲", "查乙"]}' })
      .reply({ content: '甲的结论：延迟 18 毫秒 [1]。', match: '子问题：查甲' })
      .reply({ content: '乙的结论。', match: '子问题：查乙', delayMs: 2000 })
      .reply({ content: '# 报告\n\n## 结论\n只查到了甲。', delayMs: 450 });
    const start = Date.now();
    const result = await deepResearch('问题', setup, { model: createModel('openai'), timeBudgetMs: 1000, reserveMs: 700 });
    expect(Date.now() - start, '不能等慢的子 Agent 查完').toBeLessThan(1800);
    expect(result.status).toBe('completed');
    expect(result.findings.map((x) => x.status)).toEqual(['completed', 'error']);
    expect(result.findings[1].findings).toBe('（时间预算用完了，没有查完）');
    const reportRequest = llm.requests.at(-1)!;
    expect(reportRequest.messages[1].content, '报告里要注明没查完的').toContain('（时间预算用完了，没有查完）');
    expect(result.report).toContain('只查到了甲');
    expect(result.degraded).toEqual(['子问题 2 超时，没有查完', '时间不够，跳过了核查']);
    expect(result.verification).toBeUndefined();
  });

  test('没有时间预算时 degraded 是空的', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '{"steps": ["查甲"]}' }).reply({ content: '甲。' }).reply({ content: '# 报告' });
    const result = await deepResearch('问题', setup, { model: createModel('openai'), verifyRounds: 0 });
    expect(result.degraded).toEqual([]);
  });

  test('检查点：写报告时出错了，重新运行只写报告，不再规划和调研', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'day35-')), 'checkpoint.json');
    const setup = await makeSetup(import.meta.url, fixture);
    let reviews = 0;
    const review = async () => (reviews++, { action: 'approve' as const });
    llm
      .reply({ content: '{"steps": ["查甲", "查乙"]}' })
      .reply({ content: '甲的结论。', match: '子问题：查甲' })
      .reply({ content: '乙的结论。', match: '子问题：查乙' })
      .fail({ status: 400, message: '写报告的时候出错了' });
    await expect(deepResearch('问题', setup, { model: createModel('openai'), verifyRounds: 0, review, checkpoint: await openCheckpoint(file) })).rejects.toThrow('写报告的时候出错了');
    expect(llm.requests).toHaveLength(4);

    llm.reply({ content: '# 报告\n\n甲和乙。' });
    const result = await deepResearch('问题', setup, { model: createModel('openai'), verifyRounds: 0, review, checkpoint: await openCheckpoint(file) });
    expect(llm.requests, '只多了写报告那一次').toHaveLength(5);
    expect(reviews, '确认过的计划不再问').toBe(1);
    expect(result.findings.map((x) => x.findings)).toEqual(['甲的结论。', '乙的结论。']);
    expect(result.report).toBe('# 报告\n\n甲和乙。');
  });

  test('故障注入：首选模型一直 503，降级链换到备用，深度研究照样完成', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '{"steps": ["查甲"]}' }).reply({ content: '甲。' }).reply({ content: '# 报告' });
    const primary = faultyModel(createModel('openai'), failAlways(faults.overloaded), 'openai:primary');
    const switched: string[] = [];
    const model = withFailover([primary, createModel('openai')], { onFailover: (e) => switched.push(e.from) });
    const result = await deepResearch('问题', setup, { model, verifyRounds: 0 });
    expect(result.report).toBe('# 报告');
    expect(primary.calls, '首选进了冷却，后面的调用直接跳过它').toBe(1);
    expect(switched).toEqual(['openai:primary']);
  });
});

describeE2E('第 35 天：真实模型上的故障注入', () => {
  test('首选模型三次里坏一次，研究照样完成', { timeout: 600_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const primary = faultyModel(createModel('openai'), (call) => (call % 3 === 2 ? faults.overloaded() : undefined), 'openai:flaky');
    const result = await deepResearch('潮汐协议 3.0 和 2.x 的延迟各是多少？', setup, {
      model: withFailover([primary, createModel('openai')], { onFailover: (e) => console.log(`换模型：${e.from} → ${e.to}`) }),
      timeBudgetMs: 300_000,
    });
    console.log(result.text, result.degraded);
    expect(result.status).toBe('completed');
    expect(result.report).toContain('18');
  });
});
