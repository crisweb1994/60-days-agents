import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

// 先启动 mock 模型，再加载被测代码
const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');

describeMock('第 1 天：会查术语表的 Agent', () => {
  test('模型直接回答时，原样返回它的回答', async () => {
    llm.reply({ content: '你好！我可以帮你查术语。' });
    expect(await runAgent('你好')).toBe('你好！我可以帮你查术语。');
    expect(llm.requests, '模型直接回答时，只需要调用一次模型').toHaveLength(1);
  });

  test('请求里带上了 lookup_term 工具，参数 term 是必填的字符串', async () => {
    llm.reply({ content: '好的' });
    await runAgent('你好');
    const tool = llm.requests[0].tools?.find((t) => t.function.name === 'lookup_term');
    expect(tool, '请求的 tools 里没有找到名为 lookup_term 的工具').toBeDefined();
    expect(tool?.function.description, '工具要写 description，模型靠它判断什么时候该用').toBeTruthy();
    expect(tool?.function.parameters, 'parameters 要声明一个必填的字符串参数 term').toMatchObject({
      type: 'object',
      properties: { term: { type: 'string' } },
      required: ['term'],
    });
  });

  test('模型调用工具后，执行它并把结果交回模型，再返回最终回答', async () => {
    llm
      .reply({ toolCalls: [{ id: 'call_mcp', name: 'lookup_term', arguments: { term: 'MCP' } }] })
      .reply({ content: 'MCP 是让 Agent 统一接入工具和数据的开放协议。' });

    const answer = await runAgent('什么是 MCP？');

    expect(answer).toBe('MCP 是让 Agent 统一接入工具和数据的开放协议。');
    expect(llm.requests, '应该调用两次模型：第一次决定查表，第二次根据查到的定义回答').toHaveLength(2);
    const messages = llm.requests[1].messages;
    expect(messages.at(-2), '第二次请求要带上模型上一轮的工具调用').toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_mcp' }],
    });
    expect(messages.at(-1), '工具结果要放进 role 为 tool 的消息，tool_call_id 和调用的 id 对上').toMatchObject({
      role: 'tool',
      tool_call_id: 'call_mcp',
    });
    expect(messages.at(-1)?.content, '交回模型的应该是 lookupTerm 查到的定义').toContain('Model Context Protocol');
  });
});

describeE2E('第 1 天：真实模型', () => {
  test('查到虚构的术语「潮汐窗口」，并根据定义回答', async () => {
    const answer = await runAgent('「潮汐窗口」是什么意思？它的内部代号是什么？');
    expect(answer, '回答里应该有只有查术语表才知道的代号 TW-42').toContain('TW-42');
  });
});
