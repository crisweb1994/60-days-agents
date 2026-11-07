// 第 36 天：成本与延迟。先算清楚钱花在哪、时间花在哪，再动手省。
//   预算：给一个任务、一个用户设上限，超了就不再调用模型（withBudget）
//   成本分解：按步骤看每一步花了多少、占多少（costBreakdown）；缓存省了多少（cacheSavings）
//   延迟：每次调用多久出第一个字（首字延迟）、一共多久（measureLatency）
// 省钱的手段（换便宜的模型、压缩工具输出、批处理）都要回到第 33 天的评估：分数不降，省的才算数。
import { messageTokens, toolTokens } from './context.ts';
import { percentile } from './eval/regression.ts';
import type { ChatOptions, ChatRequest, ChatResult, Model } from './types.ts';
import { calcCost, emptyUsage, type Price, type Usage } from './usage.ts';

// ---------- 预算 ----------

/** 预算用完了。不是模型的错误，不会被重试，也不会触发故障转移 */
export class BudgetExceededError extends Error {
  readonly budget: string;
  readonly spent: number;
  readonly limit: number;
  constructor(budget: string, spent: number, limit: number, estimate = 0) {
    const tail = estimate ? `，这次调用估计还要 ${estimate.toFixed(4)} 元` : '';
    super(`${budget}的预算不够了：已经花了 ${spent.toFixed(4)} 元，上限 ${limit.toFixed(4)} 元${tail}`);
    this.name = 'BudgetExceededError';
    this.budget = budget;
    this.spent = spent;
    this.limit = limit;
  }
}

export interface Budget {
  /** 给人看的名字，比如「这次研究」「用户 u1 今天」 */
  readonly name: string;
  /** 上限，单位元 */
  readonly limit: number;
  readonly price: Price;
  /** 上一级的预算：任务的预算花掉的钱，也算在用户的预算里 */
  readonly parent?: Budget;
  spent(): number;
  remaining(): number;
  /** 记下一次调用的用量：自己和每一级上级都加上这笔钱 */
  charge(usage: Usage): void;
  /** 再花 estimate 元会不会超：自己或者任何一级上级会超，就抛出 BudgetExceededError（说的是超了的那一级） */
  check(estimate?: number): void;
}

export function createBudget({ name, limit, price, parent }: { name: string; limit: number; price: Price; parent?: Budget }): Budget {
  let spent = 0;
  const budget: Budget = {
    name,
    limit,
    price,
    parent,
    spent: () => spent,
    remaining: () => Math.max(0, limit - spent),
    charge(usage) {
      spent += calcCost(usage, price);
      parent?.charge(usage); // 上级再记给它的上级
    },
    check(estimate = 0) {
      for (let b: Budget | undefined = budget; b; b = b.parent) {
        if (b.spent() + estimate > b.limit + 1e-12) throw new BudgetExceededError(b.name, b.spent(), b.limit, estimate);
      }
    },
  };
  return budget;
}

/** 一次请求大概要多少 token：消息加上工具定义（第 15 天的估算），输出按 expectedOutput 算 */
export function estimateRequest(request: ChatRequest, expectedOutput = 500): Usage {
  const input = request.messages.reduce((sum, m) => sum + messageTokens(m), 0) + toolTokens(request.tools ?? []);
  return { ...emptyUsage(), inputTokens: input, outputTokens: expectedOutput };
}

/**
 * 包一层模型：调用之前先估一下这次要花多少钱，预算不够就不调用，抛出 BudgetExceededError；
 * 调用之后按实际的用量记账。expectedOutput 是估算时假设的输出 token 数
 */
export function withBudget(model: Model, budget: Budget, { expectedOutput = 500 }: { expectedOutput?: number } = {}): Model {
  return {
    name: model.name,
    async chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult> {
      budget.check(calcCost(estimateRequest(request, expectedOutput), budget.price));
      const result = await model.chat(request, options);
      budget.charge(result.usage);
      return result;
    },
  };
}

export interface LedgerOptions {
  price: Price;
  /** 每个用户每天最多花多少元 */
  perUserDaily: number;
  /** 每个任务最多花多少元 */
  perTask: number;
  now?: () => Date;
}

/** 按用户、按天记账：同一个用户同一天的任务共用一个上级预算。存在内存里，第 45 天起要存进数据库 */
export function createLedger({ price, perUserDaily, perTask, now = () => new Date() }: LedgerOptions) {
  const users = new Map<string, Budget>();
  return {
    /** 给一个新任务开一个预算，它的上级是这个用户今天的预算 */
    taskBudget(userId: string): Budget {
      const day = now().toISOString().slice(0, 10);
      const key = `${userId}:${day}`;
      let user = users.get(key);
      if (!user) users.set(key, (user = createBudget({ name: `用户 ${userId} 今天`, limit: perUserDaily, price })));
      return createBudget({ name: '这个任务', limit: perTask, price, parent: user });
    },
    /** 这个用户今天花了多少 */
    spentToday(userId: string): number {
      return users.get(`${userId}:${now().toISOString().slice(0, 10)}`)?.spent() ?? 0;
    },
  };
}

// ---------- 成本分解 ----------

export interface CostRow {
  step: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** 占总花费的比例，0 到 1 */
  share: number;
}

/** 每一步花了多少、占多少，按花费从多到少。总花费是 0 时，share 都是 0 */
export function costBreakdown(steps: Record<string, Usage>, price: Price): CostRow[] {
  const rows = Object.entries(steps).map(([step, usage]) => ({ step, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: calcCost(usage, price) }));
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  return rows.map((r) => ({ ...r, share: total ? r.cost / total : 0 })).sort((a, b) => b.cost - a.cost);
}

export function formatCostBreakdown(rows: CostRow[]): string {
  const lines = rows.map((r) => `| ${r.step} | ${r.inputTokens} | ${r.outputTokens} | ${r.cost.toFixed(4)} 元 | ${Math.round(r.share * 100)}% |`);
  return ['| 步骤 | 输入 tokens | 输出 tokens | 花费 | 占比 |', '|---|---|---|---|---|', ...lines].join('\n');
}

export interface CacheSavings {
  /** 实际花了多少 */
  actual: number;
  /** 如果一点缓存都没命中，要花多少 */
  withoutCache: number;
  saved: number;
  /** 命中缓存的输入占全部输入的比例 */
  hitRate: number;
}

/** 缓存省了多少钱：实际的花费，和把命中缓存的部分也按原价算的花费比较 */
export function cacheSavings(usages: Usage[], price: Price): CacheSavings {
  const actual = usages.reduce((sum, u) => sum + calcCost(u, price), 0);
  const withoutCache = usages.reduce((sum, u) => sum + calcCost({ ...u, cachedTokens: 0 }, price), 0);
  const input = usages.reduce((sum, u) => sum + u.inputTokens, 0);
  const cached = usages.reduce((sum, u) => sum + u.cachedTokens, 0);
  return { actual, withoutCache, saved: withoutCache - actual, hitRate: input ? cached / input : 0 };
}

// ---------- 延迟 ----------

export interface LatencyRecord {
  /** 整次调用的耗时 */
  ms: number;
  /** 首字延迟：从发出请求到收到第一个字（文字或者思考）。只调用了工具、没有输出文字时没有 */
  ttftMs?: number;
}

/**
 * 包一层模型，记下每次调用的耗时和首字延迟。调用方没有传 onText，也要包一个进去：
 * 课程的模型总是用流式（第 3 天），传不传 onText，第一个字到达的时间都一样
 */
export function measureLatency(model: Model, clock: () => number = () => performance.now()): Model & { readonly records: LatencyRecord[] } {
  const records: LatencyRecord[] = [];
  return {
    name: model.name,
    records,
    async chat(request: ChatRequest, options: ChatOptions = {}) {
      const start = clock();
      let first: number | undefined;
      const mark = (callback?: (text: string) => void) => (text: string) => {
        first ??= clock();
        callback?.(text);
      };
      const result = await model.chat(request, { ...options, onText: mark(options.onText), onReasoning: mark(options.onReasoning) });
      records.push({ ms: clock() - start, ...(first === undefined ? {} : { ttftMs: first - start }) });
      return result;
    },
  };
}

export interface LatencyStats {
  calls: number;
  p50: number;
  p90: number;
  /** 首字延迟的中位数和 P90，只算有首字的调用 */
  ttftP50?: number;
  ttftP90?: number;
}

export function latencyStats(records: LatencyRecord[]): LatencyStats {
  const ttft = records.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs]));
  const ms = records.map((r) => r.ms);
  return {
    calls: records.length,
    p50: percentile(ms, 50),
    p90: percentile(ms, 90),
    ...(ttft.length ? { ttftP50: percentile(ttft, 50), ttftP90: percentile(ttft, 90) } : {}),
  };
}
