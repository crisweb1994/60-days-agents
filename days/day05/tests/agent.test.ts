import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day05-agent-'));
});

describeMock('第 5 天：会用工具的 Agent', () => {
  test('请求里带上四个工具的定义', async () => {
    llm.reply({ content: '你好！' });
    await runAgent('你好', { tools: createTools(workspace) });
    const names = llm.requests[0].tools?.map((tool) => tool.function.name);
    expect(names).toEqual(['calculator', 'read_file', 'write_file', 'http_request']);
  });

  test('一轮里的多个工具调用都执行，结果按顺序交回模型', async () => {
    llm
      .reply({
        toolCalls: [
          { id: 'call_calc', name: 'calculator', arguments: { expression: '(1234 + 5678) * 9' } },
          { id: 'call_write', name: 'write_file', arguments: { path: 'result.txt', content: '62208' } },
        ],
      })
      .reply({ content: '结果是 62208，已经写进 result.txt。' });

    const seen: string[] = [];
    const result = await runAgent('计算并保存', {
      tools: createTools(workspace),
      onToolCall: (call, toolResult) => seen.push(`${call.function.name}:${toolResult.isError}`),
    });

    expect(result.answer).toBe('结果是 62208，已经写进 result.txt。');
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('62208');
    const toolMessages = llm.requests[1].messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_calc', 'call_write']);
    expect(toolMessages[0].content).toBe('62208');
    expect(seen, '每个工具执行完都回调 onToolCall').toEqual(['calculator:false', 'write_file:false']);
  });

  test('工具出错不会让 Agent 崩溃：错误作为结果交回模型', async () => {
    llm
      .reply({ toolCalls: [{ id: 'call_read', name: 'read_file', arguments: { path: 'todo.md' } }] })
      .reply({ content: '没有找到 todo.md。' });
    const result = await runAgent('读一下 todo.md', { tools: createTools(workspace) });
    expect(result.answer).toBe('没有找到 todo.md。');
    expect(llm.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_read' });
    expect(llm.requests[1].messages.at(-1)?.content).toContain('不存在');
  });
});

describeE2E('第 5 天：真实模型', () => {
  test('用计算器算出准确的结果', async () => {
    const result = await runAgent('1234 * 5678 + 91011 等于多少？', { tools: createTools(workspace) });
    expect(result.answer.replace(/[,，\s]/g, ''), '答案是 7097663').toContain('7097663');
  });

  test('写入文件再读出来', async () => {
    await runAgent('在 notes/todo.txt 里写一行「买牛奶」，然后读出来确认一下', { tools: createTools(workspace) });
    expect(await readFile(join(workspace, 'notes/todo.txt'), 'utf8')).toContain('买牛奶');
  });
});
