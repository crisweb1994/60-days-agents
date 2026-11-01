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

  test('可以指定 finish_reason 和 usage', async () => {
    llm.reply({ content: '写到一半', finishReason: 'length', usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const data: any = await (await post()).json();
    expect(data.choices[0].finish_reason).toBe('length');
    expect(data.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
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

describe('错误和请求检查', () => {
  test('按脚本返回 429，带上 Retry-After', async () => {
    llm.fail({ status: 429, headers: { 'Retry-After': '2' } });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
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
});
