// 第 52 天：检查你的设计文档：工具清单的风险、致命三要素、成本估算。
// 运行：node days/day52/exercise/cli.ts <设计文档.md> [单次任务的预算（元）]
// 例子：node days/day52/exercise/cli.ts days/day52/example/design.md 0.2
import { readFile } from 'node:fs/promises';
import { estimateCost, extractDesign, monthlyCost, renderToolTable, reviewDesign } from './design.ts';

const [file, budgetArg] = process.argv.slice(2);
if (!file) {
  console.error('用法：node cli.ts <设计文档.md> [单次任务的预算（元）]');
  process.exit(1);
}
try {
  const design = extractDesign(await readFile(file, 'utf8'));
  console.log(`# ${design.name}（${design.mode}，最多 ${design.maxSteps} 步）\n`);
  console.log(`${renderToolTable(design.tools)}\n`);
  const findings = reviewDesign(design);
  for (const f of findings) console.log(`${f.level === 'error' ? '❌' : '⚠️'} [${f.rule}] ${f.message}`);
  if (!findings.length) console.log('✅ 工具清单没有发现问题');
  if (design.estimate) {
    const { tasksPerDay, ...input } = design.estimate;
    const e = estimateCost(input);
    console.log(`\n一次任务：输入 ${e.inputTokens} token（缓存命中 ${e.cachedTokens}），输出 ${e.outputTokens} token，约 ${e.cost.toFixed(4)} 元`);
    for (const p of e.perStep) console.log(`  第 ${p.step} 步：输入 ${p.inputTokens}，命中 ${p.cachedTokens}`);
    console.log(`每天 ${tasksPerDay} 次，一个月约 ${monthlyCost(e.cost, tasksPerDay).toFixed(2)} 元`);
    const budget = Number(budgetArg);
    if (budgetArg && Number.isFinite(budget)) console.log(e.cost <= budget ? `✅ 在预算 ${budget} 元以内` : `❌ 超出预算 ${budget} 元：减少步数、压缩工具结果、提高缓存命中，或者换便宜的模型`);
  }
  if (findings.some((f) => f.level === 'error')) process.exit(1);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
