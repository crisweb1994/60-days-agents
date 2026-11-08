// 第 54 天：用真实模型在评估集上跑 review-bot（需真实模型，会产生费用）。
// 运行：node days/day54/exercise/eval/cli.ts [--ids sql-injection,clean-rename] [--tags security] [--task review]
// 模型的配置从 .env 读（MODEL_PROVIDER、OPENAI_* 或 ANTHROPIC_*）
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createReliableModel } from '../core/providers.ts';
import { formatUsage, parsePrice } from '../core/usage.ts';
import { createRepo } from '../repo.ts';
import { parseReviewCases, renderResults, runEval } from './run.ts';

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 时用终端里的环境变量
}
const { values } = parseArgs({ options: { ids: { type: 'string' }, tags: { type: 'string' }, task: { type: 'string' }, concurrency: { type: 'string', default: '2' } } });
const data = (p: string) => fileURLToPath(new URL(`../../data/${p}`, import.meta.url));
let cases = parseReviewCases(await readFile(data('review.jsonl'), 'utf8'));
if (values.ids) cases = cases.filter((c) => values.ids!.split(',').includes(c.id));
if (values.tags) cases = cases.filter((c) => values.tags!.split(',').some((t) => c.tags.includes(t)));
if (values.task) cases = cases.filter((c) => c.task === values.task);
console.error(`跑 ${cases.length} 条用例……`);
const { results, usage } = await runEval(cases, { model: createReliableModel(), repo: createRepo(data('repo')) }, Number(values.concurrency));
console.log(renderResults(results));
console.log(formatUsage(usage, parsePrice(process.env.OPENAI_PRICE)));
