// 第 55 天：跑一轮评估驱动的迭代（需真实模型，会产生费用）：
//   跑评估 → 汇总分数 → 给失败分类 → 记一轮 → 和上一轮比（有没有回归）→ 对照成功标准
// 运行：node days/day55/solution/eval/cli.ts --change "prompt 里加上删掉的代码也要看" [--split dev|test|all] [--ids a,b]
// 迭代时只用 dev（默认）；最后确认一次 test。记录写在 workspace/review-bot/iterations.jsonl
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createReliableModel } from '../core/providers.ts';
import { splitCases } from '../eval-set.ts';
import { REVIEW_PROMPT, SUMMARY_PROMPT } from '../prompts.ts';
import { createRepo } from '../repo.ts';
import { describeCriterion, extractSpec } from '../spec.ts';
import { appendIteration, checkCriteria, compareIterations, promptFingerprint, readIterations } from './iterate.ts';
import { parseReviewCases, renderResults, runEval } from './run.ts';
import { formatScores, scoreResults } from './score.ts';
import { renderTriage, triage } from './triage.ts';

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 时用终端里的环境变量
}
const { values } = parseArgs({
  options: {
    split: { type: 'string', default: 'dev' },
    change: { type: 'string', default: '（没写）' },
    ids: { type: 'string' },
    log: { type: 'string', default: 'workspace/review-bot/iterations.jsonl' },
    concurrency: { type: 'string', default: '2' },
  },
});
const split = values.split as 'dev' | 'test' | 'all';
if (!['dev', 'test', 'all'].includes(split)) throw new Error('--split 只能是 dev、test 或 all');
const data = (p: string) => fileURLToPath(new URL(`../../data/${p}`, import.meta.url));
const all = parseReviewCases(await readFile(data('review.jsonl'), 'utf8'));
// 按第 51 天的规则分：编号的哈希决定在哪一边，加了新用例也不会换边
const testIds = new Set(splitCases(all).test.map((c) => c.id));
let cases = split === 'all' ? all : all.filter((c) => testIds.has(c.id) === (split === 'test'));
if (values.ids) cases = cases.filter((c) => values.ids!.split(',').includes(c.id));
console.error(`跑 ${split} 的 ${cases.length} 条用例……`);

const { results } = await runEval(cases, { model: createReliableModel(), repo: createRepo(data('repo')) }, Number(values.concurrency));
const scores = scoreResults(results, cases);
console.log(renderResults(results));
console.log(`\n${formatScores(scores)}\n\n失败的分类：\n${renderTriage(triage(results, cases))}`);

const log = resolve(values.log);
const previous = (await readIterations(log)).filter((it) => it.split === split).at(-1);
const current = await appendIteration(log, {
  at: new Date().toISOString(),
  change: values.change,
  promptVersion: promptFingerprint([REVIEW_PROMPT, SUMMARY_PROMPT]),
  split,
  scores,
  passedIds: results.filter((r) => r.pass).map((r) => r.id),
  failedIds: results.filter((r) => !r.pass).map((r) => r.id),
});
console.log(`\n记为 ${current.id}（prompt ${current.promptVersion}）`);
if (previous) {
  const cmp = compareIterations(previous, current);
  console.log(`和 ${previous.id} 比：${cmp.verdict}；召回 ${(cmp.deltas.recall * 100).toFixed(1)}，精确 ${(cmp.deltas.precision * 100).toFixed(1)} 个百分点`);
  if (cmp.regressions.length) console.log(`⚠️ 回归：${cmp.regressions.join('、')} 原来能过，现在不过了`);
  if (cmp.fixed.length) console.log(`修好了：${cmp.fixed.join('、')}`);
}
const spec = extractSpec(await readFile(data('spec.md'), 'utf8'));
console.log('\n成功标准：');
for (const c of checkCriteria(spec.criteria, scores, describeCriterion)) {
  console.log(`${c.met === null ? '❔' : c.met ? '✅' : '❌'} ${c.target}${c.actual === null ? '（没有对应的分数）' : `，实际 ${c.actual}`}`);
}
