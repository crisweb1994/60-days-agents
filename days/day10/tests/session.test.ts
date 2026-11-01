import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createSession } = await loadTarget<typeof import('../solution/session.ts')>(import.meta.url, 'session.ts');
const { createModel, PROVIDERS } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day10-session-'));
});
const newSession = (provider: 'openai' | 'anthropic' = 'openai') =>
  createSession({ model: createModel(provider), tools: createTools(workspace) });

describeMock('第 10 天：接着之前的对话往下聊（TODO 1）', () => {
  test('传入 history：在它后面追加新问题，不再重复 system prompt，也不改传进来的数组', async () => {
    llm.reply({ content: '记住了，是 42。' }).reply({ content: '你让我记住的是 42。' });
    const first = await runAgent('记住数字 42', { model: createModel('openai'), tools: createTools(workspace) });
    const history = [...first.messages];
    const second = await runAgent('我让你记住的数字是多少？', { model: createModel('openai'), tools: createTools(workspace), history });

    expect(llm.requests[1].messages.map((m) => m.role), '第二次请求带上了第一轮的问答').toEqual(['system', 'user', 'assistant', 'user']);
    expect(llm.requests[1].messages.filter((m) => m.role === 'system'), 'system prompt 只出现一次').toHaveLength(1);
    expect(second.messages).toHaveLength(5);
    expect(history, '不要修改传进来的 history').toHaveLength(3);
  });
});

describeMock('第 10 天：会话（TODO 3）', () => {
  test('多轮对话：每一轮都带上之前的历史，轮数和用量累加起来', async () => {
    llm
      .reply({ content: '记住了。', usage: { prompt_tokens: 100, completion_tokens: 5 } })
      .reply({ content: '是 42。', usage: { prompt_tokens: 130, completion_tokens: 4 } });
    const session = newSession();
    await session.send('记住数字 42');
    const result = await session.send('数字是多少？');

    expect(result.answer).toBe('是 42。');
    expect(session.turns).toBe(2);
    expect(session.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(session.usage).toMatchObject({ inputTokens: 230, outputTokens: 9 });
  });

  test('这一轮出错了：历史保持原样，可以直接再试一次', async () => {
    llm.reply({ content: '你好！' }).fail({ status: 400, message: '请求有问题' });
    const session = newSession();
    await session.send('你好');
    await expect(session.send('这一轮会出错')).rejects.toThrow('请求有问题');
    expect(session.messages, '出错的那一轮不能记进历史').toHaveLength(3);
    expect(session.turns).toBe(1);
  });

  test('clear() 清空历史，下一轮从头开始；累计的用量保留', async () => {
    llm.reply({ content: '一', usage: { prompt_tokens: 10, completion_tokens: 1 } }).reply({ content: '二' });
    const session = newSession();
    await session.send('第一个话题');
    session.clear();
    expect(session.messages).toEqual([]);
    await session.send('第二个话题');
    expect(llm.requests[1].messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(session.usage.inputTokens).toBeGreaterThanOrEqual(10);
  });

  test('中途换模型：历史保留，转换成新协议的格式发出去', async () => {
    llm
      .reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '6 * 7' } }] })
      .reply({ content: '是 42。' })
      .reply({ content: '刚才算出来的是 42。' });
    const session = newSession('openai');
    await session.send('6 乘 7 是多少？');
    session.model = createModel('anthropic');
    const result = await session.send('刚才的结果是多少？');

    expect(result.answer).toBe('刚才算出来的是 42。');
    expect(llm.anthropicRequests, '换模型以后，请求发到了 Anthropic 协议的接口').toHaveLength(1);
    const sent = llm.anthropicRequests[0];
    expect(sent.system, 'system prompt 放到了顶层').toBeTruthy();
    expect(sent.messages.map((m) => m.role), '之前用 OpenAI 协议的工具调用和结果，转换成了 Anthropic 的格式').toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
  });
});

describe.each(PROVIDERS)('第 10 天：真实模型（%s）', (provider) => {
  describeE2E('多轮对话', () => {
    test('记得上一轮说过的话', async () => {
      const session = newSession(provider);
      await session.send('请记住这个数字：4729。只回答「记住了」。');
      const result = await session.send('我刚才让你记住的数字是多少？');
      expect(result.answer).toContain('4729');
    });
  });
});
