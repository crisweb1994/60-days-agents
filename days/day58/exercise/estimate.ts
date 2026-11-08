// 第 58 天：系统设计题里的估算。Agent 系统的设计题，估算比画框图更能拉开差距：
//   峰值有多少任务、同时在跑多少个（利特尔法则）、模型服务的限流（RPM、TPM）够不够、要多少 worker、一个月多少钱、一次多久
// 数字不用精确，量级对、假设写清楚就行。这些函数把常用的几笔算术写死，算错的机会少一点。
// 第 58 天的练习：TODO 1–3 在这里。检查：npm run check 58

export interface Load {
  /** 每天多少个任务 */
  perDay: number;
  /** 任务集中在一天里的几个小时，默认 8（工作时间） */
  activeHours?: number;
  /** 峰值是平均的几倍，默认 3 */
  peakFactor?: number;
}

/**
 * 峰值每秒多少个任务（TODO 1（一））：perDay ÷ (activeHours × 3600) × peakFactor
 */
export function peakRate({ perDay, activeHours = 8, peakFactor = 3 }: Load): number {
  // TODO 1（一）：一天的任务平均摊到 activeHours 个小时里，再乘以峰值倍数
  void perDay; void activeHours; void peakFactor;
  return 0;
}

/**
 * 同时在跑多少个任务（TODO 1（二））：利特尔法则 L = λ × W，到达率（每秒几个）乘以每个任务平均耗时（秒）
 */
export function concurrency(perSecond: number, avgSeconds: number): number {
  // TODO 1（二）：L = λ × W
  void perSecond; void avgSeconds;
  return 0;
}

export interface CapacityInput extends Load {
  /** 一个任务平均跑多久，秒 */
  avgSeconds: number;
  /** 一个任务调用几次模型 */
  callsPerTask: number;
  /** 一个任务用多少 token（输入加输出） */
  tokensPerTask: number;
  /** 一个 API Key（账号）的限流 */
  limits: { rpm: number; tpm: number };
  /** 一个 worker 同时跑几个任务 */
  perWorker: number;
  /** 限流只用到多少比例，留余量，默认 0.7 */
  headroom?: number;
}

export interface CapacityPlan {
  peakPerSecond: number;
  /** 峰值时同时在跑的任务 */
  concurrentTasks: number;
  /** 峰值时每分钟的模型调用、token */
  rpm: number;
  tpm: number;
  /** 占一个 Key 的限流的比例 */
  rpmUsage: number;
  tpmUsage: number;
  /** 要几个 Key（或者找模型服务提额到几倍）：留够余量 */
  keysNeeded: number;
  /** 要几个 worker */
  workers: number;
  /** 先撞上的是哪一个限制 */
  bottleneck: 'rpm' | 'tpm';
}

/**
 * 容量规划（TODO 2）：
 * - peakPerSecond 用 peakRate；concurrentTasks 用 concurrency(峰值, avgSeconds)
 * - rpm = 峰值 × 60 × callsPerTask；tpm = 峰值 × 60 × tokensPerTask
 * - rpmUsage = rpm ÷ limits.rpm；tpmUsage 同理；bottleneck 是两个里比例大的那个（一样大算 tpm）
 * - keysNeeded = 向上取整(较大的比例 ÷ headroom)，至少 1
 * - workers = 向上取整(concurrentTasks ÷ perWorker)，至少 1
 */
export function capacityPlan(input: CapacityInput): CapacityPlan {
  // TODO 2：按上面注释一项项算。向上取整用 Math.ceil，「至少 1」用 Math.max(1, …)
  void input;
  throw new Error('TODO 2：还没有实现 capacityPlan');
}

/** 一个月的花费：每天的任务数 × 每个任务的花费 × 天数（默认 30） */
export function monthlyCost(perDay: number, costPerTask: number, days = 30): number {
  return perDay * costPerTask * days;
}

/** 一步：按顺序做的一件事，或者同时做的几件事 */
export type Step = { name: string; ms: number } | { parallel: { name: string; ms: number }[] };

/**
 * 一次任务多久（TODO 3）：按顺序的步骤加起来；parallel 的那一步取里面最慢的（空的算 0）。
 * critical 是关键路径：按顺序的步骤的名字，parallel 的那一步是最慢那个的名字（一样慢取前面的；空的不列）。
 * 想缩短延迟，只有缩短关键路径上的步骤才有用
 */
export function latency(steps: Step[]): { totalMs: number; critical: string[] } {
  // TODO 3：一步步加；'parallel' in step 判断是不是并行的一步，用 reduce 找最慢的（只有更慢才换，一样慢留前面的）
  void steps;
  return { totalMs: 0, critical: [] };
}

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n.toPrecision(3)).toString());

/** 给人看的容量规划，贴进设计题的答案 */
export function renderPlan(plan: CapacityPlan): string {
  return [
    `峰值 ${fmt(plan.peakPerSecond)} 个任务/秒，同时在跑 ${fmt(plan.concurrentTasks)} 个`,
    `峰值每分钟 ${fmt(plan.rpm)} 次调用（一个 Key 的 ${(plan.rpmUsage * 100).toFixed(0)}%）、${fmt(plan.tpm)} 个 token（${(plan.tpmUsage * 100).toFixed(0)}%）`,
    `先撞上 ${plan.bottleneck.toUpperCase()}：要 ${plan.keysNeeded} 个 Key 的额度，${plan.workers} 个 worker`,
  ].join('\n');
}
