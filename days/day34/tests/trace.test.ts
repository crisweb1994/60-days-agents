import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterAll, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const t = await loadTarget<typeof import('../solution/trace.ts')>(import.meta.url, 'trace.ts');
const { createTracer, traceModel, traceTools, toOtlp, toOtlpValue, toNanos, createOtlpExporter, langfuseExporterFromEnv, findFailures, formatTrace, summarizeTrace, buildTree, redact, traceparentOf, parseTraceparent } = t;
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { deepResearch } = await loadTarget<typeof import('../solution/deep-research.ts')>(import.meta.url, 'deep-research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { defineTool } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { z } = await import('zod');

type Span = import('../solution/trace.ts').Span;

/** 固定的 id 和时钟：id 依次是 01、02……，时钟每读一次加 10 毫秒 */
function fakeTracer(options: Parameters<typeof createTracer>[0] = {}) {
  let n = 0;
  let now = 1_000_000;
  return createTracer({ randomHex: (bytes) => String(++n).padStart(bytes * 2, '0'), clock: () => (now += 10), ...options });
}

/** 一个假的 OTLP 收集器：记下收到的请求 */
const received: { auth?: string; body: any }[] = [];
let collectorStatus = 200;
const collector = createServer(async (req, res) => {
  received.push({ auth: req.headers.authorization, body: JSON.parse(await text(req)) });
  res.writeHead(collectorStatus).end(collectorStatus === 200 ? '{}' : 'bad');
});
await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
const collectorURL = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((resolve) => collector.close(() => resolve())));

describe('第 34 天：span 和上下文（TODO 1）', () => {
  test('withSpan 里开始的 span 是它的子 span；同一棵树共用 traceId', async () => {
    const tracer = fakeTracer();
    await tracer.withSpan('invoke_agent research', {}, async () => {
      await tracer.withSpan('chat m', {}, async () => {});
      await tracer.withSpan('execute_tool web_search', {}, async () => {});
    });
    const [chat, tool, root] = tracer.finished;
    expect(root.name).toBe('invoke_agent research');
    expect(root.parentSpanId).toBeUndefined();
    expect(chat.parentSpanId, 'chat 的父 span 是 invoke_agent').toBe(root.spanId);
    expect(tool.parentSpanId).toBe(root.spanId);
    expect(new Set([root.traceId, chat.traceId, tool.traceId]).size).toBe(1);
    expect(root.traceId).toHaveLength(32);
    expect(root.spanId).toHaveLength(16);
    expect(chat.endTime! - chat.startTime).toBeGreaterThan(0);
  });

  test('并行的子任务各自挂在自己的父 span 下面', async () => {
    const tracer = fakeTracer();
    await tracer.withSpan('root', {}, () =>
      Promise.all(
        ['甲', '乙'].map((name) =>
          tracer.withSpan(`sub ${name}`, {}, async () => {
            await new Promise((r) => setTimeout(r, name === '甲' ? 20 : 5));
            await tracer.withSpan(`chat ${name}`, {}, async () => {});
          }),
        ),
      ),
    );
    const byName = Object.fromEntries(tracer.finished.map((s) => [s.name, s]));
    expect(byName['chat 甲'].parentSpanId, '异步上下文要跟着各自的任务走').toBe(byName['sub 甲'].spanId);
    expect(byName['chat 乙'].parentSpanId).toBe(byName['sub 乙'].spanId);
  });

  test('fn 抛出错误：span 记成 error，错误照样抛出，span 照样结束', async () => {
    const tracer = fakeTracer();
    await expect(tracer.withSpan('execute_tool fetch_page', {}, async () => {
      throw new Error('连接被拒绝');
    })).rejects.toThrow('连接被拒绝');
    const [span] = tracer.finished;
    expect(span.status).toEqual({ code: 'error', message: '连接被拒绝' });
    expect(span.attributes['error.type']).toBe('Error');
    expect(span.events[0]).toMatchObject({ name: 'exception', attributes: { 'exception.message': '连接被拒绝' } });
  });

  test('攒够 batchSize 个就导出；导出失败不影响程序', async () => {
    const batches: Span[][] = [];
    const errors: unknown[] = [];
    const tracer = fakeTracer({ batchSize: 2, exporter: { export: async (spans) => void batches.push(spans) }, onExportError: (e) => errors.push(e) });
    for (const name of ['a', 'b', 'c']) await tracer.withSpan(name, {}, async () => {});
    expect(batches.map((b) => b.map((s) => s.name))).toEqual([['a', 'b']]);
    await tracer.flush();
    expect(batches.map((b) => b.map((s) => s.name))).toEqual([['a', 'b'], ['c']]);

    const broken = fakeTracer({ exporter: { export: async () => { throw new Error('收集器挂了'); } }, onExportError: (e) => errors.push(e) });
    await broken.withSpan('x', {}, async () => 1);
    await broken.flush();
    expect(errors).toHaveLength(1);
  });
});

describeMock('第 34 天：给模型和工具加上追踪（TODO 2、3）', () => {
  test('traceModel：按 GenAI 约定记下请求的模型、停止原因和用量', async () => {
    const tracer = fakeTracer();
    llm.reply({ content: '你好', usage: { prompt_tokens: 120, completion_tokens: 8 } });
    const model = traceModel(createModel('openai'), tracer, { provider: 'deepseek' });
    expect(model.name).toBe('openai:mock-model');
    await model.chat({ messages: [{ role: 'user', content: '我的邮箱是 a@b.com' }], temperature: 0.2 });
    const [span] = tracer.finished;
    expect(span.name).toBe('chat mock-model');
    expect(span.kind).toBe('client');
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'deepseek',
      'gen_ai.request.model': 'mock-model',
      'gen_ai.request.temperature': 0.2,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 8,
    });
  });

  test('traceModel：默认不记内容；要记的时候先脱敏', async () => {
    const tracer = fakeTracer();
    llm.reply({ content: '好的' });
    await traceModel(createModel('openai'), tracer, { captureContent: true }).chat({ messages: [{ role: 'user', content: '我的邮箱是 a@b.com，手机 13812345678' }] });
    const input = tracer.finished[0].attributes['gen_ai.input.messages'] as string;
    expect(input).toContain('[邮箱]');
    expect(input).toContain('[手机号]');
    expect(input).not.toContain('a@b.com');
    expect(tracer.finished[0].attributes['gen_ai.provider.name'], '没有指定 provider 就用模型名冒号前面的部分').toBe('openai');
  });

  test('traceModel：出错时记下错误的种类，错误照样抛出', async () => {
    const tracer = fakeTracer();
    llm.fail({ status: 400, message: '参数不对' });
    await expect(traceModel(createModel('openai'), tracer).chat({ messages: [{ role: 'user', content: '你好' }] })).rejects.toThrow();
    expect(tracer.finished[0].status.code).toBe('error');
    expect(tracer.finished[0].attributes['error.type'], '用第 9 天的错误分类').toBe('bad_request');
  });

  test('traceTools：每次执行一个 span，带着工具调用的 id；在 Agent 里，工具的 span 和 chat 的 span 是兄弟', async () => {
    const tracer = fakeTracer();
    const echo = defineTool({ name: 'echo', description: '原样返回', schema: z.object({ text: z.string() }), execute: ({ text }) => text });
    const broken = defineTool({ name: 'broken', description: '总是出错', schema: z.object({}), execute: () => { throw new Error('坏了'); } });
    llm.reply({ toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: '你好' } }, { id: 'call_2', name: 'broken', arguments: {} }] }).reply({ content: '完成' });
    const result = await tracer.withSpan('invoke_agent test', {}, () => runAgent('试试', { model: traceModel(createModel('openai'), tracer), tools: traceTools([echo, broken], tracer) }));
    expect(result.messages.find((m) => m.role === 'tool')?.content, '包了一层，工具照样能用').toBe('你好');
    const spans = tracer.finished;
    const toolSpan = spans.find((s) => s.name === 'execute_tool echo')!;
    expect(toolSpan.attributes).toEqual({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'echo', 'gen_ai.tool.type': 'function', 'gen_ai.tool.call.id': 'call_1' });
    expect(spans.find((s) => s.name === 'execute_tool broken')!.status.code).toBe('error');
    const root = spans.find((s) => s.name === 'invoke_agent test')!;
    expect(spans.filter((s) => s.parentSpanId === root.spanId).map((s) => s.name)).toEqual(['chat mock-model', 'execute_tool echo', 'execute_tool broken', 'chat mock-model']);
  });
});

describe('第 34 天：导出成 OTLP（TODO 4）', () => {
  test('toOtlpValue 和 toNanos', () => {
    expect(toOtlpValue('a')).toEqual({ stringValue: 'a' });
    expect(toOtlpValue(120)).toEqual({ intValue: '120' });
    expect(toOtlpValue(0.2)).toEqual({ doubleValue: 0.2 });
    expect(toOtlpValue(true)).toEqual({ boolValue: true });
    expect(toOtlpValue(['stop'])).toEqual({ arrayValue: { values: [{ stringValue: 'stop' }] } });
    expect(toNanos(1_700_000_000_123)).toBe('1700000000123000000');
  });

  test('toOtlp：resourceSpans → scopeSpans → spans', () => {
    const span: Span = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      name: 'chat m',
      kind: 'client',
      startTime: 1000,
      endTime: 1500,
      attributes: { 'gen_ai.usage.input_tokens': 10 },
      status: { code: 'error', message: '超时' },
      events: [{ name: 'exception', time: 1400, attributes: { 'exception.message': '超时' } }],
    };
    const root: Span = { ...span, spanId: 'c'.repeat(16), parentSpanId: undefined, name: 'root', kind: 'internal', status: { code: 'unset' }, events: [] };
    const body = toOtlp([span, root], 'research-assistant');
    expect(body.resourceSpans[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'research-assistant' } }]);
    const [a, b] = body.resourceSpans[0].scopeSpans[0].spans;
    expect(a).toEqual({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      name: 'chat m',
      kind: 3,
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1500000000',
      attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } }],
      status: { code: 2, message: '超时' },
      events: [{ name: 'exception', timeUnixNano: '1400000000', attributes: [{ key: 'exception.message', value: { stringValue: '超时' } }] }],
    });
    expect(b).not.toHaveProperty('parentSpanId');
    expect(b).toMatchObject({ kind: 1, status: { code: 0 } });
    expect(b.status).not.toHaveProperty('message');
  });

  test('Langfuse 的导出器：OTLP 地址和 Basic 认证', async () => {
    received.length = 0;
    expect(langfuseExporterFromEnv({})).toBeUndefined();
    const exporter = langfuseExporterFromEnv({ LANGFUSE_BASE_URL: `${collectorURL}/`, LANGFUSE_PUBLIC_KEY: 'pk-lf-1', LANGFUSE_SECRET_KEY: 'sk-lf-2' })!;
    const tracer = fakeTracer({ exporter });
    await tracer.withSpan('root', {}, async () => {});
    await tracer.flush();
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe(`Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`);
    expect(received[0].body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('root');

    collectorStatus = 401;
    await expect(createOtlpExporter({ endpoint: collectorURL }).export(tracer.finished as Span[])).rejects.toThrow('401');
    collectorStatus = 200;
  });

  test('traceparent', () => {
    const span = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' } as Span;
    expect(traceparentOf(span)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toEqual({ traceId: span.traceId, spanId: span.spanId });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceparent('乱写的')).toBeUndefined();
  });

  test('redact', () => {
    expect(redact('key sk-abcdefgh12345678，Bearer abc.def.ghijkl，身份证 11010519491231002X')).toBe('key [密钥]，Bearer [密钥]，身份证 [身份证号]');
  });
});

describe('第 34 天：从 trace 定位失败（TODO 5）', () => {
  /** 造一棵树：root → agent →（chat 成功、tool 失败）；另一个 tool 自己失败 */
  function sample(): Span[] {
    const base = { traceId: 't'.repeat(32), kind: 'internal' as const, attributes: {}, events: [] };
    const ok = { code: 'ok' as const };
    const err = (message: string) => ({ code: 'error' as const, message });
    return [
      { ...base, spanId: 'r', name: 'invoke_agent deep_research', startTime: 0, endTime: 100, status: err('子 Agent 出错') },
      { ...base, spanId: 'a', parentSpanId: 'r', name: 'invoke_agent subagent', startTime: 10, endTime: 90, status: err('fetch 失败') },
      { ...base, spanId: 'c', parentSpanId: 'a', name: 'chat m', startTime: 11, endTime: 30, status: ok, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 500, 'gen_ai.usage.output_tokens': 20 } },
      { ...base, spanId: 'f', parentSpanId: 'a', name: 'execute_tool fetch_page', startTime: 31, endTime: 80, status: err('HTTP 404'), attributes: { 'gen_ai.operation.name': 'execute_tool', 'error.type': 'Error' } },
      { ...base, spanId: 'g', parentSpanId: 'r', name: 'execute_tool web_search', startTime: 5, endTime: 8, status: err('限流'), attributes: { 'gen_ai.operation.name': 'execute_tool' } },
    ];
  }

  test('findFailures：只报最底下的那个出错的 span，带上从根到它的路径', () => {
    const failures = findFailures(sample());
    expect(failures.map((f) => [f.span.name, f.path.join(' > ')])).toEqual([
      ['execute_tool web_search', 'invoke_agent deep_research > execute_tool web_search'],
      ['execute_tool fetch_page', 'invoke_agent deep_research > invoke_agent subagent > execute_tool fetch_page'],
    ]);
    expect(findFailures(sample().map((s) => ({ ...s, status: { code: 'ok' as const } })))).toEqual([]);
  });

  test('buildTree、formatTrace、summarizeTrace', () => {
    const roots = buildTree(sample());
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.span.name), '子 span 按开始时间排').toEqual(['execute_tool web_search', 'invoke_agent subagent']);
    const textTree = formatTrace(sample());
    expect(textTree.split('\n')[0]).toContain('invoke_agent deep_research  0.10 秒');
    expect(textTree).toContain('    └ chat m  0.02 秒 · 输入 500 / 输出 20 tokens');
    expect(textTree).toContain('└ execute_tool fetch_page  0.05 秒 · ✗ Error：HTTP 404');
    expect(summarizeTrace(sample())).toEqual({ modelCalls: 1, toolCalls: 2, inputTokens: 500, outputTokens: 20, errors: 4, slowest: { name: 'execute_tool fetch_page', ms: 49 } });
  });
});

describeMock('第 34 天：研究助手的 trace', () => {
  test('research()：invoke_agent 下面挂着每次模型调用和工具调用；读不到的网页能从 trace 里找到', async () => {
    const tracer = fakeTracer();
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/missing.html` } }] })
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 性能' } }] })
      .reply({ content: '3.0 的平均延迟是 18 毫秒 [1]。' });
    const r = await research('3.0 的延迟是多少？', setup, { model: createModel('openai'), tracer });
    expect(r.result.status).toBe('completed');
    const names = tracer.finished.map((s) => s.name);
    expect(names.filter((n) => n.startsWith('chat '))).toHaveLength(3);
    expect(names).toContain('execute_tool fetch_page');
    expect(names.at(-1)).toBe('invoke_agent research');
    const failures = findFailures(tracer.finished);
    expect(failures.map((f) => f.path.join(' > '))).toEqual(['invoke_agent research > execute_tool fetch_page']);
    expect(failures[0].span.status.message).toContain('404');
  });

  test('deepResearch()：每一步一个 span，每个子 Agent 一个 invoke_agent span', async () => {
    const tracer = fakeTracer();
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '{"steps": ["查甲", "查乙"]}' }).reply({ content: '甲的结论。', match: '子问题：查甲' }).reply({ content: '乙的结论。', match: '子问题：查乙' }).reply({ content: '# 报告' });
    await deepResearch('问题', setup, { model: createModel('openai'), verifyRounds: 0, tracer });
    const tree = buildTree(tracer.finished);
    expect(tree).toHaveLength(1);
    expect(tree[0].span.name).toBe('invoke_agent deep_research');
    expect(tree[0].children.map((c) => c.span.name)).toEqual(['plan', 'investigate', 'report']);
    const investigate = tree[0].children[1];
    expect(investigate.children.map((c) => c.span.attributes['research.subquestion']).sort()).toEqual(['查乙', '查甲']);
    for (const sub of investigate.children) expect(sub.children.map((c) => c.span.name)).toEqual(['chat mock-model']);
  });
});

describeE2E('第 34 天：真实模型的 trace', () => {
  test('跑一次研究，打印 trace；配了 Langfuse 就导出过去', async () => {
    const tracer = createTracer({ exporter: langfuseExporterFromEnv() });
    const setup = await makeSetup(import.meta.url, fixture);
    await research('潮汐协议 3.0 和 2.x 的延迟各是多少？', setup, { model: createModel('openai'), tracer });
    await tracer.flush();
    console.log(`\n${formatTrace(tracer.finished)}\n`, summarizeTrace(tracer.finished));
    const summary = summarizeTrace(tracer.finished);
    expect(summary.modelCalls).toBeGreaterThanOrEqual(2);
    expect(summary.inputTokens).toBeGreaterThan(0);
  });
});
