// 第 33 天：在 CI 里跑评估。跑一遍评估集、打分、和基线比较，写出 Markdown 报告；门禁不通过时退出码是 1，CI 就会标红。
// 基线是 main 分支上最近一次的评估结果（evals/baseline.json）。第一次运行、还没有基线时，把这次的结果存成基线。
// 运行（需真实模型）：
//   node days/day33/exercise/eval/ci.ts                                 和基线比较
//   node days/day33/exercise/eval/ci.ts --update-baseline               跑完以后把结果存成新的基线（合并到 main 以后做）
//   node days/day33/exercise/eval/ci.ts --report eval-report.md --tags web,docs
import type { Model } from '../types.ts';
import { parsePrice, type Price } from '../usage.ts';
import type { EvalCase } from './dataset.ts';
import { gradeRun, type Grader } from './graders.ts';
import { compareRecords, datasetVersion, formatComparison, gate, type EvalRecord, type GatePolicy } from './regression.ts';
import { runEval, type RunEvalOptions, type Target } from './run.ts';

/** 带着这个标签的用例，一条都不许回归：比如线上出过事故、修好以后写进来的 */
export const MUST_PASS_TAG = 'must-pass';

/** 默认的门禁：每个评分器最多掉 5 个百分点，模型评审波动大，放宽到 10；花费最多涨 20% */
export const DEFAULT_POLICY: GatePolicy = { maxDrop: { default: 0.05, quality: 0.1 }, maxCostIncrease: 0.2 };

/** 从评估集里找出必须通过的用例 */
export function mustPassIds(cases: EvalCase[]): string[] {
  return cases.filter((c) => c.tags.includes(MUST_PASS_TAG)).map((c) => c.id);
}

export interface EvaluateOptions extends Pick<RunEvalOptions, 'concurrency' | 'onResult' | 'signal'> {
  name: string;
  model: Model;
  /** 评估集文件的原文，用来算版本 */
  datasetText: string;
  graders: Grader[];
  commit?: string;
}

/** 跑一遍、打分，变成一条可以存下来、可以比较的记录 */
export async function evaluate(cases: EvalCase[], target: Target, options: EvaluateOptions): Promise<EvalRecord> {
  const { name, model, datasetText, graders, commit, ...runOptions } = options;
  const run = await runEval(cases, target, { name, ...runOptions });
  const scored = await gradeRun(run, cases, graders, { signal: runOptions.signal });
  return { name, startedAt: run.startedAt, model: model.name, datasetVersion: datasetVersion(datasetText), commit, results: run.results, scores: scored.cases };
}

/** 和基线比较、过门禁、写报告。mustPass 会合并进 policy */
export function check(baseline: EvalRecord, candidate: EvalRecord, options: { policy?: GatePolicy; mustPass?: string[]; prices?: { baseline?: Price; candidate?: Price } } = {}) {
  const policy = { ...(options.policy ?? DEFAULT_POLICY) };
  policy.mustPass = [...(policy.mustPass ?? []), ...(options.mustPass ?? [])];
  const comparison = compareRecords(baseline, candidate, options.prices);
  const result = gate(comparison, policy);
  return { comparison, result, markdown: formatComparison(comparison, result) };
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // CI 里没有 .env，用环境变量
  }
  const { existsSync } = await import('node:fs');
  const { readFile, writeFile, appendFile } = await import('node:fs/promises');
  const { parseArgs } = await import('node:util');
  const { createModel, providerFromEnv } = await import('../providers.ts');
  const { parseDataset, selectCases, validateDataset } = await import('./dataset.ts');
  const { DATASET_FILE, startEvalEnv } = await import('./env.ts');
  const { citationGrader, factsGrader, rubricGrader, safetyGrader, trajectoryGrader } = await import('./graders.ts');
  const { loadRecord, saveRecord } = await import('./regression.ts');
  const { researchTarget } = await import('./run.ts');
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string', default: DATASET_FILE },
      baseline: { type: 'string', default: 'evals/baseline.json' },
      report: { type: 'string', default: 'eval-report.md' },
      'update-baseline': { type: 'boolean', default: false },
      judge: { type: 'boolean', default: false },
      tags: { type: 'string' },
      name: { type: 'string', default: process.env.GITHUB_HEAD_REF || 'local' },
    },
  });
  const text = await readFile(values.dataset, 'utf8');
  const all = parseDataset(text);
  const problems = validateDataset(all);
  if (problems.length) {
    console.error(`评估集有问题：\n${problems.join('\n')}`);
    process.exit(1);
  }
  const cases = selectCases(all, { tags: values.tags?.split(',') });
  const env = await startEvalEnv();
  const model = createModel(providerFromEnv());
  const graders = [factsGrader, citationGrader, trajectoryGrader, safetyGrader, ...(values.judge ? [rubricGrader({ model })] : [])];
  const candidate = await evaluate(cases, researchTarget(() => env.makeSetup(), model), {
    name: values.name,
    model,
    datasetText: text,
    graders,
    commit: process.env.GITHUB_SHA,
    onResult: (r, done, total) => console.error(`[${done}/${total}] ${r.error ? '✗' : '·'} ${r.id}`),
  });
  await env.close();
  if (values['update-baseline'] || !existsSync(values.baseline)) {
    await saveRecord(values.baseline, candidate);
    console.log(`已存成基线：${values.baseline}`);
    process.exit(0);
  }
  const price = parsePrice(process.env.OPENAI_PRICE);
  const { result, markdown } = check(await loadRecord(values.baseline), candidate, { mustPass: mustPassIds(cases), prices: { baseline: price, candidate: price } });
  await writeFile(values.report, `${markdown}\n`);
  // GitHub Actions：写进这次运行的摘要页
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(markdown);
  process.exit(result.ok ? 0 : 1);
}
