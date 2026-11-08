// 第 56 天：整个产品的花费上限。第 36 天的预算管一次任务，第 46 天的配额管一个用户；这里管的是**你的钱包**：
//   一个月最多花多少、一天最多花多少。到了 80% 降级成便宜的模型，到了 100% 停下来不再调用模型。
//   为什么要有：一个几千行的 PR、一个死循环、一个刷接口的人，都能在一夜之间花掉一个月的预算；模型服务的账单不会替你停
// 花了多少存在一个 JSON 文件里，重启以后还在。多台机器时换成 Redis 的 INCRBYFLOAT（第 45 天）。
// 第 56 天的练习：TODO 3、4 在这里。检查：npm run check 56
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatOptions, ChatRequest, Model } from './core/types.ts';
import { calcCost, type Price } from './core/usage.ts';

export interface SpendLimits {
  /** 一天最多花多少（元） */
  daily: number;
  /** 一个月最多花多少（元） */
  monthly: number;
  /** 用到多少比例开始降级，默认 0.8 */
  degradeAt?: number;
}

export type SpendMode = 'normal' | 'degraded' | 'stopped';

export interface SpendStatus {
  mode: SpendMode;
  day: { key: string; spent: number; limit: number };
  month: { key: string; spent: number; limit: number };
}

export interface SpendGuard {
  status(): SpendStatus;
  /** 记一笔花费，马上写回文件 */
  record(cost: number): Promise<void>;
}

interface Stored {
  day: string;
  daySpent: number;
  month: string;
  monthSpent: number;
}

/**
 * 打开花费记录（TODO 3）。文件不存在就从 0 开始。
 * - 日期用 UTC：day 是「YYYY-MM-DD」，month 是「YYYY-MM」
 * - 每次 status 和 record 之前，先看日期变了没有：换了一天，当天的清零；换了一个月，当月的清零
 * - mode：当天和当月的「已花 / 上限」取大的那个，≥ 1 是 stopped，≥ degradeAt 是 degraded，否则 normal
 * - record：加到当天和当月上，写回文件（先写 .tmp 再改名，第 35 天）。几笔同时记，要排队写，不能丢
 */
export async function openSpendGuard(file: string, limits: SpendLimits, now: () => Date = () => new Date()): Promise<SpendGuard> {
  // TODO 3：
  // 1. 读文件（不存在就从 0 开始），记住 { day, daySpent, month, monthSpent }
  // 2. 写一个 roll()：用 now().toISOString() 取出今天和这个月，和记着的不一样就清零
  // 3. status()：先 roll()，算 mode；record(cost)：先 roll()，加上 cost，写回文件（.tmp 再 rename；用一条 Promise 链排队写）
  void mkdir; void readFile; void rename; void writeFile; void dirname; void file; void now;
  const { daily, monthly } = limits;
  return {
    status: () => ({ mode: 'normal', day: { key: '', spent: 0, limit: daily }, month: { key: '', spent: 0, limit: monthly } }),
    record: async () => {},
  };
}

export class SpendLimitError extends Error {
  constructor(status: SpendStatus) {
    super(`花费到了上限（今天 ${status.day.spent.toFixed(2)}/${status.day.limit} 元，本月 ${status.month.spent.toFixed(2)}/${status.month.limit} 元），暂停调用模型`);
    this.name = 'SpendLimitError';
  }
}

/**
 * 带花费上限的模型（TODO 4）。实现 Model 接口，每次 chat：
 * - stopped：不调用，抛出 SpendLimitError
 * - degraded：用 cheap；normal：用 primary
 * - 调用以后按用的那个模型的单价（prices.primary 或 prices.cheap）算成本，记进 guard，再返回结果
 * name 是「guarded:primary 的名字」
 */
export function guardedModel(models: { primary: Model; cheap: Model }, prices: { primary: Price; cheap: Price }, guard: SpendGuard): Model {
  // TODO 4：返回一个 Model：name 是 guarded: 加上 primary 的名字；chat 里先看 guard.status()，
  // stopped 抛 SpendLimitError，degraded 用 cheap，否则用 primary；调用完用 calcCost(result.usage, 对应的单价) 记账
  void calcCost; void SpendLimitError; void prices; void guard;
  return { name: `guarded:${models.primary.name}`, chat: (request: ChatRequest, options?: ChatOptions) => models.primary.chat(request, options) };
}
