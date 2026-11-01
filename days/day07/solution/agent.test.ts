// 第 6 天那个循环的单元测试：用脚本化的假模型精确控制每一轮的回复，再检查 Agent 的行为和发出的请求。
// 运行：npx vitest --config days/day07/vitest.config.ts（参考答案加上 CHECK_TARGET=solution）
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';
import { runAgent } from './agent.ts';
import { loadCassette, replayModel } from './testing/cassette.ts';
import { createScriptedModel } from './testing/scripted-model.ts';
import { createTools } from './tools/index.ts';

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day07-'));
});
const tools = () => createTools(workspace);
const calc = (expression: string) => ({ name: 'calculator', arguments: { expression } });

describe('正常的流程', () => {
  test('调用工具后给出回答', async () => {
    const model = createScriptedModel([{ toolCalls: [calc('6 * 7')] }, { text: '答案是 42。' }]);
    const result = await runAgent('6 乘 7 是多少？', { model, tools: tools() });
    expect(result).toMatchObject({ status: 'completed', answer: '答案是 42。', steps: 2 });
    expect(model.remaining).toBe(0);
  });

  test('第二次请求带上了工具调用和结果，tool_call_id 对得上', async () => {
    const model = createScriptedModel([{ toolCalls: [{ id: 'call_a', ...calc('6 * 7') }] }, { text: '42' }]);
    await runAgent('6 乘 7 是多少？', { model, tools: tools() });
    const history = model.requests[1].messages;
    expect(history.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_a' }] });
    expect(history.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_a', content: '42' });
  });

  test('一轮里的多个工具调用，结果按顺序放回历史', async () => {
    const model = createScriptedModel([
      { toolCalls: [{ id: 'call_1', ...calc('1 + 1') }, { id: 'call_2', ...calc('2 + 2') }] },
      { text: '2 和 4' },
    ]);
    await runAgent('算两个数', { model, tools: tools() });
    const toolMessages = model.requests[1].messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '2' },
      { role: 'tool', tool_call_id: 'call_2', content: '4' },
    ]);
  });
});

describe('三道护栏', () => {
  test('步数用完就停下', async () => {
    const model = createScriptedModel([{ toolCalls: [calc('1 + 1')] }, { toolCalls: [calc('2 + 2')] }]);
    const result = await runAgent('一直算', { model, tools: tools(), maxSteps: 2 });
    expect(result.status).toBe('max_steps');
  });

  test('同样的调用超过 maxRepeats 次就停下，不再执行', async () => {
    const model = createScriptedModel([
      { toolCalls: [calc('1 + 1')] },
      { toolCalls: [calc('1 + 1')] },
      { toolCalls: [calc('1 + 1')] },
      { text: '2' },
    ]);
    const executed: string[] = [];
    const result = await runAgent('算 1 + 1', {
      model,
      tools: tools(),
      maxRepeats: 2,
      onToolCall: (call) => executed.push(call.id),
    });
    expect(result.status).toBe('repeated_calls');
    expect(executed).toHaveLength(2);
  });

  test('输出被截断时停下，被截断的工具调用不执行', async () => {
    const model = createScriptedModel([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'plan.md', content: '第一步' } }], finishReason: 'length' },
      { text: '写好了' },
    ]);
    const result = await runAgent('写计划', { model, tools: tools() });
    expect(result.status).toBe('truncated');
    expect(existsSync(join(workspace, 'plan.md'))).toBe(false);
  });

  test('被内容审核拦截时停下', async () => {
    const model = createScriptedModel([{ text: '', finishReason: 'sensitive' }, { text: '……' }]);
    expect((await runAgent('……', { model, tools: tools() })).status).toBe('blocked');
  });

  test('工具连续出错就停下', async () => {
    const model = createScriptedModel([
      { toolCalls: [calc('1 / 0')] },
      { toolCalls: [calc('2 / 0')] },
      { toolCalls: [calc('3 / 0')] },
      { text: '算不了' },
    ]);
    const result = await runAgent('算一下', { model, tools: tools(), maxToolErrors: 3 });
    expect(result.status).toBe('tool_errors');
  });
});

// 回放 cassettes/ 目录里的每一份录制：真实模型说过的话，离线重放一遍，结果应该和录制时一样
const cassetteDir = fileURLToPath(new URL('./cassettes/', import.meta.url));
const cassettes = readdirSync(cassetteDir).filter((file) => file.endsWith('.json'));

describe('回放录制', () => {
  test.each(cassettes)('%s', async (file) => {
    const cassette = await loadCassette(join(cassetteDir, file));
    const question = cassette.interactions[0].request.messages.find((m) => m.role === 'user')?.content ?? '';
    const model = replayModel(cassette);
    const result = await runAgent(question, { model, tools: tools() });
    expect(result.answer).toBe(cassette.interactions.at(-1)?.response.message.content);
    expect(model.remaining, '录下来的每一次调用都要用到').toBe(0);
  });
});
