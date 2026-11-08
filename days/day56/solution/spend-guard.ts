// 第 56 天：整个产品的花费上限。第 36 天的预算管一次任务，第 46 天的配额管一个用户；这里管的是**你的钱包**：
//   一个月最多花多少、一天最多花多少。到了 80% 降级成便宜的模型，到了 100% 停下来不再调用模型。
//   为什么要有：一个几千行的 PR、一个死循环、一个刷接口的人，都能在一夜之间花掉一个月的预算；模型服务的账单不会替你停
// 花了多少存在一个 JSON 文件里，重启以后还在。多台机器时换成 Redis 的 INCRBYFLOAT（第 45 天）。
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
  const { daily, monthly, degradeAt = 0.8 } = limits;
  const keys = () => {
    const iso = now().toISOString();
    return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
  };
  let state: Stored;
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as Stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { ...keys(), daySpent: 0, monthSpent: 0 } as Stored;
  }
  const roll = () => {
    const k = keys();
    if (state.day !== k.day) state = { ...state, day: k.day, daySpent: 0 };
    if (state.month !== k.month) state = { ...state, month: k.month, monthSpent: 0 };
  };
  let writes = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(state);
    writes = writes.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    });
    return writes;
  };
  return {
    status() {
      roll();
      const ratio = Math.max(state.daySpent / daily, state.monthSpent / monthly);
      const mode: SpendMode = ratio >= 1 ? 'stopped' : ratio >= degradeAt ? 'degraded' : 'normal';
      return { mode, day: { key: state.day, spent: state.daySpent, limit: daily }, month: { key: state.month, spent: state.monthSpent, limit: monthly } };
    },
    async record(cost) {
      roll();
      state = { ...state, daySpent: state.daySpent + cost, monthSpent: state.monthSpent + cost };
      await save();
    },
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
  return {
    name: `guarded:${models.primary.name}`,
    async chat(request: ChatRequest, options?: ChatOptions) {
      const status = guard.status();
      if (status.mode === 'stopped') throw new SpendLimitError(status);
      const which = status.mode === 'degraded' ? 'cheap' : 'primary';
      const result = await models[which].chat(request, options);
      await guard.record(calcCost(result.usage, prices[which]));
      return result;
    },
  };
}
