import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { Message } from '../solution/types.ts';

const { createScriptedModel } = await loadTarget<typeof import('../solution/testing/scripted-model.ts')>(
  import.meta.url,
  'testing/scripted-model.ts',
);

const question = (): Message[] => [{ role: 'user', content: '你好' }];

describe('第 7 天：脚本化的假模型（TODO 2）', () => {
  test('按顺序返回脚本里的每一步', async () => {
    const model = createScriptedModel([{ text: '第一句' }, { text: '第二句' }]);
    expect((await model.chat({ messages: question() })).message.content).toBe('第一句');
    expect((await model.chat({ messages: question() })).message.content).toBe('第二句');
    expect(model.remaining).toBe(0);
  });

  test('文字回复：finishReason 默认是 stop，usage 默认全是 0', async () => {
    const model = createScriptedModel([{ text: '你好！' }]);
    expect(await model.chat({ messages: question() })).toEqual({
      message: { role: 'assistant', content: '你好！' },
      finishReason: 'stop',
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    });
  });

  test('工具调用：参数转成 JSON 字符串，没写 id 就自动生成，content 是 null，finishReason 是 tool_calls', async () => {
    const model = createScriptedModel([
      { toolCalls: [{ name: 'calculator', arguments: { expression: '1 + 1' } }, { id: 'call_x', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
    ]);
    const { message, finishReason } = await model.chat({ messages: question() });
    expect(finishReason).toBe('tool_calls');
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      { id: expect.any(String), type: 'function', function: { name: 'calculator', arguments: '{"expression":"1 + 1"}' } },
      { id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ]);
    expect(message.tool_calls![0].id, '自动生成的 id 不能是空的').toBeTruthy();
  });

  test('可以指定 finishReason、usage 和思考内容', async () => {
    const model = createScriptedModel([
      { text: '写到一半', reasoning: '先想想', finishReason: 'length', usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
    const result = await model.chat({ messages: question() });
    expect(result.finishReason).toBe('length');
    expect(result.message.reasoning_content).toBe('先想想');
    expect(result.usage).toEqual({ inputTokens: 100, cachedTokens: 0, outputTokens: 50, reasoningTokens: 0 });
  });

  test('有文字时回调 onText，有思考内容时回调 onReasoning', async () => {
    const model = createScriptedModel([{ reasoning: '想一想', text: '想好了' }]);
    const seen: string[] = [];
    await model.chat({ messages: question() }, { onText: (t) => seen.push(`text:${t}`), onReasoning: (t) => seen.push(`reasoning:${t}`) });
    expect(seen).toEqual(['reasoning:想一想', 'text:想好了']);
  });

  test('记下每个请求，而且是当时的副本：之后再修改 messages，记下的请求不变', async () => {
    const model = createScriptedModel([{ text: '一' }, { text: '二' }]);
    const messages = question();
    await model.chat({ messages });
    messages.push({ role: 'assistant', content: '一' }, { role: 'user', content: '再说一句' });
    await model.chat({ messages });
    expect(model.requests).toHaveLength(2);
    expect(
      model.requests[0].messages,
      'Agent 会接着往同一个 messages 数组里追加内容。要用 structuredClone 存一份副本，否则记下的请求会跟着变',
    ).toHaveLength(1);
    expect(model.requests[1].messages).toHaveLength(3);
  });

  test('脚本用完了还被调用：抛出错误，说明准备了几步', async () => {
    const model = createScriptedModel([{ text: '只有一句' }]);
    await model.chat({ messages: question() });
    await expect(model.chat({ messages: question() })).rejects.toThrow(/脚本已用完/);
  });

  test('脚本里放一个 Error，这一次调用就抛出它，用来模拟出错', async () => {
    const model = createScriptedModel([new Error('模拟的网络错误'), { text: '恢复了' }]);
    await expect(model.chat({ messages: question() })).rejects.toThrow('模拟的网络错误');
    expect((await model.chat({ messages: question() })).message.content).toBe('恢复了');
  });

  test('signal 已经取消时，直接抛出 AbortError', async () => {
    const model = createScriptedModel([{ text: '不会返回' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(model.chat({ messages: question() }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
