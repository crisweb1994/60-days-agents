// 第 59 天手写题四：指数退避加抖动的重试。
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
  const { retries = 3, baseMs = 200, maxMs = 5000, isRetryable = () => true, random = Math.random, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      const after = (error as { retryAfterMs?: unknown })?.retryAfterMs;
      await sleep(typeof after === 'number' ? Math.min(after, maxMs) : Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt)));
    }
  }
}
