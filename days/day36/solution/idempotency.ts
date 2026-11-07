// 第 35 天：幂等。重试、恢复、检查点都意味着「同一件事可能做两次」。只读的工具做两次无所谓，
// 写文件、发请求、付款做两次就是事故。幂等的意思是：同样的请求做一次和做多次，效果一样。
// 办法是给每个有副作用的调用一个幂等键：同一个键已经成功执行过，就直接返回上次的结果，不再执行。
import { riskOf } from './permissions.ts';
import type { Tool } from './tool.ts';

/** 存执行过的结果。默认存在内存里；要跨进程（恢复以后也算数），换成存在文件或数据库里的实现 */
export interface IdempotencyStore {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string): void | Promise<void>;
}

export function memoryIdempotencyStore(): IdempotencyStore & { readonly size: number } {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v), get size() { return map.size; } };
}

/** 默认的幂等键：工具名加上参数（键按字母排序，免得顺序不同算成两个） */
export function defaultKey(tool: string, input: unknown): string {
  const sorted = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
      : value;
  return `${tool}:${JSON.stringify(sorted(input))}`;
}

/**
 * 给有副作用的工具（风险不是 read 的）加上幂等：同样的键成功执行过，就返回上次的结果，前面加上「（这个操作已经执行过，没有重复执行）」。
 * 只记成功的结果：失败了下次还要能再试。只读的工具原样返回，不用记
 */
export function idempotent(tools: Tool[], store: IdempotencyStore = memoryIdempotencyStore(), keyOf = defaultKey): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(input, context) {
      if (riskOf(tool, input) === 'read') return tool.execute(input, context);
      const key = keyOf(tool.name, input);
      const done = await store.get(key);
      if (done !== undefined) return `（这个操作已经执行过，没有重复执行）\n${done}`;
      const output = await tool.execute(input, context);
      await store.set(key, typeof output === 'string' ? output : JSON.stringify(output ?? '执行完成'));
      return output;
    },
  }));
}
