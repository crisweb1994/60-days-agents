// 第 33 天：回归对比。每次改 prompt、换模型、加工具，都和一个基线（baseline）比较：
// 哪几条用例以前过、现在不过了（回归），哪几条修好了，每个评分器的通过率变了多少，成本和耗时变了多少。
// 结果存成 EvalRecord（JSON 文件），带着评估集的版本：评估集变了，两次的分数就不能直接比。
// 第 33 天的练习：TODO 1–3 都在这里。检查：npm run check 33
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { addUsage, calcCost, emptyUsage, type Price, type Usage } from '../usage.ts';
import type { ScoredCase } from './graders.ts';
import type { CaseResult } from './run.ts';

/** 一次评估存下来的全部东西 */
export interface EvalRecord {
  name: string;
  startedAt: string;
  /** 被测的模型，比如 openai:deepseek-flash */
  model: string;
  /** 评估集的版本（datasetVersion） */
  datasetVersion: string;
  /** 跑的时候的代码版本，比如 git 的提交号。可以不填 */
  commit?: string;
  results: CaseResult[];
  scores: ScoredCase[];
}

/**
 * 评估集的版本：内容的 SHA-256 的前 12 位。只算用例本身：去掉空行和 // 注释、每行去掉首尾空白，
 * 改注释、调空行不换版本；改了一个字的问题或者期望，就是新版本
 */
export function datasetVersion(text: string): string {
  // TODO 1：按行切开，去掉每行首尾的空白，去掉空行和 // 开头的行，用 \n 连起来，
  // 再用 createHash('sha256') 算出十六进制的摘要，取前 12 位
  void createHash;
  return text.length.toString(16).padStart(12, '0');
}

export async function saveRecord(file: string, record: EvalRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export async function loadRecord(file: string): Promise<EvalRecord> {
  return JSON.parse(await readFile(file, 'utf8')) as EvalRecord;
}

/** 一条用例、一个评分器过没过。找不到这个分数就算没过 */
function passed(record: EvalRecord, id: string, grader: string): boolean {
  return record.scores.find((c) => c.id === id)?.scores.find((s) => s.grader === grader)?.pass === true;
}

export interface GraderDelta {
  grader: string;
  baseline: number;
  candidate: number;
  /** candidate - baseline，正数是变好了 */
  delta: number;
  /** 以前过、现在不过的用例 */
  regressions: string[];
  /** 以前不过、现在过了的用例 */
  fixes: string[];
}

export interface Comparison {
  baseline: { name: string; model: string; datasetVersion: string };
  candidate: { name: string; model: string; datasetVersion: string };
  /** 两次的评估集版本不一样：分数不能直接比，只比两边都有的用例 */
  datasetChanged: boolean;
  /** 两边都有的用例数 */
  shared: number;
  /** 只有 candidate 有的用例（新加的）、只有 baseline 有的（删掉的） */
  added: string[];
  removed: string[];
  graders: GraderDelta[];
  /** 平均每条用例的用量、花费（有单价时）和耗时的中位数 */
  cost: { baseline: CostStats; candidate: CostStats };
}

export interface CostStats {
  usage: Usage;
  /** 平均每条用例多少元。没有单价时是 undefined */
  costPerCase?: number;
  medianMs: number;
  errors: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 一次评估在这些用例上的成本和耗时 */
export function costStats(record: EvalRecord, ids: Set<string>, price?: Price): CostStats {
  const results = record.results.filter((r) => ids.has(r.id));
  const usage = results.reduce((sum, r) => addUsage(sum, r.output?.usage ?? emptyUsage()), emptyUsage());
  return {
    usage,
    costPerCase: price && results.length ? calcCost(usage, price) / results.length : undefined,
    medianMs: median(results.map((r) => r.ms)),
    errors: results.filter((r) => r.error).length,
  };
}

/**
 * 比较两次评估。只在两边都有的用例上比（shared）：
 * - 每个评分器（两边出现过的都算，按 baseline 里第一次出现的顺序，再接上只有 candidate 有的）：两边的通过率、差值、回归、修好
 * - 新加的、删掉的用例单独列出来
 * - 成本和耗时也只算两边都有的用例
 * prices 是两边各自的单价（两个模型的单价不一样）
 */
export function compareRecords(baseline: EvalRecord, candidate: EvalRecord, prices: { baseline?: Price; candidate?: Price } = {}): Comparison {
  // TODO 2：
  // - shared：baseline 里、candidate 也有的用例 id（保持 baseline 的顺序）；added、removed 按注释
  // - 评分器的名字：两边的 scores 里出现过的，去重（[...new Set(...)]），先 baseline 后 candidate
  // - 每个评分器：在 shared 上算两边的通过率（用 passed()；shared 为空时是 0），delta，回归和修好的用例
  // - cost：两边各自用 costStats(记录, new Set(shared), 各自的单价)
  void passed;
  void costStats;
  void prices;
  throw new Error(`TODO 2：还没有实现 compareRecords（${baseline.name} → ${candidate.name}）`);
}

export interface GatePolicy {
  /** 每个评分器的通过率最多允许下降多少（0 到 1），默认 0.05。不写的评分器用 default */
  maxDrop?: Record<string, number> & { default?: number };
  /** 某个评分器最多允许几条回归，默认不限（只看通过率） */
  maxRegressions?: number;
  /** 这些用例出现回归就不通过，不管通过率：比如修过的线上事故 */
  mustPass?: string[];
  /** 平均每条用例的花费最多允许上涨多少（比例，0.2 是 20%）。不写就不检查 */
  maxCostIncrease?: number;
}

export interface GateResult {
  ok: boolean;
  /** 不通过的原因 */
  reasons: string[];
}

/**
 * 门禁：比较的结果能不能合并。按顺序检查，把所有不满足的都列出来：
 * 1. 每个评分器：下降超过 maxDrop → 「facts 的通过率下降了 8 个百分点（允许 5）」
 * 2. 有 maxRegressions 时，某个评分器的回归条数超过它 → 「facts 有 3 条回归（允许 2）：a、b、c」
 * 3. mustPass 里的用例在任何评分器上回归 → 「必须通过的 xxx 回归了（facts）」
 * 4. 有 maxCostIncrease、两边都有花费时，上涨超过它 → 「平均每条的花费上涨了 35%（允许 20%）」
 * 百分点、百分比都四舍五入成整数
 */
export function gate(comparison: Comparison, policy: GatePolicy = {}): GateResult {
  // TODO 3：按上面注释的四项检查，原因的写法要和注释一样。
  // 比较浮点数时留一点余量：下降 0.1、允许 0.1 应该算通过（-delta > allowed + 1e-9 才算超过）
  void comparison;
  void policy;
  return { ok: true, reasons: [] };
}

const signed = (v: number, unit = '') => `${v > 0 ? '+' : ''}${v}${unit}`;

/** 对比报告，Markdown 格式，可以直接贴进 PR 的评论 */
export function formatComparison(comparison: Comparison, result?: GateResult): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lines: string[] = ['## 评估对比', ''];
  if (result) lines.push(result.ok ? '✅ 门禁通过' : `❌ 门禁没有通过\n\n${result.reasons.map((r) => `- ${r}`).join('\n')}`, '');
  lines.push(`基线 **${comparison.baseline.name}**（${comparison.baseline.model}） → 本次 **${comparison.candidate.name}**（${comparison.candidate.model}），共同的用例 ${comparison.shared} 条`);
  if (comparison.datasetChanged) {
    lines.push('', `⚠️ 评估集变了（${comparison.baseline.datasetVersion} → ${comparison.candidate.datasetVersion}），只比较两边都有的用例`);
  }
  if (comparison.added.length) lines.push(`新加的用例：${comparison.added.join('、')}`);
  if (comparison.removed.length) lines.push(`删掉的用例：${comparison.removed.join('、')}`);
  lines.push('', '| 评分器 | 基线 | 本次 | 变化 | 回归 | 修好 |', '|---|---|---|---|---|---|');
  for (const g of comparison.graders) {
    lines.push(`| ${g.grader} | ${pct(g.baseline)} | ${pct(g.candidate)} | ${signed(Math.round(g.delta * 100), ' 个百分点')} | ${g.regressions.length} | ${g.fixes.length} |`);
  }
  const { baseline: b, candidate: c } = comparison.cost;
  const money = (v?: number) => (v === undefined ? '—' : `${v.toFixed(4)} 元`);
  const tokens = (s: CostStats) => Math.round((s.usage.inputTokens + s.usage.outputTokens) / Math.max(1, comparison.shared));
  lines.push(
    '',
    '| | 基线 | 本次 |',
    '|---|---|---|',
    `| 平均每条的 tokens | ${tokens(b)} | ${tokens(c)} |`,
    `| 平均每条的花费 | ${money(b.costPerCase)} | ${money(c.costPerCase)} |`,
    `| 耗时中位数 | ${(b.medianMs / 1000).toFixed(1)} 秒 | ${(c.medianMs / 1000).toFixed(1)} 秒 |`,
    `| 出错 | ${b.errors} | ${c.errors} |`,
  );
  const regressed = comparison.graders.filter((g) => g.regressions.length);
  if (regressed.length) {
    lines.push('', '### 回归', ...regressed.map((g) => `- ${g.grader}：${g.regressions.join('、')}`));
  }
  const fixed = comparison.graders.filter((g) => g.fixes.length);
  if (fixed.length) lines.push('', '### 修好的', ...fixed.map((g) => `- ${g.grader}：${g.fixes.join('、')}`));
  return lines.join('\n');
}

// ---------- 模型横评 ----------

export interface BakeoffRow {
  model: string;
  /** 每个评分器的通过率 */
  passRates: Record<string, number>;
  costPerCase?: number;
  medianMs: number;
  /** 最慢的 10% 从哪里开始（第 90 百分位） */
  p90Ms: number;
  errors: number;
}

/** 第 p 百分位（0 到 100），用最近秩法：排好序以后取第 ceil(p/100 × n) 个 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** 同一个评估集上几个模型的横评：每个模型一行。prices 按模型名给单价 */
export function bakeoff(records: EvalRecord[], prices: Record<string, Price | undefined> = {}): BakeoffRow[] {
  return records.map((record) => {
    const ids = new Set(record.results.map((r) => r.id));
    const stats = costStats(record, ids, prices[record.model]);
    const graders = [...new Set(record.scores.flatMap((c) => c.scores.map((s) => s.grader)))];
    const passRates = Object.fromEntries(graders.map((g) => [g, record.results.filter((r) => passed(record, r.id, g)).length / (record.results.length || 1)]));
    return { model: record.model, passRates, costPerCase: stats.costPerCase, medianMs: stats.medianMs, p90Ms: percentile(record.results.map((r) => r.ms), 90), errors: stats.errors };
  });
}

export function formatBakeoff(rows: BakeoffRow[]): string {
  const graders = [...new Set(rows.flatMap((r) => Object.keys(r.passRates)))];
  const header = `| 模型 | ${graders.join(' | ')} | 每条花费 | 耗时中位数 | P90 | 出错 |`;
  const sep = `|---|${graders.map(() => '---|').join('')}---|---|---|---|`;
  const body = rows.map(
    (r) =>
      `| ${r.model} | ${graders.map((g) => `${Math.round((r.passRates[g] ?? 0) * 100)}%`).join(' | ')} | ${r.costPerCase === undefined ? '—' : `${r.costPerCase.toFixed(4)} 元`} | ${(r.medianMs / 1000).toFixed(1)} 秒 | ${(r.p90Ms / 1000).toFixed(1)} 秒 | ${r.errors} |`,
  );
  return [header, sep, ...body].join('\n');
}

