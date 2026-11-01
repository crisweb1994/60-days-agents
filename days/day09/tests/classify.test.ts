import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { classifyError, parseRetryAfter } = await loadTarget<typeof import('../solution/retry.ts')>(import.meta.url, 'retry.ts');
const { ModelError, NetworkError } = await loadTarget<typeof import('../solution/errors.ts')>(import.meta.url, 'errors.ts');

const modelError = (status: number, message = '', options: { code?: string; type?: string; headers?: Record<string, string> } = {}) =>
  new ModelError(status, `模型调用失败（${status}）：${message}`, { ...options, headers: new Headers(options.headers) });

describe('第 9 天：读出 Retry-After（TODO 2）', () => {
  test('Retry-After 是秒数', () => {
    expect(parseRetryAfter(new Headers({ 'Retry-After': '2' }))).toBe(2000);
    expect(parseRetryAfter(new Headers({ 'Retry-After': '0.5' }))).toBe(500);
  });

  test('Retry-After 也可能是一个 HTTP 日期', () => {
    const now = Date.parse('2026-11-01T08:00:00Z');
    expect(parseRetryAfter(new Headers({ 'Retry-After': 'Sun, 01 Nov 2026 08:00:30 GMT' }), now)).toBe(30_000);
    expect(parseRetryAfter(new Headers({ 'Retry-After': 'Sun, 01 Nov 2026 07:59:00 GMT' }), now), '已经过去的时间算 0').toBe(0);
  });

  test('有 retry-after-ms 时优先用它（OpenAI 的 SDK 也是这样）', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '1500', 'Retry-After': '2' }))).toBe(1500);
  });

  test('没有或者看不懂：返回 undefined', () => {
    expect(parseRetryAfter(new Headers())).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'Retry-After': 'soon' }))).toBeUndefined();
  });
});

describe('第 9 天：错误分类（TODO 1）', () => {
  test('429 限流：值得重试，带上 Retry-After 要求等待的时间', () => {
    expect(classifyError(modelError(429, 'Rate limit reached', { headers: { 'Retry-After': '3' } }))).toEqual({
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 3000,
    });
    expect(classifyError(modelError(429, '', { type: 'engine_overloaded_error' })), 'Kimi 的引擎过载也是 429，可以重试').toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    });
  });

  test('429 也可能是额度用完了：重试没用', () => {
    const cases = [
      modelError(429, 'You exceeded your current quota', { code: 'insufficient_quota', type: 'insufficient_quota' }), // OpenAI
      modelError(429, '', { type: 'exceeded_current_quota_error' }), // Kimi
      modelError(429, '您的账户已欠费，请充值后重试', { code: '1113' }), // 智谱 GLM
    ];
    for (const error of cases) expect(classifyError(error), error.message).toMatchObject({ kind: 'quota', retryable: false });
    expect(classifyError(modelError(402, 'Insufficient Balance')), 'DeepSeek 的余额不足是 402').toMatchObject({ kind: 'quota', retryable: false });
  });

  test('5xx 和 529：服务端出错或过载，值得重试', () => {
    for (const status of [500, 502, 503, 504, 529]) {
      expect(classifyError(modelError(status)), `${status}`).toMatchObject({ kind: 'server', retryable: true });
    }
  });

  test('上下文超长：重试没用，要缩短输入', () => {
    const cases = [
      modelError(400, "This model's maximum context length is 65536 tokens", { code: 'context_length_exceeded' }), // OpenAI 风格
      modelError(400, 'Input token length too long', { type: 'invalid_request_error' }), // Kimi
      modelError(400, 'prompt is too long: 210000 tokens > 200000 maximum', { type: 'invalid_request_error' }), // Anthropic
      modelError(400, 'Prompt 超长', { code: '1261' }), // 智谱 GLM
    ];
    for (const error of cases) expect(classifyError(error), error.message).toMatchObject({ kind: 'context_length', retryable: false });
  });

  test('认证失败和其他请求错误：重试没用', () => {
    expect(classifyError(modelError(401, 'Invalid API key'))).toMatchObject({ kind: 'auth', retryable: false });
    expect(classifyError(modelError(403, 'Permission denied'))).toMatchObject({ kind: 'auth', retryable: false });
    expect(classifyError(modelError(400, 'Invalid tools'))).toMatchObject({ kind: 'bad_request', retryable: false });
    expect(classifyError(modelError(404, 'Model not found'))).toMatchObject({ kind: 'bad_request', retryable: false });
  });

  test('网络错误、连接中途断开：值得重试', () => {
    expect(classifyError(new TypeError('fetch failed')), '连不上、连接被重置').toMatchObject({ kind: 'network', retryable: true });
    expect(classifyError(new TypeError('terminated')), '读响应读到一半断了').toMatchObject({ kind: 'network', retryable: true });
    expect(classifyError(new NetworkError('流式响应没有正常结束')), '流没有正常结束').toMatchObject({ kind: 'network', retryable: true });
  });

  test('超时值得重试；用户取消绝不重试', () => {
    expect(classifyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(classifyError(modelError(408, 'Request Timeout'))).toMatchObject({ kind: 'timeout', retryable: true });
    expect(classifyError(new DOMException('This operation was aborted', 'AbortError'))).toEqual({ kind: 'aborted', retryable: false });
  });

  test('不认识的错误：保守起见不重试', () => {
    expect(classifyError(new Error('程序里的 bug'))).toEqual({ kind: 'unknown', retryable: false });
    expect(classifyError(new TypeError('Cannot read properties of undefined')), '普通的 TypeError 是程序的 bug，不是网络错误').toEqual({
      kind: 'unknown',
      retryable: false,
    });
  });
});
