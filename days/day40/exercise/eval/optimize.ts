// 第 36 天：省钱要拿评估来验证。同一个评估集跑两种配置：基线（现在的做法）和精简版（便宜的模型、更短的网页分页、更少的步数），
// 比较分数和花费。花费降了 30%、分数没有明显下降，才算省成功了。
// 运行（需真实模型）：node days/day36/solution/eval/optimize.ts --tags web,docs
import type { ResearchSetup } from '../research.ts';
import type { Model } from '../types.ts';
import type { Price } from '../usage.ts';
import type { Comparison } from './regression.ts';

/** 研究助手的一种配置：哪些旋钮可以拧 */
export interface ResearchConfig {
  name: string;
  model: Model;
  /** fetch_page 每页多少字，默认 4000 */
  pageSize?: number;
  /** 最多调用几次模型，默认 15 */
  maxSteps?: number;
}

/** 在一套配置上加上这个配置的网页分页 */
export const withConfig = (makeSetup: () => Promise<ResearchSetup>, config: ResearchConfig) => async (): Promise<ResearchSetup> => ({
  ...(await makeSetup()),
  ...(config.pageSize ? { pageSize: config.pageSize } : {}),
});

/**
 * 成本降低了多少（0 到 1，负数是涨了）。两边都有单价时比较平均每条的花费；
 * 否则退回比较 token：输入加上输出乘以 outputWeight（输出一般比输入贵好几倍，默认按 4 倍算）
 */
export function costReduction(comparison: Comparison, outputWeight = 4): number {
  const { baseline, candidate } = comparison.cost;
  if (baseline.costPerCase && candidate.costPerCase !== undefined) return 1 - candidate.costPerCase / baseline.costPerCase;
  const weighted = (u: { inputTokens: number; outputTokens: number }) => u.inputTokens + outputWeight * u.outputTokens;
  const base = weighted(baseline.usage);
  return base ? 1 - weighted(candidate.usage) / base : 0;
}

/** 两种配置的单价可能不一样（换了模型），各算各的 */
export function priceOf(prices: Record<string, Price | undefined>, model: Model): Price | undefined {
  return prices[model.name];
}


if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { readFile } = await import('node:fs/promises');
  const { parseArgs } = await import('node:util');
  const { createCheapModel, createModel, providerFromEnv } = await import('../providers.ts');
  const { parsePrice } = await import('../usage.ts');
  const { parseDataset, selectCases } = await import('./dataset.ts');
  const { DATASET_FILE, startEvalEnv } = await import('./env.ts');
  const { citationGrader, factsGrader, trajectoryGrader } = await import('./graders.ts');
  const { compareRecords, formatComparison, gate } = await import('./regression.ts');
  const { evaluate } = await import('./ci.ts');
  const { researchTarget } = await import('./run.ts');
  const { values } = parseArgs({ options: { tags: { type: 'string' }, limit: { type: 'string' } } });
  const text = await readFile(DATASET_FILE, 'utf8');
  const cases = selectCases(parseDataset(text), { tags: values.tags?.split(','), limit: values.limit ? Number(values.limit) : undefined });
  const env = await startEvalEnv();
  const main = createModel(providerFromEnv());
  const cheap = createCheapModel();
  const configs: ResearchConfig[] = [
    { name: 'baseline', model: main },
    { name: 'lean', model: cheap, pageSize: 2000, maxSteps: 8 },
  ];
  const prices: Record<string, Price | undefined> = { [main.name]: parsePrice(process.env.OPENAI_PRICE), [cheap.name]: parsePrice(process.env.CHEAP_PRICE ?? process.env.OPENAI_PRICE) };
  const records = [];
  for (const config of configs) {
    console.error(`· ${config.name}（${config.model.name}）：${cases.length} 条用例`);
    const target = researchTarget(withConfig(() => env.makeSetup(), config), config.model, { maxSteps: config.maxSteps });
    records.push(await evaluate(cases, target, { name: config.name, model: config.model, datasetText: text, graders: [factsGrader, citationGrader, trajectoryGrader] }));
  }
  await env.close();
  const comparison = compareRecords(records[0], records[1], { baseline: priceOf(prices, configs[0].model), candidate: priceOf(prices, configs[1].model) });
  console.log(formatComparison(comparison, gate(comparison, { maxDrop: { default: 0.05 } })));
  console.log(`\n成本降低了 ${Math.round(costReduction(comparison) * 100)}%`);
}
