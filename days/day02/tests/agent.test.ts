import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import type { Usage } from '../solution/usage.ts';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');

describeMock('第 2 天：Agent 统计用量', () => {
  test('每次调用后回调 onUsage，最后返回所有调用的总用量', async () => {
    llm
      .reply({
        toolCalls: [{ id: 'call_mcp', name: 'lookup_term', arguments: { term: 'MCP' } }],
        usage: { prompt_tokens: 300, completion_tokens: 20 },
      })
      .reply({
        content: 'MCP 是一个开放协议。',
        usage: { prompt_tokens: 420, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 256 } },
      });

    const calls: Usage[] = [];
    const result = await runAgent('什么是 MCP？', { onUsage: (usage) => calls.push(usage) });

    expect(result.answer).toBe('MCP 是一个开放协议。');
    expect(calls, '每次调用模型都要回调一次 onUsage').toHaveLength(2);
    expect(
      calls.map((usage) => usage.inputTokens),
      '每次调用的用量来自 chat() 返回的 usage，要用 parseUsage 转换（TODO 4）',
    ).toEqual([300, 420]);
    expect(result.usage).toEqual({ inputTokens: 720, cachedTokens: 256, outputTokens: 80, reasoningTokens: 0 });
  });

  test('整条回复原样放回历史，包括 reasoning_content', async () => {
    llm
      .reply({
        reasoning: '需要先查术语表。',
        toolCalls: [{ id: 'call_agent', name: 'lookup_term', arguments: { term: 'Agent' } }],
      })
      .reply({ content: 'Agent 是让模型在循环里自己决定调用工具的程序。' });

    await runAgent('什么是 Agent？');
    expect(
      llm.requests[1].messages.at(-2),
      '带工具的对话里，有的模型服务要求把 reasoning_content 传回去。chat() 要原样返回 message',
    ).toMatchObject({ role: 'assistant', reasoning_content: '需要先查术语表。' });
  });
});

describeE2E('第 2 天：真实模型', () => {
  test('查术语表回答，并统计每次调用的用量', async () => {
    const calls: Usage[] = [];
    const result = await runAgent('「潮汐窗口」是什么意思？它的内部代号是什么？', {
      onUsage: (usage) => calls.push(usage),
    });
    expect(result.answer, '回答里应该有只有查术语表才知道的代号 TW-42').toContain('TW-42');
    expect(calls.length, '查表再回答，至少调用两次模型').toBeGreaterThanOrEqual(2);
    expect(calls[1].inputTokens, '第二次调用要带上完整的历史，输入应该比第一次多').toBeGreaterThan(calls[0].inputTokens);
  });
});
