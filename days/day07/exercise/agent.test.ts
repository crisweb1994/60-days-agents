// TODO 4：给第 6 天的循环写单元测试。用脚本化的假模型精确控制每一轮的回复，再检查 Agent 的行为和发出的请求。
// 运行你的测试：npx vitest --config days/day07/vitest.config.ts
// npm run check 7 会先在正确的 Agent 上跑一遍你的测试，再换成 6 个故意藏了 bug 的 Agent（tests/mutants/）各跑一遍：
// 你的测试要在正确的 Agent 上全部通过，换成每个有 bug 的 Agent 时都要有测试失败。
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

  // TODO 4：把下面的 test.todo 换成真正的测试。检查第二次请求里的历史（model.requests[1].messages）：
  // 带工具调用的 assistant 消息后面，紧跟着 tool_call_id 对得上、内容是工具结果的 tool 消息
  test.todo('第二次请求带上了工具调用和结果，tool_call_id 对得上');
});

describe('三道护栏', () => {
  // TODO 4：把下面的 test.todo 换成真正的测试，每一种停下的原因各一个，检查 result.status：
  // - max_steps：模型一直在调用工具（参数每次不同），步数用完就停下
  // - repeated_calls：同样的调用超过 maxRepeats 次就停下，多出来的那次不执行（可以用 onToolCall 数执行了几次）
  // - truncated：finishReason 是 length 时停下，被截断的工具调用不执行（比如检查文件没有被写出来）
  // - blocked：finishReason 是 content_filter 或 sensitive 时停下
  // - tool_errors：工具连续出错 maxToolErrors 次就停下（比如让计算器除以 0）
  // 小技巧：在脚本最后多放一步 { text: '…' }，有 bug 的 Agent 会用到它、得到 completed，你的断言就能清楚地报出差别
  test.todo('步数用完就停下');
  test.todo('同样的调用超过 maxRepeats 次就停下，不再执行');
  test.todo('输出被截断时停下，被截断的工具调用不执行');
  test.todo('被内容审核拦截时停下');
  test.todo('工具连续出错就停下');
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
