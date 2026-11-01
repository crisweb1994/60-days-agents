import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { Message, ToolDefinition } from '../solution/types.ts';

const { toAnthropicRequest } = await loadTarget<typeof import('../solution/anthropic.ts')>(import.meta.url, 'anthropic.ts');

const config = { baseURL: 'http://example.test', apiKey: 'k', model: 'mock-model' };
const calcTool: ToolDefinition = {
  type: 'function',
  function: { name: 'calculator', description: '计算算式', parameters: { type: 'object', properties: { expression: { type: 'string' } } } },
};

/** 一段典型的历史：system、问题、两个并行的工具调用和结果、最终回答、用户的追问 */
const history: Message[] = [
  { role: 'system', content: '你是一个能使用工具的助手。' },
  { role: 'user', content: '算一下 1+1 和 2+2' },
  {
    role: 'assistant',
    content: '我来算一下。',
    tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } },
      { id: 'call_b', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_a', content: '2' },
  { role: 'tool', tool_call_id: 'call_b', content: '4' },
  { role: 'assistant', content: '1+1=2，2+2=4。' },
  { role: 'user', content: '谢谢！' },
];

describe('第 8 天：转换成 Anthropic 的请求（TODO 1）', () => {
  test('system 消息放到顶层的 system 字段，不留在 messages 里', () => {
    const body = toAnthropicRequest({ messages: history }, config);
    expect(body.system).toBe('你是一个能使用工具的助手。');
    expect(body.messages.every((m) => m.role === 'user' || m.role === 'assistant'), 'messages 里只能有 user 和 assistant').toBe(true);
    expect(body.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '算一下 1+1 和 2+2' }] });
  });

  test('assistant 消息变成内容块：文字是 text 块，工具调用是 tool_use 块，参数从 JSON 字符串变成对象', () => {
    const body = toAnthropicRequest({ messages: history }, config);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '我来算一下。' },
        { type: 'tool_use', id: 'call_a', name: 'calculator', input: { expression: '1+1' } },
        { type: 'tool_use', id: 'call_b', name: 'calculator', input: { expression: '2+2' } },
      ],
    });
  });

  test('一轮的工具结果合并进同一条 user 消息，每个都是 tool_result 块', () => {
    const body = toAnthropicRequest({ messages: history }, config);
    expect(body.messages[2], '相邻的同角色消息要合并：两条 tool 消息变成一条 user 消息里的两个 tool_result 块').toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: '2' },
        { type: 'tool_result', tool_use_id: 'call_b', content: '4' },
      ],
    });
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  test('工具结果后面紧跟着用户的话：合并进同一条 user 消息，排在 tool_result 后面', () => {
    const body = toAnthropicRequest(
      { messages: [...history.slice(0, 5), { role: 'user', content: '换成乘法呢？' }] },
      config,
    );
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: '2' },
        { type: 'tool_result', tool_use_id: 'call_b', content: '4' },
        { type: 'text', text: '换成乘法呢？' },
      ],
    });
  });

  test('工具定义换成 { name, description, input_schema }', () => {
    const body = toAnthropicRequest({ messages: history, tools: [calcTool] }, config);
    expect(body.tools).toEqual([
      { name: 'calculator', description: '计算算式', input_schema: calcTool.function.parameters },
    ]);
    expect(toAnthropicRequest({ messages: history, tools: [] }, config).tools, '没有工具时不带 tools').toBeUndefined();
  });

  test('tool_choice 换成 Anthropic 的写法：required 对应 any', () => {
    const choice = (toolChoice: Parameters<typeof toAnthropicRequest>[0]['toolChoice']) =>
      toAnthropicRequest({ messages: history, tools: [calcTool], toolChoice }, config).tool_choice;
    expect(choice('auto')).toEqual({ type: 'auto' });
    expect(choice('none')).toEqual({ type: 'none' });
    expect(choice('required')).toEqual({ type: 'any' });
    expect(choice({ type: 'function', function: { name: 'calculator' } })).toEqual({ type: 'tool', name: 'calculator' });
    expect(choice(undefined)).toBeUndefined();
  });

  test('max_tokens 必须有：请求里没写就用配置的默认值；stop 换成 stop_sequences', () => {
    expect(toAnthropicRequest({ messages: history }, config).max_tokens, '默认 8192').toBe(8192);
    expect(toAnthropicRequest({ messages: history }, { ...config, maxTokens: 1000 }).max_tokens).toBe(1000);
    const body = toAnthropicRequest({ messages: history, maxTokens: 50, stop: ['。'] }, config);
    expect(body.max_tokens).toBe(50);
    expect(body.stop_sequences).toEqual(['。']);
  });

  test('思考块排在 assistant 内容的最前面原样传回；只有 reasoning_content 的不传', () => {
    const messages: Message[] = [
      { role: 'user', content: '算 1+1' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '需要计算',
        thinking_blocks: [{ type: 'thinking', thinking: '需要计算', signature: 'sig-1' }],
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '2' },
      { role: 'assistant', content: '等于 2', reasoning_content: '来自 OpenAI 兼容接口的思考，没有签名' },
    ];
    const body = toAnthropicRequest({ messages }, config);
    expect(body.messages[1].content[0]).toEqual({ type: 'thinking', thinking: '需要计算', signature: 'sig-1' });
    expect(body.messages[3].content, '没有签名的思考内容 Anthropic 不认，不能传').toEqual([{ type: 'text', text: '等于 2' }]);
  });

  test('工具参数当初就不是合法的 JSON：input 换成空对象', () => {
    const messages: Message[] = [
      { role: 'user', content: '算一下' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'calculator', arguments: '{"expr' } }] },
      { role: 'tool', tool_call_id: 'call_x', content: '参数不是合法的 JSON' },
    ];
    const body = toAnthropicRequest({ messages }, config);
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'call_x', name: 'calculator', input: {} });
  });
});
