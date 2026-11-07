// 错误分类和重试。withRetry 包装一个模型：值得重试的错误，等一会儿再试；不值得的，马上报错。
// 它只重试「调用模型」这一步，已经执行过的工具不会因为重试而再执行一遍。
import { setTimeout as sleepFor } from 'node:timers/promises';
import { ModelError, NetworkError } from './errors.ts';
import type { ChatOptions, ChatRequest, ChatResult, Model } from './types.ts';

/**
 * 错误的种类：
 * - rate_limit：请求太快被限流，等一会儿再试
 * - server：服务端出错或过载（5xx、529），等一会儿再试
 * - timeout：超时，再试一次
 * - network：网络错误、连接中途断开，再试一次
 * - quota：额度用完、余额不足、欠费，重试没用
 * - context_length：输入超出了上下文窗口，重试没用，要缩短输入
 * - auth：API Key 不对或者没有权限，重试没用
 * - bad_request：请求本身有问题，重试没用
 * - aborted：用户取消，绝不重试
 * - unknown：不认识的错误，保守起见不重试
 */
export type ErrorKind =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'quota'
  | 'context_length'
  | 'auth'
  | 'bad_request'
  | 'aborted'
  | 'unknown';

export interface ErrorInfo {
  kind: ErrorKind;
  retryable: boolean;
  /** 服务器在 Retry-After 里要求等待的时间 */
  retryAfterMs?: number;
}

/** 额度、余额、欠费类的错误。它们常常也用 429，但重试没用 */
const QUOTA_PATTERN = /insufficient_quota|exceeded_current_quota|quota|billing|balance|credit|余额|欠费|额度/i;
/** 输入太长。各家的说法不一样，只能靠错误码和错误信息里的关键词 */
const CONTEXT_PATTERN = /context_length|context length|context window|maximum context|too long|token length|超长|超出.*(上下文|长度)/i;
/** GLM 的业务错误码：1113 欠费，1261 输入超长 */
const GLM_QUOTA_CODES = new Set(['1113']);
const GLM_CONTEXT_CODES = new Set(['1261']);

/** 从响应头里读出要等多久。OpenAI 的 SDK 会先看 retry-after-ms；Retry-After 可能是秒数，也可能是一个 HTTP 日期 */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = Number(headers.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/** 判断一个错误是哪一种、值不值得重试 */
export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'aborted', retryable: false };
  if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'timeout', retryable: true };
  // 连接失败、连接被重置是 fetch failed；读响应读到一半连接断了是 terminated
  if (error instanceof NetworkError) return { kind: 'network', retryable: true };
  if (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated')) {
    return { kind: 'network', retryable: true };
  }
  if (!(error instanceof ModelError)) return { kind: 'unknown', retryable: false };

  const { status, code = '', type = '' } = error;
  const text = `${code} ${type} ${error.message}`;
  if (status === 402 || GLM_QUOTA_CODES.has(code) || (status === 429 && QUOTA_PATTERN.test(text))) {
    return { kind: 'quota', retryable: false };
  }
  if (status === 429) return { kind: 'rate_limit', retryable: true, retryAfterMs: parseRetryAfter(error.headers) };
  if (status === 408) return { kind: 'timeout', retryable: true };
  // 409 是冲突，OpenAI 的 SDK 也会重试；529 是 Anthropic 的过载
  if (status === 409 || status >= 500) return { kind: 'server', retryable: true, retryAfterMs: parseRetryAfter(error.headers) };
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (GLM_CONTEXT_CODES.has(code) || status === 413 || CONTEXT_PATTERN.test(text)) return { kind: 'context_length', retryable: false };
  return { kind: 'bad_request', retryable: false };
}

/**
 * 第 attempt 次重试之前要等多久（attempt 从 0 开始）。指数退避加全抖动：
 * 上限每次翻倍，直到 maxDelayMs；实际等待在 0 到上限之间随机取，免得大家同时重试，又一起撞上限流
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random = Math.random): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(random() * cap);
}

export interface RetryInfo {
  /** 第几次重试，从 1 开始 */
  attempt: number;
  delayMs: number;
  kind: ErrorKind;
  error: unknown;
  /** 失败之前是否已经输出了一部分文字。界面可以据此提示「重新生成」 */
  partial: boolean;
}

export interface RetryOptions {
  /** 最多重试几次，不算第一次调用。默认 3 */
  maxRetries?: number;
  /** 第一次重试的等待上限，默认 500 毫秒 */
  baseDelayMs?: number;
  /** 等待上限最多增长到多少，默认 20 秒 */
  maxDelayMs?: number;
  /** 每一次调用的超时，默认 120 秒 */
  timeoutMs?: number;
  /** 服务器要求等的时间超过它，就不等了，直接报错。默认 60 秒 */
  maxRetryAfterMs?: number;
  /** 每次重试之前回调，用来告诉用户正在重试 */
  onRetry?: (info: RetryInfo) => void;
  /** 等待和随机数，测试时可以换掉 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const defaultSleep = async (ms: number, signal?: AbortSignal) => {
  await sleepFor(ms, undefined, { signal });
};

/** 包装一个模型，让它在遇到值得重试的错误时自动重试。返回的还是一个 Model，Agent 察觉不到区别 */
export function withRetry(model: Model, options: RetryOptions = {}): Model {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    timeoutMs = 120_000,
    maxRetryAfterMs = 60_000,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  return {
    name: model.name,
    async chat(request: ChatRequest, chatOptions: ChatOptions = {}): Promise<ChatResult> {
      const userSignal = chatOptions.signal;
      for (let attempt = 0; ; attempt++) {
        // 每一次调用单独计时。超时和用户取消，哪个先发生都停下，错误的 name 能区分是哪一个
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
        let partial = false;
        const track = (callback?: (text: string) => void) =>
          callback &&
          ((text: string) => {
            partial = true;
            callback(text);
          });
        try {
          return await model.chat(request, {
            signal,
            onText: track(chatOptions.onText),
            onReasoning: track(chatOptions.onReasoning),
          });
        } catch (error) {
          if (userSignal?.aborted) throw error; // 用户取消了：绝不重试
          const info = classifyError(error);
          if (!info.retryable || attempt >= maxRetries) throw error;
          let delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
          if (info.retryAfterMs !== undefined) {
            if (info.retryAfterMs > maxRetryAfterMs) throw error; // 要等太久了，不如直接告诉用户
            delayMs = info.retryAfterMs; // 服务器说了等多久，就等多久
          }
          onRetry?.({ attempt: attempt + 1, delayMs, kind: info.kind, error, partial });
          await sleep(delayMs, userSignal);
        }
      }
    },
  };
}
