// 第 21 天：同一组任务，用固定流程和 Agent 各跑一遍，对比效果、成本、延迟和模型调用次数。
// 运行（需真实模型和搜索的 Key）：node days/day21/solution/compare.ts tasks.json
// tasks.json 的格式：[{ "question": "……", "expected": ["答案里应该出现的词", ["或者", "这几种写法之一"]] }]
import type { ChatOptions, ChatRequest, Model } from './types.ts';
import { addUsage, calcCost, emptyUsage, type Price, type Usage } from './usage.ts';

export interface CompareTask {
  question: string;
  /**
   * 正确的回答里应该出现的事实，全部出现才算答对。每一项是一个词，或者几种等价的写法（出现一种就行）。
   * 比较时忽略空白：「12 月 31 日」和「12月31日」算一样
   */
  expected: (string | string[])[];
}

/** 一种做法跑完一个任务交回的东西 */
export interface RunOutput {
  answer: string;
  usage: Usage;
  modelCalls: number;
  /** 引用检查有没有通过 */
  citationsOk: boolean;
}

export interface RunMetrics {
  /** 哪种做法，比如 workflow、agent */
  approach: string;
  question: string;
  /** expected 里的事实都出现了 */
  correct: boolean;
  /** 没有出现的事实 */
  missing: string[];
  citationsOk: boolean;
  modelCalls: number;
  usage: Usage;
  /** 花了多少元。没有单价时是 undefined */
  cost?: number;
  /** 耗时，单位毫秒 */
  ms: number;
  /** 跑的过程中出错了 */
  error?: string;
}

/** 包一层模型，记下调用了几次、一共用了多少 token。Agent 和固定流程都只认 Model 接口，套上这层也分不出区别 */
export function countCalls(model: Model): Model & { readonly calls: number; readonly usage: Usage } {
  let calls = 0;
  let usage = emptyUsage();
  return {
    name: model.name,
    get calls() {
      return calls;
    },
    get usage() {
      return usage;
    },
    async chat(request: ChatRequest, options?: ChatOptions) {
      calls++;
      const result = await model.chat(request, options);
      usage = addUsage(usage, result.usage);
      return result;
    },
  };
}

const squash = (text: string) => text.replace(/\s+/g, '');

/** 回答里没有出现的事实。每一项按显示用的写法返回，有几种写法时用「/」连起来 */
export function missingFacts(answer: string, expected: CompareTask['expected']): string[] {
  const text = squash(answer);
  return expected
    .map((fact) => (Array.isArray(fact) ? fact : [fact]))
    .filter((options) => !options.some((option) => text.includes(squash(option))))
    .map((options) => options.join('/'));
}

export interface MeasureOptions {
  price?: Price;
  /** 当前时间（毫秒），测试时换成假的 */
  clock?: () => number;
}

/** 跑一次，记下效果、用量、花费和耗时。出错不抛出，记成一次失败：对比的时候，出错也是结果的一部分 */
export async function measure(approach: string, task: CompareTask, run: () => Promise<RunOutput>, options: MeasureOptions = {}): Promise<RunMetrics> {
  const { price, clock = () => performance.now() } = options;
  const start = clock();
  try {
    const output = await run();
    const missing = missingFacts(output.answer, task.expected);
    return {
      approach,
      question: task.question,
      correct: missing.length === 0,
      missing,
      citationsOk: output.citationsOk,
      modelCalls: output.modelCalls,
      usage: output.usage,
      cost: price ? calcCost(output.usage, price) : undefined,
      ms: clock() - start,
    };
  } catch (error) {
    return {
      approach,
      question: task.question,
      correct: false,
      missing: missingFacts('', task.expected),
      citationsOk: false,
      modelCalls: 0,
      usage: emptyUsage(),
      ms: clock() - start,
      error: (error as Error).message,
    };
  }
}

export interface Summary {
  approach: string;
  runs: number;
  /** 答对的比例，0 到 1 */
  accuracy: number;
  /** 引用检查通过的比例 */
  citationRate: number;
  avgCalls: number;
  /** 平均每次的 token 数（输入加输出） */
  avgTokens: number;
  /** 平均每次的花费。有一次没有单价就是 undefined */
  avgCost?: number;
  /** 耗时的中位数，单位毫秒 */
  medianMs: number;
  maxMs: number;
}

const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 按做法分组汇总，顺序按每种做法第一次出现的顺序。耗时用中位数：偶尔一次网络慢，不该把平均值拉得很高 */
export function summarize(metrics: RunMetrics[]): Summary[] {
  const groups = Map.groupBy(metrics, (m) => m.approach);
  return [...groups].map(([approach, runs]) => ({
    approach,
    runs: runs.length,
    accuracy: runs.filter((r) => r.correct).length / runs.length,
    citationRate: runs.filter((r) => r.citationsOk).length / runs.length,
    avgCalls: average(runs.map((r) => r.modelCalls)),
    avgTokens: average(runs.map((r) => r.usage.inputTokens + r.usage.outputTokens)),
    avgCost: runs.every((r) => r.cost !== undefined) ? average(runs.map((r) => r.cost!)) : undefined,
    medianMs: median(runs.map((r) => r.ms)),
    maxMs: Math.max(...runs.map((r) => r.ms)),
  }));
}

/** 汇总成一张 Markdown 表格 */
export function formatSummary(summaries: Summary[]): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const rows = summaries.map((s) =>
    [
      s.approach,
      s.runs,
      percent(s.accuracy),
      percent(s.citationRate),
      s.avgCalls.toFixed(1),
      Math.round(s.avgTokens),
      s.avgCost === undefined ? '—' : `${s.avgCost.toFixed(4)} 元`,
      `${(s.medianMs / 1000).toFixed(1)} 秒`,
      `${(s.maxMs / 1000).toFixed(1)} 秒`,
    ].join(' | '),
  );
  return [
    '| 做法 | 次数 | 答对 | 引用合格 | 模型调用 | tokens | 花费 | 耗时中位数 | 最慢 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { readFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { parsePrice } = await import('./usage.ts');
  const { research } = await import('./research.ts');
  const { researchWorkflow } = await import('./workflow.ts');
  const file = process.argv[2];
  const search = searchProviderFromEnv();
  if (!file || !search) {
    console.error(file ? '要先在 .env 里配置 SEARCH_PROVIDER 和对应的 Key' : '用法：compare.ts tasks.json');
    process.exit(1);
  }
  const tasks = JSON.parse(await readFile(file, 'utf8')) as CompareTask[];
  const price = parsePrice(process.env.OPENAI_PRICE);
  const metrics: RunMetrics[] = [];
  for (const task of tasks) {
    console.error(`· ${task.question}`);
    metrics.push(
      await measure('workflow', task, async () => {
        const r = await researchWorkflow(task.question, { search }, { model: createModel(providerFromEnv()) });
        return { answer: r.answer, usage: r.usage, modelCalls: r.modelCalls, citationsOk: r.report.ok };
      }, { price }),
      await measure('agent', task, async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'compare-'));
        const r = await research(task.question, { workspace, search }, { model: createModel(providerFromEnv()) });
        return { answer: r.result.answer, usage: r.result.usage, modelCalls: r.result.steps, citationsOk: r.report.ok };
      }, { price }),
    );
  }
  for (const m of metrics.filter((m) => !m.correct)) console.error(`✗ ${m.approach}：${m.question}（缺少 ${m.missing.join('、')}${m.error ? `；出错：${m.error}` : ''}）`);
  console.log(formatSummary(summarize(metrics)));
}
