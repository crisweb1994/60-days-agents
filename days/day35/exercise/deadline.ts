// 第 35 天：总时间预算。第 9 天给每一次模型调用设了超时（120 秒），但一次研究要调用几十次，
// 每次都不超时，加起来也可能是十分钟。用户能等的是「整件事」的时间，所以要有一个总的期限（deadline）：
// 从开始算起，到点了还没做完的就停下，用已经有的结果交差。
// 第 35 天的练习：TODO 3 在这里。检查：npm run check 35
import type { ChatOptions, ChatRequest, ChatResult, Model } from './types.ts';

/** 期限已经过了，不再开始新的调用 */
export class DeadlineExceededError extends Error {
  constructor(message = '时间预算用完了') {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

export interface Deadline {
  /** 到点时触发 */
  readonly signal: AbortSignal;
  /** 还剩多少毫秒，不会小于 0 */
  remaining(): number;
  expired(): boolean;
  /**
   * 从剩下的时间里划出一段：最多 ms 毫秒，也不超过剩下的。返回一个信号，哪个先到就触发。
   * 比如留出写报告的时间：调研只能用 deadline.within(deadline.remaining() - 留给报告的)
   */
  within(ms: number): AbortSignal;
}

/**
 * 创建一个从现在开始、totalMs 毫秒以后到期的期限。
 * now 只用来算 remaining（测试时可以换成假的）；signal 是真的计时器（AbortSignal.timeout）
 */
export function createDeadline(totalMs: number, { now = () => performance.now() }: { now?: () => number } = {}): Deadline {
  // TODO 3（一）：记下开始的时间；signal 用 AbortSignal.timeout（只接受整数，先 Math.round）；
  // remaining 是 totalMs 减去已经过去的时间，不小于 0；expired 是 signal 触发了或者 remaining 为 0；
  // within(ms) 用 AbortSignal.any 合并 signal 和一个 min(ms, remaining()) 毫秒的超时
  void now;
  const signal = new AbortController().signal;
  return { signal, remaining: () => totalMs, expired: () => false, within: () => signal };
}

/**
 * 包一层模型：每次调用都带上期限的信号（和调用方自己的 signal 合在一起）。
 * 期限已经过了就不再调用，直接抛出 DeadlineExceededError：不要在最后一秒发出一个注定等不到结果的请求。
 * 包在 withRetry 外面：期限一到，信号触发，withRetry 看到的是「调用方取消了」，就不会再重试
 */
export function withDeadline(model: Model, deadline: Deadline): Model {
  return {
    name: model.name,
    chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
      // TODO 3（二）：期限过了就返回一个 rejected 的 Promise（DeadlineExceededError），不再调用；
      // 否则把 deadline.signal 和 options.signal（有的话）合在一起，传给 model.chat
      void deadline;
      return model.chat(request, options);
},
  };
}
