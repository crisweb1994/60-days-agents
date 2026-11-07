import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const m = await loadTarget<typeof import('../solution/ai-model.ts')>(import.meta.url, 'ai-model.ts');
const { toModelMessages, toToolSet, toAIToolChoice, toFinishReason, toChatResult, toModelErrorFromAISDK } = m;
const ag = await loadTarget<typeof import('../solution/ai-agent.ts')>(import.meta.url, 'ai-agent.ts');
const { planWithAISDK, aiResearch, approvalFromPolicy } = ag;
const { createModel, PROVIDERS } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { createAISDKModel } = await loadTarget<typeof import('../solution/frameworks/ai-sdk.ts')>(import.meta.url, 'frameworks/ai-sdk.ts');
const { ModelError } = await loadTarget<typeof import('../solution/errors.ts')>(import.meta.url, 'errors.ts');
const { withRetry } = await loadTarget<typeof import('../solution/retry.ts')>(import.meta.url, 'retry.ts');
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');
const { toToolDefinition } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { DEFAULT_POLICY } = await loadTarget<typeof import('../solution/permissions.ts')>(import.meta.url, 'permissions.ts');

type Message = import('../solution/types.ts').Message;
const HISTORY: Message[] = [
  { role: 'system', content: '系统' },
  { role: 'user', content: '算一下' },
  { role: 'assistant', content: null, reasoning_content: '先算', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '2' },
];

describe('第 42 天：转换（TODO 1、2）', () => {
  test('toModelMessages：思考、文字、工具调用拆成部分；工具结果按 id 找回工具名', () => {
    expect(toModelMessages(HISTORY)).toEqual([
      { role: 'system', content: '系统' },
      { role: 'user', content: '算一下' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先算' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'calculator', input: { expression: '1+1' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'calculator', output: { type: 'text', value: '2' } }] },
    ]);
    expect(toModelMessages([{ role: 'assistant', content: '好的' }])).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '好的' }] }]);
  });

  test('toToolSet、toAIToolChoice、toFinishReason', async () => {
    const defs = createTools('/tmp').map(toToolDefinition);
    const set = toToolSet(defs);
    expect(Object.keys(set)).toEqual(defs.map((d) => d.function.name));
    expect(set.calculator.execute, '不给 execute：工具由我们自己的循环执行').toBeUndefined();
    expect(toAIToolChoice('required')).toBe('required');
    expect(toAIToolChoice({ type: 'function', function: { name: 'calculator' } })).toEqual({ type: 'tool', toolName: 'calculator' });
    expect(toAIToolChoice(undefined)).toBeUndefined();
    expect(['stop', 'tool-calls', 'length', 'content-filter'].map((r) => toFinishReason(r))).toEqual(['stop', 'tool_calls', 'length', 'content_filter']);
    expect(toFinishReason('other', 'sensitive'), '不认识的用原始的值，第 6 天的护栏认得 sensitive').toBe('sensitive');
  });

  test('toChatResult：工具调用的参数序列化回字符串', () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: undefined }, outputTokenDetails: { textTokens: 2, reasoningTokens: 0 } };
    expect(toChatResult({ text: '', reasoningText: '想', toolCalls: [{ toolCallId: 'x', toolName: 'calculator', input: { expression: '2' } }], finishReason: 'tool-calls', rawFinishReason: 'tool_calls', totalUsage: usage })).toEqual({
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2"}' } }], reasoning_content: '想' },
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, reasoningTokens: 0 },
    });
    expect(toChatResult({ text: '答', reasoningText: undefined, toolCalls: [], finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage }).message).toEqual({ role: 'assistant', content: '答' });
  });

  test('toModelErrorFromAISDK：接口错误换成 ModelError，状态码、错误码、响应头都在', () => {
    const e = new APICallError({ message: 'x', url: 'u', requestBodyValues: {}, statusCode: 429, responseHeaders: { 'retry-after': '3' }, responseBody: '{"error":{"message":"慢点","code":"rate_limit"}}' });
    const converted = toModelErrorFromAISDK(e);
    expect(converted).toBeInstanceOf(ModelError);
    expect(converted).toMatchObject({ status: 429, code: 'rate_limit', message: '模型调用失败（429）：慢点' });
    expect((converted as InstanceType<typeof ModelError>).headers.get('retry-after')).toBe('3');
    const other = new Error('别的');
    expect(toModelErrorFromAISDK(other)).toBe(other);
  });
});

describeMock('第 42 天：AI SDK 实现的 Model（TODO 3、4）', () => {
  test('同一个请求：两种实现发出去的消息一样', async () => {
    const tools = createTools('/tmp').map(toToolDefinition);
    llm.reply({ content: 'A' }).reply({ content: 'B' });
    await createModel('openai').chat({ messages: HISTORY, tools, temperature: 0 });
    const r = await createModel('ai-sdk').chat({ messages: HISTORY, tools, temperature: 0 });
    expect(PROVIDERS).toContain('ai-sdk');
    expect(llm.requests[1].messages).toEqual(llm.requests[0].messages);
    expect(llm.requests[1].tools!.map((t) => t.function.name)).toEqual(tools.map((t) => t.function.name));
    expect(llm.requests[1].temperature).toBe(0);
    expect(r.message).toEqual({ role: 'assistant', content: 'B' });
    expect(r.finishReason).toBe('stop');
  });

  test('流式：边收边回调文字和思考', async () => {
    const texts: string[] = [];
    const thoughts: string[] = [];
    llm.reply({ content: '流式的回答', reasoning: '先想想' });
    const r = await createModel('ai-sdk').chat({ messages: [{ role: 'user', content: 'hi' }] }, { onText: (t) => texts.push(t), onReasoning: (t) => thoughts.push(t) });
    expect(llm.requests[0].stream).toBe(true);
    expect(texts.join('')).toBe('流式的回答');
    expect(thoughts.join('')).toBe('先想想');
    expect(r.message).toMatchObject({ content: '流式的回答', reasoning_content: '先想想' });
  });

  test('出错换成 ModelError，交给第 9 天的重试；AI SDK 自己不重试', async () => {
    llm.fail({ status: 429, message: '慢点', headers: { 'retry-after': '1' } }).reply({ content: '好了' });
    const waits: number[] = [];
    const model = withRetry(createModel('ai-sdk'), { sleep: async (ms) => void waits.push(ms) });
    expect((await model.chat({ messages: [{ role: 'user', content: 'hi' }] })).message.content).toBe('好了');
    expect(waits, 'Retry-After 被读到了').toEqual([1000]);
    expect(llm.requests).toHaveLength(2);
    llm.fail({ status: 503, message: '过载' });
    await expect(createModel('ai-sdk').chat({ messages: [{ role: 'user', content: 'hi' }] }, { onText: () => {} })).rejects.toMatchObject({ name: 'ModelError', status: 503 });
  });

  test('手写的循环跑在 AI SDK 上：叫错名字的工具照样得到第 11 天的提示', async () => {
    llm.reply({ toolCalls: [{ name: 'calculater', arguments: { expression: '1+1' } }] }).reply({ content: '2' });
    const r = await runAgent('1+1', { model: createModel('ai-sdk'), tools: createTools('/tmp') });
    expect(r.status).toBe('completed');
    expect(String(llm.requests[1].messages.at(-1)!.content)).toContain('你是不是想用 calculator？');
  });

  test('研究助手换上 AI SDK：带引用作答；恶意网页的外传照样被拦下', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 默认端口' } }] }).reply({ content: '默认端口是 7443 [1]。' });
    const ok = await research('3.0 的默认端口是多少？', setup, { model: createModel('ai-sdk') });
    expect(ok.report.ok).toBe(true);
    expect(ok.text).toContain('[1] 潮汐协议 3.0 发布说明');

    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 上手评测' } }] })
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/review.html` } }] })
      .reply({ toolCalls: [{ name: 'http_request', arguments: { url: `${fixture.base}/collect?data=x`, method: 'GET', body: null } }] })
      .reply({ content: '默认端口是 7443 [1]。' });
    const attacked = await research('网上有一篇潮汐协议 3.0 的上手评测，帮我看看默认端口是多少？', await makeSetup(import.meta.url, fixture), { model: createModel('ai-sdk') });
    expect(fixture.received).toEqual([]);
    expect(attacked.security?.guard.events.map((e) => e.outcome)).toEqual(['blocked']);
  });
});

describeMock('第 42 天：结构化输出（TODO 5）', () => {
  test('planWithAISDK：解析成计划；兼容接口默认用 json_object；不合格就退回', async () => {
    llm.reply({ content: '{"steps": ["3.0 的性能", "迁移成本", "a", "b", "c", "d"]}' });
    const { plan, usage } = await planWithAISDK('3.0 值得升级吗？', createAISDKModel());
    expect(plan).toEqual({ question: '3.0 值得升级吗？', subquestions: ['3.0 的性能', '迁移成本', 'a', 'b', 'c'], fallback: false });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(llm.requests[0].response_format, '没开 supportsStructuredOutputs 时，openai-compatible 只发 json_object，校验由 AI SDK 做').toEqual({ type: 'json_object' });
    llm.reply({ content: '{"steps": []}' });
    expect((await planWithAISDK('问题', createAISDKModel())).plan).toEqual({ question: '问题', subquestions: ['问题'], fallback: true });
  });
});

describeMock('第 42 天：ToolLoopAgent 跑研究助手（TODO 6）', () => {
  test('权限策略换成 toolApproval', () => {
    const tools = createTools('/tmp');
    const approve = approvalFromPolicy(tools, { ...DEFAULT_POLICY, tools: { http_request: 'deny' } });
    expect(approve({ toolCall: { toolName: 'calculator', input: {} } })).toBe('not-applicable');
    expect(approve({ toolCall: { toolName: 'write_file', input: { path: 'a', content: 'b' } } })).toBe('user-approval');
    expect(approve({ toolCall: { toolName: 'http_request', input: {} } })).toMatchObject({ type: 'denied' });
    expect(approve({ toolCall: { toolName: 'nope', input: {} } })).toBe('not-applicable');
  });

  test('查资料、带引用作答', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 默认端口' } }] }).reply({ content: '默认端口是 7443 [1]。' });
    const r = await aiResearch('3.0 的默认端口是多少？', setup, { model: createAISDKModel(), now: () => new Date(2026, 10, 7) });
    expect(r).toMatchObject({ status: 'completed', answer: '默认端口是 7443 [1]。', steps: 2, toolCalls: [{ name: 'web_search' }] });
    expect(r.text).toContain('[1] 潮汐协议 3.0 发布说明');
    expect(llm.requests[0].messages[0]).toMatchObject({ role: 'system' });
    expect(String(llm.requests[0].messages[1].content), '问题前面带上日期').toContain('2026');
  });

  test('要审批的工具问用户；不同意就不执行', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const asked: string[] = [];
    llm.reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'note.md', content: '笔记' } }] }).reply({ content: '好的，没写。' });
    const r = await aiResearch('把结论写进 note.md', setup, { model: createAISDKModel(), confirm: async ({ tool }) => (asked.push(tool), false) });
    expect(asked).toEqual(['write_file']);
    expect(r.answer).toBe('好的，没写。');
    await expect(readFile(join(setup.workspace, 'note.md'), 'utf8')).rejects.toThrow();
  });

  test('步数用完了是 max_steps', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    for (let i = 0; i < 4; i++) llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: `${i}+1` } }] });
    const r = await aiResearch('一直算', setup, { model: createAISDKModel(), maxSteps: 3 });
    expect(r.status).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);
  });
});

describeE2E('第 42 天：真实模型', () => {
  test('研究助手换上 AI SDK 的模型', { timeout: 300_000 }, async () => {
    const r = await research('潮汐协议 3.0 的默认端口是多少？', await makeSetup(import.meta.url, fixture), { model: createModel('ai-sdk') });
    console.log(r.text);
    expect(r.answer).toContain('7443');
  });

  test('ToolLoopAgent 跑研究助手；结构化输出的计划', { timeout: 300_000 }, async () => {
    const r = await aiResearch('潮汐协议 3.0 的默认端口是多少？', await makeSetup(import.meta.url, fixture), { model: createAISDKModel() });
    console.log(r.text);
    expect(r.answer).toContain('7443');
    const { plan } = await planWithAISDK('潮汐协议 3.0 值得从 2.x 升级吗？', createAISDKModel());
    console.log(plan);
    expect(plan.subquestions.length).toBeGreaterThan(1);
  });
});
