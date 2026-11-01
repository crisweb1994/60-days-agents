import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { startMockLLM } from './index.ts';

const llm = await startMockLLM();
beforeEach(() => llm.reset());
afterAll(() => llm.close());

function post(body: object = {}, init: RequestInit = {}) {
  return fetch(`${llm.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: '你好' }], ...body }),
    ...init,
  });
}

async function errorMessage(res: Response): Promise<string> {
  const data = (await res.json()) as { error: { message: string } };
  return data.error.message;
}

describe('非流式', () => {
  test('按脚本返回文字回答，并记录请求', async () => {
    llm.reply({ content: '你好！' });
    const res = await post();
    const data: any = await res.json();
    expect(res.status).toBe(200);
    expect(data.choices[0]).toMatchObject({ message: { role: 'assistant', content: '你好！' }, finish_reason: 'stop' });
    expect(data.usage.total_tokens).toBeGreaterThan(0);
    expect(llm.requests[0].messages[0].content).toBe('你好');
    expect(llm.pending).toBe(0);
  });

  test('返回工具调用：content 是 null，arguments 是 JSON 字符串', async () => {
    llm.reply({ toolCalls: [{ name: 'lookup_term', arguments: { term: 'MCP' } }] });
    const data: any = await (await post()).json();
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_term', arguments: '{"term":"MCP"}' } }],
    });
  });

  test('可以指定 finish_reason 和 usage，usage 里的额外字段原样返回', async () => {
    llm.reply({
      content: '写到一半',
      finishReason: 'length',
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } },
    });
    const data: any = await (await post()).json();
    expect(data.choices[0].finish_reason).toBe('length');
    expect(data.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 8 },
    });
  });

  test('思考内容放在 reasoning_content 里，并计入 reasoning_tokens', async () => {
    llm.reply({ reasoning: '用户在打招呼。', content: '你好！' });
    const data: any = await (await post()).json();
    expect(data.choices[0].message).toEqual({ role: 'assistant', content: '你好！', reasoning_content: '用户在打招呼。' });
    expect(data.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
  });
});

test('流式：把所有分块拼起来，得到完整的文字和工具参数', async () => {
  llm.reply({
    content: '我来查一下术语表。',
    toolCalls: [{ id: 'call_x', name: 'lookup_term', arguments: { term: '上下文窗口' } }],
  });
  const res = await post({ stream: true, stream_options: { include_usage: true } });
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  const events = (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map((event) => event.replace(/^data: /, ''));
  expect(events.at(-1)).toBe('[DONE]');
  const chunks: any[] = events.slice(0, -1).map((event) => JSON.parse(event));
  const deltas = chunks.flatMap((chunk) => chunk.choices.map((choice: any) => choice.delta));
  const content = deltas.map((delta) => delta.content ?? '').join('');
  const args = deltas
    .flatMap((delta) => delta.tool_calls ?? [])
    .map((call: any) => call.function.arguments)
    .join('');

  expect(content).toBe('我来查一下术语表。');
  expect(JSON.parse(args)).toEqual({ term: '上下文窗口' });
  expect(chunks.length, '应该切成很多块').toBeGreaterThan(5);
  expect(chunks.flatMap((chunk) => chunk.choices).at(-1).finish_reason).toBe('tool_calls');
  expect(chunks.at(-1).usage.total_tokens).toBeGreaterThan(0);
});

test('流式：思考内容在文字之前，用 delta.reasoning_content 分块返回', async () => {
  llm.reply({ reasoning: '先想一想再回答', content: '想好了' });
  const res = await post({ stream: true });
  const deltas = (await res.text())
    .split('\n\n')
    .filter((event) => event.startsWith('data: {'))
    .flatMap((event) => JSON.parse(event.slice(6)).choices.map((choice: any) => choice.delta));
  const reasoning = deltas.map((delta) => delta.reasoning_content ?? '').join('');
  expect(reasoning).toBe('先想一想再回答');
  const firstContent = deltas.findIndex((delta) => delta.content);
  const lastReasoning = deltas.findLastIndex((delta) => delta.reasoning_content);
  expect(lastReasoning).toBeLessThan(firstContent);
});

test('流式：客户端中途取消后，服务器停止发送', async () => {
  llm.reply({ content: '这是一段很长很长很长很长很长很长的回答', chunkDelayMs: 30 });
  const controller = new AbortController();
  const res = await post({ stream: true }, { signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read(); // 收到第一块
  controller.abort();
  await expect(reader.read()).rejects.toThrow();
});

test('流式：disconnectAfter 模拟传到一半连接断了', async () => {
  llm.reply({ content: '这段话传不完整', disconnectAfter: 2 });
  const res = await post({ stream: true });
  expect(res.status).toBe(200);
  await expect(res.text()).rejects.toThrow();
});

describe('错误和请求检查', () => {
  test('按脚本返回 429，带上 Retry-After', async () => {
    llm.fail({ status: 429, headers: { 'Retry-After': '2' } });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  test('错误体可以指定 type 和 code', async () => {
    llm.fail({ status: 429, message: '额度用完了', type: 'insufficient_quota', code: 'insufficient_quota' });
    const res = await post();
    expect(await res.json()).toEqual({
      error: { message: '额度用完了', type: 'insufficient_quota', code: 'insufficient_quota' },
    });
  });

  test('可以返回原始的错误页，比如网关的 HTML', async () => {
    llm.fail({ status: 502, body: '<html><body>502 Bad Gateway</body></html>' });
    const res = await post();
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Bad Gateway');
  });

  test('disconnect 不返回任何响应，直接断开连接', async () => {
    llm.fail({ disconnect: true });
    await expect(post()).rejects.toThrow();
  });

  test('延迟回复时，客户端可以用 AbortSignal 超时', async () => {
    llm.reply({ content: '太慢了', delayMs: 1_000 });
    await expect(post({}, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  });

  test('脚本用完时返回 500，提示可能陷入了循环', async () => {
    const res = await post();
    expect(res.status).toBe(500);
    expect(await errorMessage(res)).toContain('mock 脚本已用完');
  });

  test('缺少 Authorization 时返回 401', async () => {
    const res = await post({}, { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(401);
  });

  test('tool 消息对不上工具调用时返回 400', async () => {
    const res = await post({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'tool', tool_call_id: 'call_404', content: '…' },
      ],
    });
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toContain('call_404');
  });

  test('工具调用没交回结果就继续对话时返回 400', async () => {
    const res = await post({
      messages: [
        { role: 'user', content: '什么是 MCP？' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_term', arguments: '{}' } }],
        },
        { role: 'user', content: '怎么不说话了？' },
      ],
    });
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toContain('call_1');
  });

  test('tools 格式不对时返回 400', async () => {
    const res = await post({ tools: [{ function: { name: 'lookup_term' } }] });
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toContain('tools[0].type');
  });

  test('tools 是空数组时返回 400', async () => {
    const res = await post({ tools: [] });
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toContain('空数组');
  });

  test('tool_choice 指定的工具不存在，或者没有 tools 时返回 400', async () => {
    const tools = [{ type: 'function', function: { name: 'lookup_term' } }];
    const missing = await post({ tools, tool_choice: { type: 'function', function: { name: 'search' } } });
    expect(missing.status).toBe(400);
    expect(await errorMessage(missing)).toContain('search');
    const alone = await post({ tool_choice: 'required' });
    expect(alone.status).toBe(400);
    llm.reply({ content: '好的' });
    expect((await post({ tools, tool_choice: 'required' })).status).toBe(200);
  });

  test('json_object 模式要求提示词里出现 json', async () => {
    const res = await post({ response_format: { type: 'json_object' } });
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toContain('json');
    llm.reply({ content: '{"ok":true}' });
    const ok = await post({
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: '用 JSON 回答：你好吗？' }],
    });
    expect(ok.status).toBe(200);
  });

  test('json_schema 模式要写明 name 和 schema', async () => {
    const res = await post({ response_format: { type: 'json_schema', json_schema: { schema: {} } } });
    expect(res.status).toBe(400);
  });

  test('stream_options 只能和 stream: true 一起用', async () => {
    const res = await post({ stream_options: { include_usage: true } });
    expect(res.status).toBe(400);
  });
});

describe('Anthropic 协议', () => {
  function postMessages(body: object = {}, headers: Record<string, string> = {}) {
    return fetch(`${llm.anthropicBaseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test', 'anthropic-version': '2023-06-01', ...headers },
      body: JSON.stringify({ model: 'mock-model', max_tokens: 1024, messages: [{ role: 'user', content: '你好' }], ...body }),
    });
  }

  async function anthropicError(res: Response): Promise<{ type: string; message: string }> {
    const data = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(data.type).toBe('error');
    return data.error;
  }

  /** 读出流式响应的所有事件 */
  async function readEvents(res: Response): Promise<{ event: string; data: any }[]> {
    return (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((raw) => {
        const [eventLine, dataLine] = raw.split('\n');
        return { event: eventLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) };
      });
  }

  test('非流式：内容是一组块，stop_reason 和 usage 用 Anthropic 的写法', async () => {
    llm.reply({ content: '你好！', usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } });
    const data: any = await (await postMessages()).json();
    expect(data).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '你好！' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 5 },
    });
    expect(llm.anthropicRequests).toHaveLength(1);
  });

  test('非流式：工具调用是 tool_use 块，finishReason 的叫法自动换成 Anthropic 的', async () => {
    llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '1+1' } }] }).reply({ content: '写到一半', finishReason: 'length' });
    const first: any = await (await postMessages({ tools: [{ name: 'calculator', input_schema: { type: 'object' } }] })).json();
    expect(first.stop_reason).toBe('tool_use');
    expect(first.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { expression: '1+1' } }]);
    expect(((await (await postMessages()).json()) as any).stop_reason).toBe('max_tokens');
  });

  test('流式：按事件发送，拼起来得到思考、文字和工具参数', async () => {
    llm.reply({ reasoning: '先算一下', content: '我来算', toolCalls: [{ id: 'toolu_x', name: 'calculator', arguments: { expression: '2*3' } }] });
    const events = await readEvents(await postMessages({ stream: true, tools: [{ name: 'calculator', input_schema: { type: 'object' } }] }));
    expect(events[0].event).toBe('message_start');
    expect(events.at(-1)?.event).toBe('message_stop');
    const deltas = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data);
    const join = (type: string, field: string) => deltas.filter((d) => d.delta.type === type).map((d) => d.delta[field]).join('');
    expect(join('thinking_delta', 'thinking')).toBe('先算一下');
    expect(join('signature_delta', 'signature')).toMatch(/^mock-signature-/);
    expect(join('text_delta', 'text')).toBe('我来算');
    expect(JSON.parse(join('input_json_delta', 'partial_json'))).toEqual({ expression: '2*3' });
    const messageDelta = events.find((e) => e.event === 'message_delta')?.data;
    expect(messageDelta.delta.stop_reason).toBe('tool_use');
  });

  test('请求头：缺少 anthropic-version 返回 400，缺少 API Key 返回 401，Bearer 也可以', async () => {
    expect((await postMessages({}, { 'anthropic-version': '' })).status).toBe(400);
    const unauthorized = await postMessages({}, { 'x-api-key': '' });
    expect(unauthorized.status).toBe(401);
    expect((await anthropicError(unauthorized)).type).toBe('authentication_error');
    llm.reply({ content: '好' });
    expect((await postMessages({}, { 'x-api-key': '', Authorization: 'Bearer test' })).status).toBe(200);
  });

  test('请求体：max_tokens 必填；system 不能放进 messages；工具定义不能用 OpenAI 的写法', async () => {
    expect((await postMessages({ max_tokens: undefined })).status).toBe(400);
    const system = await postMessages({ messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }] });
    expect((await anthropicError(system)).message).toContain('顶层的 system');
    const tools = await postMessages({ tools: [{ type: 'function', function: { name: 'x' } }] });
    expect((await anthropicError(tools)).message).toContain('input_schema');
  });

  test('工具结果要作为 tool_result 块放进下一条 user 消息，而且排在最前面', async () => {
    const assistant = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'calculator', input: {} }] };
    const missing = await postMessages({ messages: [{ role: 'user', content: '算一下' }, assistant, { role: 'user', content: '然后呢？' }] });
    expect((await anthropicError(missing)).message).toContain('toolu_1');
    const wrongOrder = await postMessages({
      messages: [
        { role: 'user', content: '算一下' },
        assistant,
        { role: 'user', content: [{ type: 'text', text: '结果：' }, { type: 'tool_result', tool_use_id: 'toolu_1', content: '2' }] },
      ],
    });
    expect((await anthropicError(wrongOrder)).message).toContain('最前面');
  });

  test('带思考的工具调用回复：下一次请求要把 thinking 块原样传回来', async () => {
    llm.reply({ reasoning: '需要计算', toolCalls: [{ id: 'toolu_t', name: 'calculator', arguments: { expression: '1+1' } }] });
    const first: any = await (await postMessages({ tools: [{ name: 'calculator', input_schema: { type: 'object' } }] })).json();
    const [thinking, toolUse] = first.content;
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t', content: '2' }] };
    const tools = [{ name: 'calculator', input_schema: { type: 'object' } }];

    const dropped = await postMessages({ tools, messages: [{ role: 'user', content: '算 1+1' }, { role: 'assistant', content: [toolUse] }, result] });
    expect(dropped.status).toBe(400);
    expect((await anthropicError(dropped)).message).toContain('thinking');

    llm.reply({ content: '等于 2' });
    const kept = await postMessages({ tools, messages: [{ role: 'user', content: '算 1+1' }, { role: 'assistant', content: [thinking, toolUse] }, result] });
    expect(kept.status).toBe(200);
  });

  test('失败时用 Anthropic 的错误格式，比如 529 overloaded_error', async () => {
    llm.fail({ status: 529, message: 'Overloaded' });
    const res = await postMessages();
    expect(res.status).toBe(529);
    expect(await anthropicError(res)).toEqual({ type: 'overloaded_error', message: 'Overloaded' });
  });
});
