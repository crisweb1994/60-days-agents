import { existsSync } from 'node:fs';
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage } from 'ai';
import { chromium } from 'playwright';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, mode, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const u = await loadTarget<typeof import('../solution/ui-stream.ts')>(import.meta.url, 'ui-stream.ts');
const { toSSE, previewOutput, createChunkEmitter, streamResearch } = u;
const t = await loadTarget<typeof import('../solution/timeline.ts')>(import.meta.url, 'timeline.ts');
const { applyChunk, initialTimeline, createSSEDecoder, progressLabel } = t;
const w = await loadTarget<typeof import('../solution/web-server.ts')>(import.meta.url, 'web-server.ts');
const { startWebApp, browserTimeline } = w;
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { EXPLICIT_LABEL } = await loadTarget<typeof import('../solution/compliance.ts')>(import.meta.url, 'compliance.ts');

type Chunk = import('../solution/ui-stream.ts').ResearchChunk;
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
type Timeline = import('../solution/timeline.ts').Timeline;
const reduce = (chunks: object[]): Timeline => chunks.reduce<Timeline>((s, c) => applyChunk(s, c as never), initialTimeline());

describe('第 44 天：把回调变成块（TODO 1）', () => {
  test('工具调用、每一步的文字分开；结果截断', () => {
    const chunks: Chunk[] = [];
    const e = createChunkEmitter((c) => chunks.push(c));
    e.onText('先查');
    e.onText('一下');
    e.onToolStart(call('c1', 'web_search', { query: '端口' }));
    e.onToolCall(call('c1', 'web_search', {}), { content: 'x'.repeat(3000), isError: false });
    e.onToolStart(call('c2', 'fetch_page', { url: 'u' }));
    e.onToolCall(call('c2', 'fetch_page', {}), { content: '打不开', isError: true });
    e.onUsage();
    e.onText('答案');
    e.onUsage();
    e.onUsage();
    expect(chunks.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-delta', 'text-end', 'tool-input-available', 'tool-output-available', 'tool-input-available', 'tool-output-error', 'text-start', 'text-delta', 'text-end']);
    expect(chunks[0]).toEqual({ type: 'text-start', id: 'text-1' });
    expect(chunks[8]).toEqual({ type: 'text-start', id: 'text-2' });
    expect(chunks[4]).toEqual({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_search', input: { query: '端口' }, dynamic: true });
    expect((chunks[5] as { output: string }).output).toBe(previewOutput('x'.repeat(3000)));
    expect(previewOutput('x'.repeat(3000))).toMatch(/…（共 3000 字）$/);
    expect(chunks[7]).toEqual({ type: 'tool-output-error', toolCallId: 'c2', errorText: '打不开', dynamic: true });
  });

  test('深度研究的事件变成 data-progress', () => {
    const chunks: Chunk[] = [];
    const e = createChunkEmitter((c) => chunks.push(c));
    e.onDeepEvent({ type: 'plan', plan: { question: 'q', subquestions: ['a', 'b'], fallback: false } });
    e.onDeepEvent({ type: 'subagent', index: 1, result: { task: { question: 'b', context: '' }, status: 'completed', findings: '', usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }, steps: 1, toolCalls: 0 } });
    e.onDeepEvent({ type: 'report' });
    expect(chunks).toEqual([
      { type: 'data-progress', data: { stage: 'plan', subquestions: ['a', 'b'] } },
      { type: 'data-progress', id: 'subagent-1', data: { stage: 'subagent', index: 1, question: 'b', status: 'completed' } },
      { type: 'data-progress', data: { stage: 'report' } },
    ]);
  });

  test('toSSE', () => {
    expect(toSSE({ type: 'start' })).toBe('data: {"type":"start"}\n\n');
    expect(toSSE('[DONE]')).toBe('data: [DONE]\n\n');
  });
});

describe('第 44 天：前端的状态（TODO 3）', () => {
  test('applyChunk：按块归并成时间线，不改旧的状态', () => {
    const s0 = applyChunk(initialTimeline(), { type: 'start' });
    const s1 = applyChunk(s0, { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_search', input: { query: 'x' } });
    expect(s0.items, '不改旧的状态').toEqual([]);
    const s = [
      { type: 'tool-output-available', toolCallId: 'c1', output: '结果' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '默认' },
      { type: 'text-delta', id: 'text-1', delta: '端口' },
      { type: 'text-end', id: 'text-1' },
      { type: 'data-progress', id: 'subagent-0', data: { stage: 'subagent', index: 0, question: 'a', status: 'error' } },
      { type: 'data-progress', id: 'subagent-0', data: { stage: 'subagent', index: 0, question: 'a', status: 'completed' } },
      { type: 'source-url', sourceId: '1', url: 'https://a', title: 'A' },
      { type: 'source-url', sourceId: '1', url: 'https://a', title: 'A' },
      { type: 'data-answer', data: { text: '全文', status: 'completed' } },
      { type: 'something-new', foo: 1 },
      { type: 'finish' },
    ].reduce((acc, c) => applyChunk(acc, c), s1);
    expect(s).toEqual({
      status: 'done',
      items: [
        { kind: 'tool', id: 'c1', name: 'web_search', input: { query: 'x' }, status: 'done', output: '结果' },
        { kind: 'text', id: 'text-1', text: '默认端口', done: true },
        { kind: 'progress', id: 'subagent-0', label: '子问题 1「a」查完了' },
      ],
      sources: [{ id: '1', url: 'https://a', title: 'A' }],
      answer: { text: '全文', status: 'completed' },
    });
  });

  test('出错、停止', () => {
    const errored = reduce([{ type: 'start' }, { type: 'error', errorText: '出了点问题' }, { type: 'finish' }]);
    expect(errored).toMatchObject({ status: 'error', error: '出了点问题' });
    const aborted = reduce([{ type: 'start' }, { type: 'tool-input-available', toolCallId: 'c', toolName: 'fetch_page', input: {} }, { type: 'abort' }]);
    expect(aborted.status).toBe('aborted');
    expect(aborted.items[0]).toMatchObject({ status: 'error', output: '已停止' });
    expect(progressLabel({ stage: 'plan', subquestions: [1, 2, 3] })).toBe('计划：3 个子问题');
  });

  test('createSSEDecoder：一个事件被拆在两次里；忽略 [DONE] 和注释', () => {
    const d = createSSEDecoder();
    expect(d.push('data: {"type":"st')).toEqual([]);
    expect(d.push('art"}\n\n: ping\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n')).toEqual([{ type: 'start' }, { type: 'finish' }]);
  });

  test('timeline.ts 去掉类型以后能发给浏览器', async () => {
    const js = await browserTimeline();
    expect(js).toContain('export function applyChunk');
    expect(js).not.toMatch(/: Timeline\b/);
    expect(js).not.toMatch(/^import /m);
  });
});

describeMock('第 44 天：推送研究的过程（TODO 2）', () => {
  test('streamResearch：过程、来源、回答，AI SDK 的解析器也认得', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 默认端口' } }] }).reply({ content: '默认端口是 7443 [1]。' });
    const chunks: Chunk[] = [];
    await streamResearch('3.0 的默认端口是多少？', setup, { model: createModel('openai') }, (c) => chunks.push(c));
    expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-input-available', 'tool-output-available', 'text-start', ...Array(chunks.length - 8).fill('text-delta'), 'text-end', 'source-url', 'data-answer', 'finish']);
    expect(chunks.find((c) => c.type === 'source-url')).toEqual({ type: 'source-url', sourceId: '1', url: `${fixture.base}/article.html`, title: '潮汐协议 3.0 发布说明' });
    const answer = chunks.find((c) => c.type === 'data-answer') as { data: { text: string; status: string } };
    expect(answer.data.status).toBe('completed');
    expect(answer.data.text).toContain('[1] 潮汐协议 3.0 发布说明');
    expect(answer.data.text.endsWith(EXPLICIT_LABEL)).toBe(true);

    // 协议兼容：用 AI SDK 自己的 schema 校验每一块，再交给 readUIMessageStream 拼成一条 UIMessage
    const body = new Blob([...chunks.map(toSSE), toSSE('[DONE]')]).stream();
    const parsed = parseJsonEventStream({ stream: body, schema: uiMessageChunkSchema }).pipeThrough(
      new TransformStream({
        transform(result, controller) {
          if (!result.success) throw result.error;
          controller.enqueue(result.value);
        },
      }),
    );
    let message: UIMessage | undefined;
    for await (const m of readUIMessageStream({ stream: parsed })) message = m;
    const types = message!.parts.map((p) => p.type);
    expect(types).toContain('dynamic-tool');
    expect(types).toContain('text');
    expect(types).toContain('source-url');
    expect(types).toContain('data-answer');
  });

  test('出错：error 块是兜底的答复，内部错误交给 onError', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.fail({ status: 400, message: '内部地址 10.0.0.5' });
    const chunks: Chunk[] = [];
    const errors: unknown[] = [];
    await streamResearch('问题', setup, { model: createModel('openai') }, (c) => chunks.push(c), (e) => errors.push(e));
    expect(chunks.map((c) => c.type)).toEqual(['start', 'error', 'finish']);
    expect(JSON.stringify(chunks)).not.toContain('10.0.0.5');
    expect(String(errors[0])).toContain('10.0.0.5');
  });
});

describeMock('第 44 天：网页和 SSE 接口（TODO 4）', () => {
  test('POST /api/research：SSE 响应头和内容；网页和脚本都能取到', async () => {
    const ends: string[] = [];
    const app = await startWebApp({ model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture), onRunEnd: (i) => ends.push(i.status) });
    try {
      llm.reply({ content: '你好。' });
      const res = await fetch(`${app.url}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '你好' }) });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
      const text = await res.text();
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
      const state = reduce(createSSEDecoder().push(text));
      expect(state.status).toBe('done');
      expect(state.answer?.text).toContain('你好。');
      expect(ends).toEqual(['completed']);
      expect((await fetch(`${app.url}/`)).headers.get('content-type')).toContain('text/html');
      expect(await (await fetch(`${app.url}/timeline.js`)).text()).toContain('export function applyChunk');
      expect((await fetch(`${app.url}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":""}' })).status).toBe(400);
      expect((await fetch(`${app.url}/api/research`)).status).toBe(405);
    } finally {
      await app.close();
    }
  });

  test('用户停止（断开连接）：研究跟着取消，不再调用模型', async () => {
    let ended!: (status: string) => void;
    const done = new Promise<string>((r) => (ended = r));
    const app = await startWebApp({ model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture), onRunEnd: (i) => ended(i.status) });
    try {
      llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '1+1' } }] }).reply({ content: '很长很长的回答'.repeat(50), chunkDelayMs: 30 }).reply({ content: '不应该用到' });
      const controller = new AbortController();
      const res = await fetch(`${app.url}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '算一下' }), signal: controller.signal });
      const reader = res.body!.getReader();
      let seen = '';
      while (!seen.includes('text-delta')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('流已经结束了，还没收到 text-delta');
        seen += new TextDecoder().decode(value);
      }
      controller.abort();
      expect(await done).toBe('aborted');
      expect(llm.requests, '停止以后不再调用模型').toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  test('长时间没有新的块：发心跳', async () => {
    const app = await startWebApp({ model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture), heartbeatMs: 50 });
    try {
      llm.reply({ content: '慢', delayMs: 200 });
      const text = await (await fetch(`${app.url}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '慢问题' }) })).text();
      expect(text).toContain(': ping');
      expect(reduce(createSSEDecoder().push(text)).status).toBe('done');
    } finally {
      await app.close();
    }
  });
});

const hasChromium = existsSync(chromium.executablePath());
describe.runIf(mode === 'mock' && hasChromium)('第 44 天：真的浏览器', () => {
  test('提问、看到调研步骤和回答；回答里的 HTML 不会被执行', { timeout: 30_000 }, async () => {
    const app = await startWebApp({ model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture) });
    const browser = await chromium.launch();
    try {
      llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 默认端口' } }] }).reply({ content: '默认端口是 7443 [1]。<img src=x onerror="window.hacked=1">' });
      const page = await browser.newPage();
      await page.goto(app.url);
      await page.fill('#question', '3.0 的默认端口是多少？');
      await page.click('#ask');
      await page.waitForFunction("document.getElementById('status')?.textContent === '完成'", undefined, { timeout: 10_000 });
      expect(await page.textContent('#timeline')).toContain('web_search');
      expect(await page.textContent('#answer')).toContain('7443');
      expect(await page.locator('#sources a').count()).toBe(1);
      expect(await page.evaluate('window.hacked'), '回答当作文字显示').toBeUndefined();
    } finally {
      await browser.close();
      await app.close();
    }
  });
});

describeE2E('第 44 天：真实模型推送研究的过程', () => {
  test('能看到工具调用和最终的回答', { timeout: 300_000 }, async () => {
    const chunks: Chunk[] = [];
    await streamResearch('潮汐协议 3.0 的默认端口是多少？', await makeSetup(import.meta.url, fixture), { model: createModel('openai') }, (c) => chunks.push(c));
    const state = reduce(chunks);
    console.log(state.items.map((i) => i.kind === 'tool' ? `${i.name} ${i.status}` : i.kind), state.answer?.text);
    expect(state.status).toBe('done');
    expect(state.items.some((i) => i.kind === 'tool')).toBe(true);
    expect(state.answer?.text).toContain('7443');
  });
});
