// 第 59 天手写题四：指数退避加抖动的重试。
// 第 59 天的练习：TODO 4 在这里，15 分钟。不要看前面任何一天的代码，计时写。检查：npm run check 59
export interface RetryOptions {
  /** 最多重试几次（不算第一次），默认 3 */
  retries?: number;
  /** 第一次重试前的基础等待，毫秒，默认 200 */
  baseMs?: number;
  /** 等待的上限，默认 5000 */
  maxMs?: number;
  /** 这个错误要不要重试，默认都重试 */
  isRetryable?: (error: unknown) => boolean;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 重试：
 * - 第 attempt 次重试（从 0 开始）前等待：错误上有 retryAfterMs（服务器说的 Retry-After）就用它（不超过 maxMs）；
 *   否则 full jitter：floor(random() × min(maxMs, baseMs × 2^attempt))
 * - isRetryable 说不重试的错误、或者重试次数用完了：把最后的错误抛出去
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  // TODO 4
  void fn; void options;
  throw new Error('TODO 4：还没有实现 retry');
}
