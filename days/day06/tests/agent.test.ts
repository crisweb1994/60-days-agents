import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

let workspace: string;
let tools: ReturnType<typeof createTools>;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day06-'));
  tools = createTools(workspace);
});

const calc = (expression: string, id?: string) => ({ id, name: 'calculator', arguments: { expression } });

/** 历史是否完整：每个工具调用后面都有对应的结果 */
function unanswered(messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]) {
  const ids = messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  const answered = new Set(messages.map((m) => m.tool_call_id).filter(Boolean));
  return ids.filter((id) => !answered.has(id));
}

describeMock('第 6 天：正常完成', () => {
  test('查完工具给出回答：status 是 completed，带上步数、finishReason 和完整的历史', async () => {
    llm.reply({ toolCalls: [calc('6 * 7')] }).reply({ content: '答案是 42。' });
    const result = await runAgent('6 乘 7 是多少？', { tools });
    expect(result).toMatchObject({ status: 'completed', answer: '答案是 42。', finishReason: 'stop', steps: 2 });
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
  });

  test('有的兼容接口调用工具时 finish_reason 也是 stop：照样执行工具', async () => {
    llm.reply({ toolCalls: [calc('6 * 7')], finishReason: 'stop' }).reply({ content: '答案是 42。' });
    const result = await runAgent('6 乘 7 是多少？', { tools });
    expect(result.status).toBe('completed');
    expect(llm.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', content: '42' });
  });
});

describeMock('第 6 天：护栏一，防止死循环（TODO 1）', () => {
  test('步数用完还在调用工具：停下，status 是 max_steps，不再多调用一次模型', async () => {
    for (let i = 1; i <= 3; i++) llm.reply({ toolCalls: [calc(`${i} + ${i}`)] });
    const result = await runAgent('一直算下去', { tools, maxSteps: 3 });
    expect(result.status).toBe('max_steps');
    expect(result.steps).toBe(3);
    expect(llm.requests, '调用了 maxSteps 次模型就要停下').toHaveLength(3);
  });

  test('同样的调用执行过 maxRepeats 次，再出现就停下，status 是 repeated_calls', async () => {
    llm
      .reply({ toolCalls: [calc('1 + 1')] })
      .reply({ toolCalls: [{ name: 'calculator', arguments: '{ "expression" : "1 + 1" }' }] }) // 只是空格不同，也算同一个调用
      .reply({ toolCalls: [calc('1 + 1')] })
      .reply({ content: '1 + 1 = 2' }); // 正确的实现用不到这一轮
    const executed: string[] = [];
    const result = await runAgent('算 1 + 1', {
      tools,
      maxRepeats: 2,
      onToolCall: (call) => executed.push(call.function.arguments),
    });
    expect(executed, '前两次照常执行；第三次超过了 maxRepeats，执行之前就要停下').toHaveLength(2);
    expect(result.status).toBe('repeated_calls');
    expect(llm.requests).toHaveLength(3);
  });

  test('参数不同就不算重复', async () => {
    llm.reply({ toolCalls: [calc('1 + 1')] }).reply({ toolCalls: [calc('1 + 2')] }).reply({ toolCalls: [calc('1 + 3')] }).reply({ content: '算完了' });
    const result = await runAgent('算三次', { tools, maxRepeats: 1 });
    expect(result.status).toBe('completed');
  });
});

describeMock('第 6 天：护栏二，异常停止（TODO 2）', () => {
  test('回答被截断（length）：status 是 truncated，返回已经生成的部分', async () => {
    llm.reply({ content: '长城始建于春秋战国时期，秦朝把', finishReason: 'length' });
    const result = await runAgent('详细介绍长城', { tools });
    expect(result).toMatchObject({ status: 'truncated', answer: '长城始建于春秋战国时期，秦朝把', finishReason: 'length' });
  });

  test('工具调用被截断：就算参数恰好是合法的 JSON，内容也可能是半截的，不能执行', async () => {
    llm
      .reply({
        toolCalls: [{ id: 'call_cut', name: 'write_file', arguments: { path: 'notes/plan.md', content: '第一步：调研' } }],
        finishReason: 'length',
      })
      .reply({ content: '计划写好了。' }); // 正确的实现用不到这一轮
    const result = await runAgent('写个计划', { tools });
    expect(existsSync(join(workspace, 'notes/plan.md')), '截断的工具调用不能执行：先检查 finish_reason').toBe(false);
    expect(result.status).toBe('truncated');
    expect(llm.requests).toHaveLength(1);
  });

  test('被内容审核拦截：OpenAI 的 content_filter 和 GLM 的 sensitive，status 都是 blocked', async () => {
    llm.reply({ content: '', finishReason: 'content_filter' }).reply({ content: '', finishReason: 'sensitive' });
    expect((await runAgent('……', { tools })).status).toBe('blocked');
    expect((await runAgent('……', { tools })).status).toBe('blocked');
  });

  test('不认识的 finish_reason：status 是 unexpected，记下原始的 finish_reason', async () => {
    llm.reply({ content: '', finishReason: 'network_error' }).reply({ content: '半截', finishReason: 'insufficient_system_resource' });
    expect(await runAgent('你好', { tools })).toMatchObject({ status: 'unexpected', finishReason: 'network_error' });
    expect(await runAgent('你好', { tools })).toMatchObject({ status: 'unexpected', finishReason: 'insufficient_system_resource' });
  });

  test('既没有回答也没有工具调用：status 是 unexpected', async () => {
    llm.reply({ content: '   ' });
    expect((await runAgent('你好', { tools })).status).toBe('unexpected');
  });

  test('finish_reason 是 tool_calls，却没有工具调用，但有回答：当作正常完成', async () => {
    llm.reply({ content: '你好！', finishReason: 'tool_calls' });
    expect((await runAgent('你好', { tools })).status).toBe('completed');
  });
});

describeMock('第 6 天：护栏三，工具异常（TODO 3）', () => {
  test('工具出错不会让循环停下：错误交回模型，它可以换个办法', async () => {
    llm
      .reply({ toolCalls: [{ name: 'read_file', arguments: { path: 'todo.md' } }] })
      .reply({ content: '没有找到 todo.md。' });
    const result = await runAgent('读一下 todo.md', { tools });
    expect(result.status).toBe('completed');
    expect(llm.requests[1].messages.at(-1)?.content).toContain('不存在');
  });

  test('工具连续出错 maxToolErrors 次：停下，status 是 tool_errors', async () => {
    llm
      .reply({ toolCalls: [calc('1 / 0')] })
      .reply({ toolCalls: [calc('2 / 0')] })
      .reply({ toolCalls: [calc('3 / 0')] });
    const result = await runAgent('算一下', { tools, maxToolErrors: 3 });
    expect(result.status).toBe('tool_errors');
    expect(llm.requests).toHaveLength(3);
  });

  test('中间成功一次，连续出错的计数就清零', async () => {
    llm
      .reply({ toolCalls: [calc('1 / 0')] })
      .reply({ toolCalls: [calc('2 / 0')] })
      .reply({ toolCalls: [calc('2 / 1')] })
      .reply({ toolCalls: [calc('3 / 0')] })
      .reply({ content: '有几个算式除以了 0。' });
    const result = await runAgent('算一下', { tools, maxToolErrors: 3 });
    expect(result.status).toBe('completed');
  });
});

describeMock('第 6 天：停下时历史仍然完整（TODO 4）', () => {
  test('截断或重复而停下时，没执行的工具调用也要补上结果，下一轮对话才能接着用', async () => {
    llm.reply({ toolCalls: [{ id: 'call_cut', name: 'write_file', arguments: '{"path": "a.md"' }], finishReason: 'length' });
    const truncated = await runAgent('写文件', { tools });
    expect(unanswered(truncated.messages), '截断的工具调用没有结果').toEqual([]);

    llm.reply({ toolCalls: [calc('1 + 1')] }).reply({ toolCalls: [calc('1 + 1', 'call_again')] });
    const repeated = await runAgent('算 1 + 1', { tools, maxRepeats: 1 });
    expect(repeated.status).toBe('repeated_calls');
    expect(unanswered(repeated.messages), '重复的工具调用没有结果').toEqual([]);
  });
});

describeE2E('第 6 天：真实模型', () => {
  test('正常的问题能完成', async () => {
    const result = await runAgent('用计算器算一下 123 * 456', { tools });
    expect(result.status).toBe('completed');
    expect(result.answer.replace(/[,，\s]/g, '')).toContain('56088');
  });

  test('步数不够时，停在 max_steps', async () => {
    const result = await runAgent('先用计算器算 123 * 456，再把结果写进 result.txt，最后读出来确认', {
      tools,
      maxSteps: 1,
    });
    expect(result.status).toBe('max_steps');
  });
});
