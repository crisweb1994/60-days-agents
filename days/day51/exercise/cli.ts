// 第 51 天：检查你的需求说明和评估集。
// 运行：node days/day51/exercise/cli.ts <需求说明.md> <评估集.jsonl>
// 例子：node days/day51/exercise/cli.ts days/day51/example/spec.md days/day51/data/review.jsonl
// 有 error 时退出码是 1，可以放进 CI。
import { readFile } from 'node:fs/promises';
import { checkCoverage, parseCases, renderCoverage, splitCases } from './eval-set.ts';
import { checkSpec, describeCriterion, extractSpec } from './spec.ts';

const [specFile, casesFile] = process.argv.slice(2);
if (!specFile || !casesFile) {
  console.error('用法：node cli.ts <需求说明.md> <评估集.jsonl>');
  process.exit(1);
}
try {
  const spec = extractSpec(await readFile(specFile, 'utf8'));
  const specProblems = checkSpec(spec);
  console.log(`# ${spec.name}：${spec.pitch}\n`);
  console.log('成功标准：');
  for (const c of spec.criteria) console.log(`- ${describeCriterion(c)}（${c.how}）`);
  console.log(`- 单次任务 ≤ ${spec.budget.costPerTask} 元，p95 ≤ ${spec.budget.p95Seconds} 秒\n`);
  for (const p of specProblems) console.log(`${p.level === 'error' ? '❌' : '⚠️'} ${p.message}`);
  const cases = parseCases(await readFile(casesFile, 'utf8'));
  const coverage = checkCoverage(spec, cases);
  console.log(`\n${renderCoverage(spec, coverage)}`);
  const { dev, test } = splitCases(cases);
  console.log(`开发集 ${dev.length} 条，测试集 ${test.length} 条（测试集留到第 55 天最后再看）`);
  if (specProblems.some((p) => p.level === 'error') || !coverage.ok) process.exit(1);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
