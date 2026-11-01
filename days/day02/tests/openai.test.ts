import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { chat } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');
const { ModelError } = await loadTarget<typeof import('../solution/errors.ts')>(import.meta.url, 'errors.ts');

const question = [{ role: 'user' as const, content: '你好' }];

describeMock('第 2 天：手写 chat()', () => {
  test('把模型名和 messages 发出去，返回回复、结束原因和用量', async () => {
    llm.reply({ content: '你好！', usage: { prompt_tokens: 12, completion_tokens: 3 } });
    const result = await chat({ messages: question });

    expect(llm.requests[0].model, '模型名要从环境变量 OPENAI_MODEL 读取').toBe('mock-model');
    expect(llm.requests[0].messages).toEqual(question);
    expect(result.message).toEqual({ role: 'assistant', content: '你好！' });
    expect(result.finishReason, 'finishReason 来自 choices[0].finish_reason').toBe('stop');
    expect(result.usage, 'usage 要用 parseUsage 转换（TODO 4）').toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });

  test('采样参数换成接口的字段名：topP → top_p，maxTokens → max_tokens', async () => {
    llm.reply({ content: '好的' });
    await chat({ messages: question, temperature: 0.2, topP: 0.9, maxTokens: 100, stop: ['。'] });
    expect(llm.requests[0]).toMatchObject({ temperature: 0.2, top_p: 0.9, max_tokens: 100, stop: ['。'] });
  });

  test('没传的参数不出现在请求里；没有工具时不带 tools 字段', async () => {
    llm.reply({ content: '好的' });
    await chat({ messages: question, tools: [] });
    const body = llm.requests[0];
    for (const key of ['temperature', 'top_p', 'max_tokens', 'stop', 'tools']) {
      expect(body, `没传的参数不要发：请求里不应该有 ${key}`).not.toHaveProperty(key);
    }
  });

  test('带上工具定义，并原样返回模型的工具调用', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'lookup_term', parameters: { type: 'object' } } }];
    llm.reply({ toolCalls: [{ id: 'call_1', name: 'lookup_term', arguments: { term: 'MCP' } }] });
    const result = await chat({ messages: question, tools });
    expect(llm.requests[0].tools).toEqual(tools);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.message.tool_calls?.[0].function).toEqual({ name: 'lookup_term', arguments: '{"term":"MCP"}' });
  });

  test('推理模型的 reasoning_content 留在 message 里', async () => {
    llm.reply({ reasoning: '用户在打招呼，简单回应即可。', content: '你好！' });
    const result = await chat({ messages: question });
    expect(result.message.reasoning_content, 'message 要原样返回，不要只挑 content').toBe('用户在打招呼，简单回应即可。');
    expect(result.usage.reasoningTokens, '思考用的 token 在 completion_tokens_details.reasoning_tokens 里（TODO 4）').toBeGreaterThan(0);
  });

  test('接口返回错误时，抛出带状态码和错误信息的 ModelError', async () => {
    llm.fail({ status: 401, message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' });
    const error = await chat({ messages: question }).catch((e: unknown) => e);
    expect(error, '状态码不是 2xx 时要 throw await toModelError(res)').toBeInstanceOf(ModelError);
    const modelError = error as InstanceType<typeof ModelError>;
    expect(modelError.status).toBe(401);
    expect(modelError.type, 'error.type 要读出来（TODO 3）').toBe('authentication_error');
    expect(modelError.message, '错误信息要包含状态码').toContain('401');
    expect(modelError.message, '错误信息要包含接口返回的 error.message（TODO 3）').toContain('api key is invalid');
  });

  test('错误码和响应头都留在 ModelError 里', async () => {
    llm.fail({
      status: 429,
      message: 'You exceeded your current quota',
      code: 'insufficient_quota',
      headers: { 'Retry-After': '20' },
    });
    const error = (await chat({ messages: question }).catch((e: unknown) => e)) as InstanceType<typeof ModelError>;
    expect(error.code, 'error.code 要读出来（TODO 3）').toBe('insufficient_quota');
    expect(error.headers.get('retry-after'), '响应头要传给 ModelError（TODO 3）').toBe('20');
  });

  test('错误体不是 JSON 时（比如网关的 HTML 错误页），也要带上原文', async () => {
    llm.fail({ status: 502, body: '<html><body><h1>502 Bad Gateway</h1></body></html>' });
    const error = (await chat({ messages: question }).catch((e: unknown) => e)) as InstanceType<typeof ModelError>;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.status).toBe(502);
    expect(error.message, '解析 JSON 失败时，用响应的原文作为错误信息（TODO 3）').toContain('Bad Gateway');
  });
});

describeE2E('第 2 天：真实模型', () => {
  test('返回回答和用量', async () => {
    const result = await chat({ messages: [{ role: 'user', content: '用一句话介绍你自己。' }] });
    expect(result.message.content, '应该有文字回答').toBeTruthy();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  test('maxTokens 太小时，回答被截断，finishReason 是 length', async () => {
    const result = await chat({ messages: [{ role: 'user', content: '详细介绍一下长城的历史。' }], maxTokens: 5 });
    expect(result.finishReason).toBe('length');
  });
});
