// 第 31 天：在命令行里跑评估。用 .env 里的真实模型，搜索和网页用假互联网，本地文档用 data/docs/。
// 结果存成 JSON，放在 evals/ 下面，以后可以拿来对比（第 33 天）。
// 运行（需真实模型）：
//   node days/day31/solution/eval/cli.ts                     跑全部用例
//   node days/day31/solution/eval/cli.ts --tags docs --limit 3
//   node days/day31/solution/eval/cli.ts --ids web-latency,docs-e2077 --name try-prompt
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createModel, providerFromEnv } from '../providers.ts';
import { parseDataset, selectCases, validateDataset } from './dataset.ts';
import { DATASET_FILE, startEvalEnv } from './env.ts';
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
console.error(`用 ${model.name} 跑 ${cases.length} 条用例……`);
const run = await runEval(cases, researchTarget(() => env.makeSetup(), model), {
  name: values.name,
  concurrency: Number(values.concurrency),
  onResult: (r, done, total) => console.error(`[${done}/${total}] ${r.error ? '✗' : '·'} ${r.id}（${(r.ms / 1000).toFixed(1)} 秒）`),
});
await env.close();
console.log(`\n${formatRunSummary(summarizeRun(run, cases))}`);
const dir = resolve(values.out);
await mkdir(dir, { recursive: true });
const file = join(dir, `${values.name}-${run.startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
console.log(`\n结果已保存：${file}`);
