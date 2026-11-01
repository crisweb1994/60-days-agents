import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import type { Message } from '../solution/types.ts';

const llm = await setupModel();
const { recordModel, replayModel, loadCassette } = await loadTarget<typeof import('../solution/testing/cassette.ts')>(
  import.meta.url,
  'testing/cassette.ts',
);
const { createScriptedModel } = await loadTarget<typeof import('../solution/testing/scripted-model.ts')>(
  import.meta.url,
  'testing/scripted-model.ts',
);
const { createOpenAIModel } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'day07-cassette-'));
});

describe('第 7 天：录制（TODO 3）', () => {
  test('照常调用被包装的模型，同时记下每次的请求和回复', async () => {
    const recorder = recordModel(createScriptedModel([{ text: '你好！' }]));
    const result = await recorder.chat({ messages: [{ role: 'user', content: '你好' }] });
    expect(result.message.content).toBe('你好！');
    expect(recorder.cassette.model, '记下被包装的模型的名字').toBe('scripted');
    expect(recorder.cassette.interactions).toEqual([{ request: { messages: [{ role: 'user', content: '你好' }] }, response: result }]);
  });

  test('记下的请求是当时的副本', async () => {
    const recorder = recordModel(createScriptedModel([{ text: '一' }]));
    const messages: Message[] = [{ role: 'user', content: '你好' }];
    await recorder.chat({ messages });
    messages.push({ role: 'user', content: '后来加的' });
    expect(recorder.cassette.interactions[0].request.messages).toHaveLength(1);
  });

  test('save 存成 JSON 文件，loadCassette 能读回来', async () => {
    const recorder = recordModel(createScriptedModel([{ text: '你好！' }]));
    await recorder.chat({ messages: [{ role: 'user', content: '你好' }] });
    const file = join(dir, 'nested/hello.json');
    await recorder.save(file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ model: 'scripted', interactions: [{}] });
    expect(await loadCassette(file)).toEqual(recorder.cassette);
  });
});

describe('第 7 天：回放（TODO 3）', () => {
  async function recordOnce() {
    const recorder = recordModel(createScriptedModel([{ toolCalls: [{ id: 'call_1', name: 'calculator', arguments: { expression: '6 * 7' } }] }, { text: '42' }]));
    await runAgent('6 乘 7 是多少？', { model: recorder, tools: createTools(dir) });
    return recorder.cassette;
  }

  test('按顺序重放录下的回复，并回调 onText', async () => {
    const cassette = await recordOnce();
    const model = replayModel(cassette);
    const pieces: string[] = [];
    const result = await runAgent('6 乘 7 是多少？', { model, tools: createTools(dir), onText: (t) => pieces.push(t) });
    expect(result).toMatchObject({ status: 'completed', answer: '42' });
    expect(pieces).toEqual(['42']);
    expect(model.remaining).toBe(0);
  });

  test('请求和录制时不一样：报错，指出第几次调用、哪条消息不一样', async () => {
    const cassette = await recordOnce();
    const model = replayModel(cassette);
    const error = await runAgent('7 乘 8 是多少？', { model, tools: createTools(dir) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message, '说明是第几次调用').toContain('第 1 次');
    expect((error as Error).message, '指出哪条消息不一样').toContain('messages[1]');
  });

  test('调用次数比录制的多：报错', async () => {
    const recorder = recordModel(createScriptedModel([{ text: '一' }]));
    await recorder.chat({ messages: [{ role: 'user', content: '你好' }] });
    const model = replayModel(recorder.cassette);
    await model.chat({ messages: [{ role: 'user', content: '你好' }] });
    await expect(model.chat({ messages: [{ role: 'user', content: '你好' }] })).rejects.toThrow('录制里只有 1 次调用');
  });
});

describeMock('第 7 天：录制真实的 HTTP 调用，再离线回放', () => {
  test('先通过 createOpenAIModel 录下一次运行，再不联网地回放', async () => {
    llm
      .reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '123 * 456' } }] })
      .reply({ content: '123 × 456 = 56088' });
    const recorder = recordModel(createOpenAIModel());
    const recorded = await runAgent('123 乘 456 是多少？', { model: recorder, tools: createTools(dir) });
    expect(recorded.status).toBe('completed');
    expect(JSON.stringify(recorder.cassette), '录制里不能有 API Key').not.toContain('mock-key');

    const requestsBefore = llm.requests.length;
    const replayed = await runAgent('123 乘 456 是多少？', { model: replayModel(recorder.cassette), tools: createTools(dir) });
    expect(replayed.answer).toBe('123 × 456 = 56088');
    expect(llm.requests.length, '回放时不能再发 HTTP 请求').toBe(requestsBefore);
  });
});

describeE2E('第 7 天：真实模型', () => {
  test('录下真实模型的一次运行，回放的结果和录制时一样', async () => {
    const recorder = recordModel(createOpenAIModel());
    const recorded = await runAgent('用计算器算一下 123 * 456', { model: recorder, tools: createTools(dir) });
    const file = join(dir, 'real.json');
    await recorder.save(file);

    const replayDir = await mkdtemp(join(tmpdir(), 'day07-replay-'));
    const replayed = await runAgent('用计算器算一下 123 * 456', {
      model: replayModel(await loadCassette(file)),
      tools: createTools(replayDir),
    });
    expect(replayed.answer).toBe(recorded.answer);
    expect(replayed.status).toBe(recorded.status);
  });
});
