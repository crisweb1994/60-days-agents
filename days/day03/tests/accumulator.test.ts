import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { ChatCompletionChunk } from '../solution/openai.ts';

const { createAccumulator } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');

const delta = (value: NonNullable<NonNullable<ChatCompletionChunk['choices']>[number]['delta']>): ChatCompletionChunk => ({
  choices: [{ delta: value, finish_reason: null }],
});
const finish = (reason: string): ChatCompletionChunk => ({ choices: [{ delta: {}, finish_reason: reason }] });

describe('第 3 天：把增量拼成完整的回复（TODO 2）', () => {
  test('文字一段段拼起来；push 返回这一块新增的文字', () => {
    const acc = createAccumulator();
    expect(acc.push(delta({ role: 'assistant', content: '' })).text).toBe('');
    expect(acc.push(delta({ content: '杭州是' })).text).toBe('杭州是');
    expect(acc.push(delta({ content: '浙江省会。' })).text).toBe('浙江省会。');
    acc.push(finish('stop'));
    expect(acc.result()).toMatchObject({ message: { role: 'assistant', content: '杭州是浙江省会。' }, finishReason: 'stop' });
  });

  test('工具参数分散在好几块里，按 index 拼回每一个工具调用', () => {
    const acc = createAccumulator();
    acc.push(delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'lookup_term', arguments: '' } }] }));
    acc.push(delta({ tool_calls: [{ index: 0, function: { arguments: '{"term":' } }] }));
    acc.push(delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'lookup_term', arguments: '{"te' } }] }));
    acc.push(delta({ tool_calls: [{ index: 0, function: { arguments: '"Agent"}' } }] }));
    acc.push(delta({ tool_calls: [{ index: 1, function: { arguments: 'rm":"MCP"}' } }] }));
    acc.push(finish('tool_calls'));

    const { message, finishReason } = acc.result();
    expect(finishReason).toBe('tool_calls');
    expect(message.content, '只有工具调用、没有文字时，content 是 null').toBeNull();
    expect(message.tool_calls, '两个工具调用的参数交错到达，要靠 index 区分').toEqual([
      { id: 'call_a', type: 'function', function: { name: 'lookup_term', arguments: '{"term":"Agent"}' } },
      { id: 'call_b', type: 'function', function: { name: 'lookup_term', arguments: '{"term":"MCP"}' } },
    ]);
  });

  test('有的模型服务每一块都带上 id 和 name：不能重复拼接', () => {
    const acc = createAccumulator();
    for (const piece of ['{"term"', ':"MCP"}']) {
      acc.push(delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup_term', arguments: piece } }] }));
    }
    acc.push(finish('tool_calls'));
    expect(acc.result().message.tool_calls?.[0], 'id 和 name 有值就赋值，不要拼接；只有 arguments 要拼接').toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup_term', arguments: '{"term":"MCP"}' },
    });
  });

  test('思考内容拼进 reasoning_content；push 也返回这一块新增的思考', () => {
    const acc = createAccumulator();
    expect(acc.push(delta({ reasoning_content: '用户在' })).reasoning).toBe('用户在');
    acc.push(delta({ reasoning_content: '打招呼。' }));
    acc.push(delta({ content: '你好！' }));
    acc.push(finish('stop'));
    expect(acc.result().message).toEqual({ role: 'assistant', content: '你好！', reasoning_content: '用户在打招呼。' });
  });

  test('usage 在单独的最后一块里（choices 是空数组）', () => {
    const acc = createAccumulator();
    acc.push(delta({ content: '好' }));
    acc.push(finish('stop'));
    acc.push({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 1 } });
    expect(acc.result().usage).toMatchObject({ inputTokens: 20, outputTokens: 1 });
  });

  test('usage 挂在带 finish_reason 的最后一块上（DeepSeek、GLM 的写法）', () => {
    const acc = createAccumulator();
    acc.push({ ...delta({ content: '好' }), usage: null });
    acc.push({ ...finish('stop'), usage: { prompt_tokens: 30, completion_tokens: 2 } });
    expect(acc.result().usage).toMatchObject({ inputTokens: 30, outputTokens: 2 });
  });
});
