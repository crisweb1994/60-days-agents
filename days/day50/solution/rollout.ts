// 第 49 天：灰度发布和 A/B 测试。新的一版 prompt（或者新的模型）先给一小部分用户用，看指标没问题再全量。
//   分桶：用户编号加上实验名算哈希，取 0–99 的一个桶。同一个用户在同一个实验里永远进同一个桶（体验一致、统计不乱），
//        不同的实验分桶互相独立（实验名不同，哈希就不同）
//   比较：两组的「好评率」（或者成功率）差得多不多？样本少的时候差一点很正常，要做显著性检验，样本量也要够
import { createHash } from 'node:crypto';

/** 用户在这个实验里的桶，0–99 */
export function bucket(userId: string, experiment: string): number {
  const hash = createHash('sha256').update(`${experiment}:${userId}`).digest();
  return hash.readUInt32BE(0) % 100;
}

export interface Variant<T = unknown> {
  name: string;
  /** 占多少流量，所有变体加起来是 100 */
  weight: number;
  /** 这个变体用什么：prompt 的版本号、模型名…… */
  value: T;
}

export interface Experiment<T = unknown> {
  name: string;
  variants: Variant<T>[];
}

/**
 * 给用户选一个变体：按顺序把 0–99 分给各个变体（第一个占 [0, w1)，第二个占 [w1, w1+w2)……），看用户的桶落在哪一段。
 * 权重加起来不是 100 就抛错
 */
export function chooseVariant<T>(experiment: Experiment<T>, userId: string): Variant<T> {
  const total = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  if (total !== 100) throw new Error(`实验 ${experiment.name} 的权重加起来是 ${total}，应该是 100`);
  const b = bucket(userId, experiment.name);
  let upper = 0;
  for (const variant of experiment.variants) {
    upper += variant.weight;
    if (b < upper) return variant;
  }
  return experiment.variants.at(-1)!;
}

/** 灰度：percent% 的用户用 canary，其余用 stable */
export function canary<T>(name: string, percent: number, stable: T, next: T): Experiment<T> {
  return { name, variants: [{ name: 'canary', weight: percent, value: next }, { name: 'stable', weight: 100 - percent, value: stable }] };
}

export interface ArmStats {
  /** 好评（或者成功）的次数 */
  successes: number;
  /** 一共多少次 */
  total: number;
}

export interface Comparison {
  rateA: number;
  rateB: number;
  /** B 比 A 高多少（可以是负的） */
  diff: number;
  /** 双侧检验的 p 值 */
  pValue: number;
  /** 样本够、差异显著，才能下结论 */
  verdict: 'B 更好' | 'A 更好' | '没有显著差别' | '样本不够';
}

/** 标准正态分布的累积分布函数（Abramowitz–Stegun 7.1.26 的近似，精度 1e-7） */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * 比较两组的比例（两比例 z 检验）：
 * - 任何一组少于 minSamples（默认 100）：样本不够
 * - 合并比例 p = (sA + sB) / (nA + nB)；标准误 se = sqrt(p(1-p)(1/nA + 1/nB))；z = (rateB - rateA) / se；p 值 = 2 × (1 - Φ(|z|))
 * - se 是 0（两组全对或者全错）：没有显著差别，p 值是 1
 * - p 值小于 alpha（默认 0.05）：看 diff 的正负说哪组更好；否则没有显著差别
 */
export function compareRates(a: ArmStats, b: ArmStats, { alpha = 0.05, minSamples = 100 } = {}): Comparison {
  const rateA = a.total ? a.successes / a.total : 0;
  const rateB = b.total ? b.successes / b.total : 0;
  const diff = rateB - rateA;
  if (a.total < minSamples || b.total < minSamples) return { rateA, rateB, diff, pValue: 1, verdict: '样本不够' };
  const pooled = (a.successes + b.successes) / (a.total + b.total);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.total + 1 / b.total));
  if (se === 0) return { rateA, rateB, diff, pValue: 1, verdict: '没有显著差别' };
  const pValue = 2 * (1 - normalCdf(Math.abs(diff / se)));
  const verdict = pValue >= alpha ? '没有显著差别' : diff > 0 ? 'B 更好' : 'A 更好';
  return { rateA, rateB, diff, pValue, verdict };
}
