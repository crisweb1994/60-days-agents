import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import type { RetryInfo } from '../solution/retry.ts';

const llm = await setupModel();
const { withRetry, backoffDelay, classifyError } = await loadTarget<typeof import('../solution/retry.ts')>(import.meta.url, 'retry.ts');
const { createOpenAIModel, openAIConfigFromEnv } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');
const { createAnthropicModel } = await loadTarget<typeof import('../solution/anthropic.ts')>(import.meta.url, 'anthropic.ts');
const { ModelError } = await loadTarget<typeof import('../solution/errors.ts')>(import.meta.url, 'errors.ts');
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

const question = { messages: [{ role: 'user' as const, content: '你好' }] };

/** 不真的等待，只记下要等多久；随机数固定为 1，等待时间就是确定的 */
function fakeTimers() {
  const slept: number[] = [];
  const retries: RetryInfo[] = [];
  return {
    slept,
    retries,
    options: {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      random: () => 1,
      onRetry: (info: RetryInfo) => retries.push(info),
    },
  };
}

describe('第 9 天：指数退避加抖动（TODO 3）', () => {
  test('等待的上限每次翻倍，直到 maxDelayMs', () => {
    const max = (attempt: number) => backoffDelay(attempt, 500, 4000, () => 1);
    expect([0, 1, 2, 3, 4, 5].map(max)).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
  });

  test('实际等待在 0 到上限之间随机取（全抖动）', () => {
    expect(backoffDelay(2, 500, 4000, () => 0)).toBe(0);
    expect(backoffDelay(2, 500, 4000, () => 0.5)).toBe(1000);
  });
});

describeMock('第 9 天：withRetry（TODO 4）', () => {
  test('429 带着 Retry-After：按服务器说的时间等，再试一次', async () => {
    llm.fail({ status: 429, message: 'Rate limit reached', headers: { 'Retry-After': '2' } }).reply({ content: '你好！' });
    const timers = fakeTimers();
    const result = await withRetry(createOpenAIModel(), timers.options).chat(question);

    expect(result.message.content).toBe('你好！');
    expect(llm.requests).toHaveLength(2);
    expect(timers.slept, 'Retry-After: 2 就等 2000 毫秒').toEqual([2000]);
    expect(timers.retries[0]).toMatchObject({ attempt: 1, kind: 'rate_limit', delayMs: 2000 });
  });

  test('503 两次后成功：按指数退避等待', async () => {
    llm.fail({ status: 503 }).fail({ status: 503 }).reply({ content: '恢复了' });
    const timers = fakeTimers();
    const result = await withRetry(createOpenAIModel(), { ...timers.options, baseDelayMs: 500 }).chat(question);
    expect(result.message.content).toBe('恢复了');
    expect(timers.slept, '随机数固定为 1 时，等待 500、1000 毫秒').toEqual([500, 1000]);
  });

  test('不值得重试的错误：马上抛出，只调用一次', async () => {
    llm.fail({ status: 400, message: 'Invalid request' });
    await expect(withRetry(createOpenAIModel(), fakeTimers().options).chat(question)).rejects.toBeInstanceOf(ModelError);
    expect(llm.requests).toHaveLength(1);

    llm.reset();
    llm.fail({ status: 429, message: 'You exceeded your current quota', code: 'insufficient_quota' });
    await expect(withRetry(createOpenAIModel(), fakeTimers().options).chat(question)).rejects.toThrow('quota');
    expect(llm.requests, '额度用完的 429 不能重试').toHaveLength(1);
  });

  test('重试次数用完：抛出最后一次的错误', async () => {
    for (let i = 0; i < 4; i++) llm.fail({ status: 503, message: `第 ${i + 1} 次失败` });
    const error = await withRetry(createOpenAIModel(), { ...fakeTimers().options, maxRetries: 3 }).chat(question).catch((e: unknown) => e);
    expect(llm.requests, '第一次加上 3 次重试').toHaveLength(4);
    expect((error as Error).message).toContain('第 4 次失败');
  });

  test('每次调用都有超时：太慢就放弃这一次，重新再试', async () => {
    llm.reply({ content: '太慢了', delayMs: 1000 }).reply({ content: '这次快' });
    const timers = fakeTimers();
    const result = await withRetry(createOpenAIModel(), { ...timers.options, timeoutMs: 100 }).chat(question);
    expect(result.message.content).toBe('这次快');
    expect(timers.retries[0]?.kind).toBe('timeout');
  });

  test('网络错误、传到一半连接断了：都会重试；已经输出过文字时，告诉调用方这是一次「从头再来」', async () => {
    llm.fail({ disconnect: true }).reply({ content: '这段话传到一半就断了', disconnectAfter: 4 }).reply({ content: '完整的回答' });
    const timers = fakeTimers();
    const pieces: string[] = [];
    const result = await withRetry(createOpenAIModel(), timers.options).chat(question, { onText: (t) => pieces.push(t) });
    expect(result.message.content).toBe('完整的回答');
    expect(timers.retries.map((r) => [r.kind, r.partial])).toEqual([
      ['network', false],
      ['network', true],
    ]);
  });

  test('用户取消：马上停下，不重试', async () => {
    llm.reply({ content: '这是一段很长很长很长很长的回答', chunkDelayMs: 30 }).reply({ content: '不应该用到' });
    const controller = new AbortController();
    const model = withRetry(createOpenAIModel(), fakeTimers().options);
    const error = await model.chat(question, { signal: controller.signal, onText: () => controller.abort() }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(llm.requests, '用户取消后不能再发请求').toHaveLength(1);
  });

  test('服务器要求等太久（超过 maxRetryAfterMs）：不等了，直接报错', async () => {
    llm.fail({ status: 429, headers: { 'Retry-After': '120' } }).reply({ content: '不应该用到' });
    const timers = fakeTimers();
    await expect(withRetry(createOpenAIModel(), { ...timers.options, maxRetryAfterMs: 60_000 }).chat(question)).rejects.toBeInstanceOf(ModelError);
    expect(timers.slept).toEqual([]);
  });

  test('Anthropic 协议的 529 过载，同样会重试', async () => {
    llm.fail({ status: 529, message: 'Overloaded' }).reply({ content: '恢复了' });
    const timers = fakeTimers();
    const result = await withRetry(createAnthropicModel(), timers.options).chat(question);
    expect(result.message.content).toBe('恢复了');
    expect(timers.retries[0]?.kind).toBe('server');
  });

  test('放进 Agent：重试的只是调用模型这一步，工具不会重复执行', async () => {
    llm
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'log.txt', content: '只写一次' } }] })
      .fail({ status: 503 })
      .reply({ content: '写好了。' });
    const executed: string[] = [];
    const workspace = await mkdtemp(join(tmpdir(), 'day09-'));
    const result = await runAgent('写个文件', {
      model: withRetry(createOpenAIModel(), fakeTimers().options),
      tools: createTools(workspace),
      onToolCall: (call) => executed.push(call.function.name),
    });
    expect(result.status).toBe('completed');
    expect(executed, '第二次调用模型失败后重试，write_file 不会再执行一遍').toEqual(['write_file']);
  });
});

describeE2E('第 9 天：真实模型服务的错误', () => {
  test('API Key 不对：分类为 auth，不重试', async () => {
    const retries: RetryInfo[] = [];
    const model = withRetry(createOpenAIModel({ ...openAIConfigFromEnv(), apiKey: 'sk-invalid-key-for-test' }), { onRetry: (r) => retries.push(r) });
    const error = await model.chat(question).catch((e: unknown) => e);
    expect(classifyError(error).kind).toBe('auth');
    expect(retries).toEqual([]);
  });

  test('模型名不存在：重试没用，不重试', async () => {
    const retries: RetryInfo[] = [];
    const model = withRetry(createOpenAIModel({ ...openAIConfigFromEnv(), model: 'no-such-model-for-test' }), { onRetry: (r) => retries.push(r) });
    const error = await model.chat(question).catch((e: unknown) => e);
    expect(classifyError(error).retryable).toBe(false);
    expect(retries).toEqual([]);
  });
});
