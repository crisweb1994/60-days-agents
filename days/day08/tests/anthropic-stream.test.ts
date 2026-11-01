import { describe, expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { createAnthropicModel, toFinishReason, toUsage } = await loadTarget<typeof import('../solution/anthropic.ts')>(
  import.meta.url,
  'anthropic.ts',
);
const { ModelError } = await loadTarget<typeof import('../solution/errors.ts')>(import.meta.url, 'errors.ts');

const question = [{ role: 'user' as const, content: '你好' }];
const calcTool = [{ type: 'function' as const, function: { name: 'calculator', parameters: { type: 'object' } } }];

describe('第 8 天：停止原因和用量的换算（TODO 3）', () => {
  test('stop_reason 换成 Agent 认识的 finish_reason，不认识的原样交回', () => {
    expect(toFinishReason('end_turn')).toBe('stop');
    expect(toFinishReason('stop_sequence')).toBe('stop');
    expect(toFinishReason('tool_use')).toBe('tool_calls');
    expect(toFinishReason('max_tokens')).toBe('length');
    expect(toFinishReason('refusal'), '被拒绝回答，相当于被拦截').toBe('content_filter');
    expect(toFinishReason('pause_turn')).toBe('pause_turn');
  });

  test('Anthropic 的 input_tokens 不包括缓存：要把缓存命中和写入缓存的部分加回来', () => {
    expect(
      toUsage({ input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 30 }),
    ).toEqual({ inputTokens: 1250, cachedTokens: 1000, outputTokens: 30, reasoningTokens: 0 });
    expect(toUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 3 } })).toEqual({
      inputTokens: 10,
      cachedTokens: 0,
      outputTokens: 5,
      reasoningTokens: 3,
    });
  });
});

describeMock('第 8 天：解析 Anthropic 的流式事件（TODO 2）', () => {
  test('文字一段段回调 onText，拼出完整的回复', async () => {
    llm.reply({ content: '你好！我是一个能用工具的助手。', usage: { prompt_tokens: 120, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 100 } } });
    const pieces: string[] = [];
    const result = await createAnthropicModel().chat({ messages: question }, { onText: (text) => pieces.push(text) });

    expect(pieces.length).toBeGreaterThan(1);
    expect(result).toEqual({
      message: { role: 'assistant', content: '你好！我是一个能用工具的助手。' },
      finishReason: 'stop',
      usage: { inputTokens: 120, cachedTokens: 100, outputTokens: 12, reasoningTokens: 0 },
    });
    expect(llm.anthropicRequests[0]).toMatchObject({ model: 'mock-model', stream: true, max_tokens: 8192 });
  });

  test('工具调用：input_json_delta 的片段拼成 arguments 字符串', async () => {
    llm.reply({ toolCalls: [{ id: 'toolu_1', name: 'calculator', arguments: { expression: '(1+2)*3' } }] });
    const result = await createAnthropicModel().chat({ messages: question, tools: calcTool });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.message, 'content_block_start 里的 input 只是个空对象，参数要把 input_json_delta 的 partial_json 拼起来').toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"(1+2)*3"}' } }],
    });
  });

  test('思考：文字放进 reasoning_content 并回调 onReasoning，带签名的思考块原样存进 thinking_blocks', async () => {
    llm.reply({ reasoning: '用户在打招呼', content: '你好！' });
    const thinking: string[] = [];
    const result = await createAnthropicModel().chat({ messages: question }, { onReasoning: (text) => thinking.push(text) });
    expect(thinking.join('')).toBe('用户在打招呼');
    expect(result.message.reasoning_content).toBe('用户在打招呼');
    expect(result.message.thinking_blocks).toEqual([
      { type: 'thinking', thinking: '用户在打招呼', signature: expect.stringMatching(/^mock-signature-/) },
    ]);
  });

  test('stop_reason 换算成 finish_reason：max_tokens → length，refusal → content_filter', async () => {
    llm.reply({ content: '写到一半', finishReason: 'length' }).reply({ content: '', finishReason: 'refusal' });
    expect((await createAnthropicModel().chat({ messages: question })).finishReason).toBe('length');
    expect((await createAnthropicModel().chat({ messages: question })).finishReason).toBe('content_filter');
  });

  test('接口返回错误时抛出 ModelError，带上状态码和 Anthropic 的错误类型', async () => {
    llm.fail({ status: 529, message: 'Overloaded' });
    const error = await createAnthropicModel().chat({ messages: question }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ status: 529, type: 'overloaded_error' });
  });

  test('传到一半连接断了，或者没收到 message_stop：报错，不交回半截回复', async () => {
    llm.reply({ content: '这段话传不完整，连接就断了。', disconnectAfter: 4 });
    await expect(createAnthropicModel().chat({ messages: question })).rejects.toThrow();
  });
});
