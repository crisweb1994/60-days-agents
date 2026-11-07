// 第 31 天：在命令行里跑评估。用 .env 里的真实模型，搜索和网页用假互联网，本地文档用 data/docs/。
// 结果存成 JSON，放在 evals/ 下面，以后可以拿来对比（第 33 天）。
// 第 32 天：用几个评分器打分（事实、引用、调用轨迹，加上 --judge 时还有模型评审）；--repeat 跑几遍看方差。
// 运行（需真实模型）：
//   node days/day31/solution/eval/cli.ts                     跑全部用例
//   node days/day31/solution/eval/cli.ts --tags docs --limit 3
//   node days/day31/solution/eval/cli.ts --ids web-latency,docs-e2077 --name try-prompt
//   node days/day32/solution/eval/cli.ts --judge --repeat 3   模型评审回答质量，跑三遍
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createModel, providerFromEnv } from '../providers.ts';
import { parseDataset, selectCases, validateDataset } from './dataset.ts';
import { DATASET_FILE, startEvalEnv } from './env.ts';
import { citationGrader, factsGrader, formatScores, gradeRun, repeatability, rubricGrader, summarizeScores, trajectoryGrader, type Grader, type ScoredRun } from './graders.ts';
import { formatRunSummary, researchTarget, runEval, summarizeRun } from './run.ts';

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件时，就用终端里已经设置的环境变量
}
const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: DATASET_FILE },
    tags: { type: 'string' },
    ids: { type: 'string' },
    limit: { type: 'string' },
    name: { type: 'string', default: 'run' },
    concurrency: { type: 'string', default: '2' },
    out: { type: 'string', default: 'evals' },
    judge: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '1' },
  },
});
const list = (text?: string) => text?.split(',').map((s) => s.trim()).filter(Boolean);
const all = parseDataset(await readFile(values.dataset, 'utf8'));
const problems = validateDataset(all);
if (problems.length) {
  console.error(`评估集有问题：\n${problems.join('\n')}`);
  process.exit(1);
}
const cases = selectCases(all, { tags: list(values.tags), ids: list(values.ids), limit: values.limit ? Number(values.limit) : undefined });
const env = await startEvalEnv();
const model = createModel(providerFromEnv());
const graders: Grader[] = [factsGrader, citationGrader, trajectoryGrader, ...(values.judge ? [rubricGrader({ model })] : [])];
const dir = resolve(values.out);
await mkdir(dir, { recursive: true });
const scored: ScoredRun[] = [];
for (let i = 1; i <= Number(values.repeat); i++) {
  console.error(`第 ${i} 遍：用 ${model.name} 跑 ${cases.length} 条用例……`);
  const run = await runEval(cases, researchTarget(() => env.makeSetup(), model), {
    name: values.name,
    concurrency: Number(values.concurrency),
    onResult: (r, done, total) => console.error(`[${done}/${total}] ${r.error ? '✗' : '·'} ${r.id}（${(r.ms / 1000).toFixed(1)} 秒）`),
  });
  console.log(`\n${formatRunSummary(summarizeRun(run, cases))}`);
  const result = await gradeRun(run, cases, graders);
  console.log(`\n${formatScores(summarizeScores(result))}`);
  scored.push(result);
  const file = join(dir, `${values.name}-${run.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify({ ...run, scores: result.cases }, null, 2)}\n`);
  console.log(`\n结果已保存：${file}`);
}
await env.close();
if (scored.length > 1) {
  const r = repeatability(scored, 'facts');
  console.log(`\n跑了 ${r.runs} 遍，facts 的通过率：${r.passRates.map((p) => `${Math.round(p * 100)}%`).join('、')}（标准差 ${(r.stddev * 100).toFixed(1)} 个百分点）`);
  if (r.flaky.length) console.log(`时对时错的：${r.flaky.map((f) => `${f.id}（${f.passed}/${r.runs}）`).join('、')}`);
}
