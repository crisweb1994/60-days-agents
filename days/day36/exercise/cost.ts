// 第 36 天：成本与延迟。先算清楚钱花在哪、时间花在哪，再动手省。
//   预算：给一个任务、一个用户设上限，超了就不再调用模型（withBudget）
//   成本分解：按步骤看每一步花了多少、占多少（costBreakdown）；缓存省了多少（cacheSavings）
//   延迟：每次调用多久出第一个字（首字延迟）、一共多久（measureLatency）
// 省钱的手段（换便宜的模型、压缩工具输出、批处理）都要回到第 33 天的评估：分数不降，省的才算数。
// 第 36 天的练习：TODO 1–4 在这里，TODO 5 在 batch.ts。检查：npm run check 36
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
    // TODO 1（一）：用 calcCost 算出这笔钱加到 spent 上；有上级的话，让上级也 charge 一次（它会再记给它的上级）
    charge(usage) {
      void usage;
      void parent;
    },
    // TODO 1（二）：从自己开始，沿着 parent 一级级往上：已经花的 + estimate 超过 limit，
    // 就抛出 new BudgetExceededError(那一级的 name, 那一级花了多少, 那一级的 limit, estimate)
    check(estimate = 0) {
      void estimate;
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
      // TODO 2：先用 estimateRequest(request, expectedOutput) 估出用量，calcCost 换成钱，budget.check 一下（超了会抛出）；
      // 再调用模型，按 result.usage 记账（budget.charge）
      void expectedOutput;
      return model.chat(request, options);
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
  // TODO 3（一）：每一步算出 cost（calcCost），再算 share（占总花费的比例，总花费为 0 时是 0），按 cost 从多到少排
  void steps;
  void price;
  return [];
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
  // TODO 3（二）：actual 按实际的用量算；withoutCache 把 cachedTokens 当成 0 再算（全按原价）；
  // saved 是两者之差；hitRate 是命中缓存的输入占全部输入的比例（没有输入时是 0）
  void usages;
  void price;
  return { actual: 0, withoutCache: 0, saved: 0, hitRate: 0 };
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
      // TODO 4：记下开始的 clock()；把 onText 和 onReasoning 都换成一个包装：第一次被调用时记下 clock()，再转给调用方原来的回调。
      // 调用完 push 一条 { ms, ttftMs }：ttftMs 是第一个字的时间减去开始的时间；一个字都没收到就不要这个字段
      void clock;
      return model.chat(request, options);
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
