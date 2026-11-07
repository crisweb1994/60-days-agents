// 第 35 天：故障注入。降级链、冷却、期限这些代码，平时很少走到：模型服务大部分时候是好的。
// 不能等线上出事才知道它们管不管用，要主动制造故障：让第几次调用失败、按比例随机失败、变慢。
import { ModelError } from '../errors.ts';
import type { ChatOptions, ChatRequest, Model } from '../types.ts';

/** 第 n 次调用（从 1 开始）要不要出错：返回一个错误就抛出它，返回 undefined 就正常调用 */
export type FaultPlan = (call: number, request: ChatRequest) => Error | undefined;

/** 包一层模型，按计划注入故障。calls 记着一共调用了几次（包括失败的） */
export function faultyModel(model: Model, plan: FaultPlan, name = model.name): Model & { readonly calls: number } {
  let calls = 0;
  return {
    name,
    get calls() {
      return calls;
    },
    async chat(request: ChatRequest, options?: ChatOptions) {
      calls++;
      const error = plan(calls, request);
      if (error) throw error;
      return model.chat(request, options);
    },
  };
}

/** 常见的几种错误，和真实接口返回的一样，第 9 天的 classifyError 能认出来 */
export const faults = {
  rateLimit: () => new ModelError(429, '模型调用失败（429）：请求太频繁', { headers: new Headers({ 'retry-after': '1' }) }),
  overloaded: () => new ModelError(503, '模型调用失败（503）：服务过载'),
  quota: () => new ModelError(402, '模型调用失败（402）：余额不足'),
  badRequest: () => new ModelError(400, '模型调用失败（400）：参数不对'),
};

/** 第几次调用失败 */
export function failOn(calls: number[], make: () => Error = faults.overloaded): FaultPlan {
  return (call) => (calls.includes(call) ? make() : undefined);
}

/** 一直失败：模拟一家服务彻底挂了 */
export function failAlways(make: () => Error = faults.overloaded): FaultPlan {
  return () => make();
}

/** 按比例随机失败。random 换成固定的序列，结果就可以复现 */
export function failRate(rate: number, make: () => Error = faults.overloaded, random = Math.random): FaultPlan {
  return () => (random() < rate ? make() : undefined);
}

/** 包一层模型，每次调用前先等一会儿：模拟服务变慢。等待也会被 signal 打断 */
export function slowModel(model: Model, delayMs: number): Model {
  return {
    name: model.name,
    async chat(request, options) {
      const { setTimeout: sleep } = await import('node:timers/promises');
      await sleep(delayMs, undefined, { signal: options?.signal });
      return model.chat(request, options);
    },
  };
}
