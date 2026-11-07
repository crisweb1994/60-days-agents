// 第 35 天：故障转移。第 9 天的重试是「同一家，等一会儿再试」；故障转移是「这家不行，换一家」。
// 一家服务连续出问题时，不要每次都先撞它一下再换：给它一段冷却时间，冷却期间直接跳过。
// 冷却是递增的：第一次 30 秒，再出错 1 分钟、2 分钟……成功一次就清零。一家服务偶尔抖一下，很快就回来；真的挂了，就别反复去试。
// 模型（Model）和搜索（SearchProvider）都能这样做：几家搜索服务之间切换，和几家模型之间切换，是同一个问题。
import { classifyError, type ErrorKind } from './retry.ts';
import type { SearchProvider } from './search.ts';
import type { ChatOptions, ChatRequest, ChatResult, Model } from './types.ts';

export interface CooldownOptions {
  /** 第一次出错以后冷却多久，默认 30 秒 */
  baseMs?: number;
  /** 冷却最长多久，默认 10 分钟 */
  maxMs?: number;
  /** 当前时间（毫秒），测试时换成假的 */
  now?: () => number;
}

export interface Cooldowns {
  /** 记一次失败。返回这次的冷却时间 */
  fail(key: string): number;
  /** 记一次成功：失败次数清零，不再冷却 */
  succeed(key: string): void;
  /** 现在能不能用：不在冷却中 */
  available(key: string): boolean;
  /** 还要冷却多久，不在冷却中是 0 */
  remaining(key: string): number;
  /** 连续失败了几次 */
  failures(key: string): number;
}

/**
 * 递增的冷却：连续第 n 次失败，冷却 baseMs × 2^(n-1)，最多 maxMs。成功一次就清零
 */
export function createCooldowns({ baseMs = 30_000, maxMs = 600_000, now = () => Date.now() }: CooldownOptions = {}): Cooldowns {
  const state = new Map<string, { failures: number; until: number }>();
  const remaining = (key: string) => Math.max(0, (state.get(key)?.until ?? 0) - now());
  return {
    fail(key) {
      const failures = (state.get(key)?.failures ?? 0) + 1;
      const ms = Math.min(maxMs, baseMs * 2 ** (failures - 1));
      state.set(key, { failures, until: now() + ms });
      return ms;
    },
    succeed: (key) => void state.delete(key),
    available: (key) => remaining(key) === 0,
    remaining,
    failures: (key) => state.get(key)?.failures ?? 0,
  };
}

/** 换一家能解决的错误：这家限流了、挂了、超时了、网断了、没钱了、Key 失效了。请求本身有问题、输入太长、用户取消，换一家也没用 */
export const FAILOVER_KINDS: ReadonlySet<ErrorKind> = new Set(['rate_limit', 'server', 'timeout', 'network', 'quota', 'auth']);

export interface Attempt {
  name: string;
  error: unknown;
  kind: ErrorKind;
}

/** 所有候选都试过了，都不行 */
export class AllFailedError extends Error {
  readonly attempts: Attempt[];
  constructor(attempts: Attempt[]) {
    super(`都失败了：${attempts.map((a) => `${a.name}（${a.kind}：${a.error instanceof Error ? a.error.message : String(a.error)}）`).join('；')}`);
    this.name = 'AllFailedError';
    this.attempts = attempts;
  }
}

export interface FailoverOptions {
  cooldowns?: Cooldowns;
  /** 这个错误换一家能不能解决。默认看 classifyError 的种类在不在 FAILOVER_KINDS 里 */
  shouldFailover?: (error: unknown) => boolean;
  /** 换到下一家时回调，用来告诉用户、记进 trace */
  onFailover?: (info: { from: string; to?: string; error: unknown; cooldownMs: number }) => void;
}

/**
 * 按顺序试几个候选，返回第一个成功的结果：
 * - 先排出要试的顺序：不在冷却中的，按原来的顺序；都在冷却中，就按冷却剩得最少的先试（总比直接报错好）
 * - 成功：cooldowns.succeed，返回结果
 * - 用户取消了（signal.aborted）：直接抛出，不换
 * - shouldFailover 说换一家也没用：直接抛出
 * - 否则：cooldowns.fail，onFailover（to 是下一个候选的名字，没有了就是 undefined），试下一个
 * - 都失败了：抛出 AllFailedError，带着每一次的错误
 */
export async function runWithFailover<T extends { name: string }, R>(
  candidates: T[],
  fn: (candidate: T) => Promise<R>,
  options: FailoverOptions & { signal?: AbortSignal } = {},
): Promise<R> {
  const { cooldowns = createCooldowns(), shouldFailover = (e) => FAILOVER_KINDS.has(classifyError(e).kind), onFailover, signal } = options;
  const ready = candidates.filter((c) => cooldowns.available(c.name));
  const order = ready.length ? ready : [...candidates].sort((a, b) => cooldowns.remaining(a.name) - cooldowns.remaining(b.name));
  const attempts: Attempt[] = [];
  for (let i = 0; i < order.length; i++) {
    const candidate = order[i];
    try {
      const result = await fn(candidate);
      cooldowns.succeed(candidate.name);
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!shouldFailover(error)) throw error;
      const cooldownMs = cooldowns.fail(candidate.name);
      attempts.push({ name: candidate.name, error, kind: classifyError(error).kind });
      onFailover?.({ from: candidate.name, to: order[i + 1]?.name, error, cooldownMs });
    }
  }
  throw new AllFailedError(attempts);
}

/**
 * 几个模型组成一条降级链：第一个是首选，后面的依次是备用。返回的还是一个 Model。
 * 流式输出时要小心：已经把一部分文字显示给用户了，再换一个模型从头生成，用户会看到两段不一样的开头。
 * 所以已经输出过文字（onText、onReasoning 被调用过）以后出错，不再换，直接抛出
 */
export function withFailover(models: Model[], options: FailoverOptions = {}): Model {
  if (!models.length) throw new Error('至少要有一个模型');
  const cooldowns = options.cooldowns ?? createCooldowns();
  return {
    name: `failover(${models.map((m) => m.name).join(', ')})`,
    chat(request: ChatRequest, chatOptions: ChatOptions = {}): Promise<ChatResult> {
      let partial = false;
      const track = (callback?: (text: string) => void) =>
        callback &&
        ((text: string) => {
          partial = true;
          callback(text);
        });
      const tracked: ChatOptions = { ...chatOptions, onText: track(chatOptions.onText), onReasoning: track(chatOptions.onReasoning) };
      return runWithFailover(models, (model) => model.chat(request, tracked), {
        ...options,
        cooldowns,
        signal: chatOptions.signal,
        shouldFailover: (error) => !partial && (options.shouldFailover ?? ((e) => FAILOVER_KINDS.has(classifyError(e).kind)))(error),
      });
    },
  };
}

/**
 * 几家搜索服务组成一条降级链。搜索服务的错误都是普通的 Error（第 12 天），分不出种类，
 * 所以除了用户取消，出什么错都换下一家
 */
export function withSearchFailover(providers: SearchProvider[], options: FailoverOptions = {}): SearchProvider {
  if (!providers.length) throw new Error('至少要有一个搜索服务');
  const cooldowns = options.cooldowns ?? createCooldowns();
  return {
    name: providers.map((p) => p.name).join('>'),
    search(query, searchOptions = {}) {
      return runWithFailover(providers, (p) => p.search(query, searchOptions), { shouldFailover: () => true, ...options, cooldowns, signal: searchOptions.signal });
    },
  };
}
