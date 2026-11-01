// 错误分类和重试。withRetry 包装一个模型：值得重试的错误，等一会儿再试；不值得的，马上报错。
// 它只重试「调用模型」这一步，已经执行过的工具不会因为重试而再执行一遍。
// 第 9 天的练习：补全这个文件里的 TODO 1–4。检查：npm run check 9
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
  // TODO 2：返回要等待的毫秒数，读不出来就返回 undefined。
  // - 先看 retry-after-ms：是一个不小于 0 的数字，就直接用
  // - 再看 Retry-After：是数字（秒），就乘以 1000
  // - 不是数字，就当作 HTTP 日期，用 Date.parse 解析，算出离 now 还有多久；已经过去了就算 0
  return undefined;
}

/** 判断一个错误是哪一种、值不值得重试 */
export function classifyError(error: unknown): ErrorInfo {
  // TODO 1：按下面的顺序判断，返回 { kind, retryable }，限流和服务端错误再带上 retryAfterMs（用 parseRetryAfter 读）。
  // 1. error.name 是 AbortError：aborted，不重试（用户取消了）；是 TimeoutError：timeout，重试
  // 2. NetworkError，或者 message 是 'fetch failed'、'terminated' 的 TypeError：network，重试。
  //    其他的 TypeError 多半是程序的 bug，不算网络错误
  // 3. 不是 ModelError：unknown，不重试
  // 4. ModelError，按状态码和错误码判断（code、type、message 里的关键词可以用 QUOTA_PATTERN 和 CONTEXT_PATTERN 匹配）：
  //    - 402、GLM 的错误码 1113，或者是 429 但看得出是额度、余额、欠费的问题：quota，不重试
  //    - 其他的 429：rate_limit，重试
  //    - 408：timeout，重试
  //    - 409 和 5xx（包括 Anthropic 的 529）：server，重试
  //    - 401、403：auth，不重试
  //    - GLM 的错误码 1261、413，或者看得出是输入太长：context_length，不重试
  //    - 其他：bad_request，不重试
  return { kind: 'unknown', retryable: false };
}

/**
 * 第 attempt 次重试之前要等多久（attempt 从 0 开始）。指数退避加全抖动：
 * 上限每次翻倍，直到 maxDelayMs；实际等待在 0 到上限之间随机取，免得大家同时重试，又一起撞上限流
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random = Math.random): number {
  // TODO 3：上限是 baseDelayMs 乘以 2 的 attempt 次方，但不超过 maxDelayMs；
  // 返回 0 到上限之间的随机数：random() 乘以上限，再四舍五入成整数
  return baseDelayMs;
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

  // TODO 4：返回一个新的 Model，name 不变，chat() 在值得重试的错误上自动重试。每一次尝试：
  // 1. 单独计时：AbortSignal.timeout(timeoutMs)，再和用户的 signal 合并（AbortSignal.any），作为这次调用的 signal
  // 2. 调用 model.chat，传入这个 signal。onText、onReasoning 各包一层：每次有输出时先记下 partial = true，再调用原来的回调
  // 3. 成功就返回结果。失败时：
  //    - 用户的 signal 已经取消：原样抛出，绝不重试
  //    - 用 classifyError 判断。不值得重试，或者已经重试了 maxRetries 次：原样抛出
  //    - 等待时间：默认用 backoffDelay(attempt, …, random)；服务器给了 retryAfterMs 就用它，
  //      但它超过 maxRetryAfterMs 时不等了，原样抛出
  //    - 回调 onRetry({ attempt: 第几次重试（从 1 开始）, delayMs, kind, error, partial })
  //    - await sleep(delayMs, 用户的 signal)，然后进入下一次尝试
  return model;
}
