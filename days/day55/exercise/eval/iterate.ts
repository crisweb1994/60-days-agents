// 第 55 天：迭代的记录。每跑一轮评估，记下改了什么、prompt 的指纹、分数、哪些过了哪些没过（JSONL，一行一轮）。
//   和上一轮比：分数涨了多少、有没有把原来能过的改坏（回归）
//   和成功标准比（第 51 天）：达标了就停，不要无止境地调
//   开发集和测试集比：开发集涨了、测试集没涨，就是在对着考卷调（过拟合）
// 第 55 天的练习：TODO 3、4 在这里。检查：npm run check 55
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Spec } from '../spec.ts';
import type { Scores } from './score.ts';

export interface Iteration {
  /** 第几轮：it-001、it-002…… */
  id: string;
  at: string;
  /** 这一轮改了什么，一句话 */
  change: string;
  /** prompt 的指纹：同一个指纹，说明 prompt 没变 */
  promptVersion: string;
  split: 'dev' | 'test' | 'all';
  scores: Scores;
  passedIds: string[];
  failedIds: string[];
}

/** 几段 prompt 合起来的 sha256 前 8 位 */
export function promptFingerprint(texts: string[]): string {
  return createHash('sha256').update(texts.join('\n---\n')).digest('hex').slice(0, 8);
}

export async function readIterations(file: string): Promise<Iteration[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Iteration);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 追加一轮，编号自动加一 */
export async function appendIteration(file: string, iteration: Omit<Iteration, 'id'>): Promise<Iteration> {
  const existing = await readIterations(file);
  const full: Iteration = { id: `it-${String(existing.length + 1).padStart(3, '0')}`, ...iteration };
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(full)}\n`);
  return full;
}

/** 越大越好的分数，和越小越好的分数 */
export const HIGHER_IS_BETTER = ['passRate', 'recall', 'precision', 'f1', 'summaryCoverage'] as const;
export const LOWER_IS_BETTER = ['falseAlarms', 'injected'] as const;
type Key = (typeof HIGHER_IS_BETTER)[number] | (typeof LOWER_IS_BETTER)[number];

export interface Comparison {
  /** 每个分数的变化：后一轮减前一轮 */
  deltas: Record<Key, number>;
  /** 前一轮过了、这一轮没过的用例（两轮都跑了的才算） */
  regressions: string[];
  /** 前一轮没过、这一轮过了的 */
  fixed: string[];
  verdict: '更好' | '更差' | '有得有失' | '没有变化';
}

/** 变化小于这个数当作没变（浮点误差、一两条用例的抖动另说） */
export const EPSILON = 0.001;

/**
 * 比较两轮（TODO 3）：
 * - deltas：HIGHER_IS_BETTER 和 LOWER_IS_BETTER 里每个分数，next − prev
 * - regressions：prev.passedIds 里、又在 next.failedIds 里的；fixed 反过来。都按 next 里的顺序
 * - verdict：「变好」是越大越好的涨了超过 EPSILON、或者越小越好的降了超过 EPSILON、或者有 fixed；
 *   「变差」反过来，有 regressions 也算变差。两样都有是「有得有失」，都没有是「没有变化」
 */
export function compareIterations(prev: Iteration, next: Iteration): Comparison {
  // TODO 3：先算 deltas（Object.fromEntries 把两组 key 映射成 next − prev）；再算 regressions 和 fixed；最后按注释判断 verdict
  void EPSILON; void prev; void next;
  throw new Error('TODO 3：还没有实现 compareIterations');
}

/** 需求说明里成功标准的编号 → 分数的名字。你的项目按自己的成功标准改这张表 */
export const CRITERIA_KEYS: Record<string, keyof Scores> = {
  recall: 'recall',
  precision: 'precision',
  'false-alarms': 'falseAlarms',
  'summary-coverage': 'summaryCoverage',
  injection: 'injected',
};

export interface CriterionCheck {
  id: string;
  /** 「问题召回率 ≥ 70%」 */
  target: string;
  /** 换算成和目标同样的单位以后的实际值；没有对应的分数是 null */
  actual: number | null;
  /** 没有对应的分数是 null */
  met: boolean | null;
}

/**
 * 对照成功标准（TODO 4）：每条标准用 CRITERIA_KEYS 找到分数。unit 是 % 的，分数乘以 100 再比（保留到小数点后 1 位）；
 * at-least 是 ≥ target，at-most 是 ≤ target。找不到对应分数的，actual 和 met 都是 null。
 * target 写成「metric ≥ 70%」这样（用 spec.ts 的 describeCriterion）
 */
export function checkCriteria(criteria: Spec['criteria'], scores: Scores, describe: (c: Spec['criteria'][number]) => string): CriterionCheck[] {
  // TODO 4：每条标准：CRITERIA_KEYS 找到分数的名字，取出数字（不是数字就是找不到）；
  // unit 是 % 的乘以 100 再保留一位小数（Math.round(x * 1000) / 10）；按 direction 比较
  void CRITERIA_KEYS; void scores; void describe;
  return criteria.map((c) => ({ id: c.id, target: '', actual: null, met: null }));
}

/**
 * 过拟合的信号：开发集比测试集高出 threshold（默认 0.1）以上的分数。
 * 只看越大越好的那几个；测试集的用例少，差几个百分点很正常，差十几个点就要警惕
 */
export function overfitGaps(dev: Scores, test: Scores, threshold = 0.1): { key: string; dev: number; test: number }[] {
  return HIGHER_IS_BETTER.filter((k) => dev[k] - test[k] > threshold).map((k) => ({ key: k, dev: dev[k], test: test[k] }));
}
