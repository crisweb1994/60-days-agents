// 第 11 天：用一组小任务比较两套工具。每个任务跑几次，统计成功率、平均步数和平均输入 token。
// 运行（需真实模型）：node days/day11/exercise/bench.ts [每个任务跑几次，默认 3]
// 第 11 天的练习：TODO 6 在这里。检查：npm run check 11
import { runAgent } from './agent.ts';
import type { Tool } from './tool.ts';
import type { Model } from './types.ts';

export interface BenchTask {
  name: string;
  question: string;
  /** 判断回答对不对。只看回答里有没有关键信息，不要求一字不差 */
  check(answer: string): boolean;
}

export interface TaskReport {
  task: string;
  runs: number;
  passed: number;
  /** 平均调用了几次模型 */
  avgSteps: number;
  /** 平均每次运行的输入 token */
  avgInputTokens: number;
}

export interface BenchReport {
  /** 这套工具的名字，比如「改前」「改后」 */
  name: string;
  tasks: TaskReport[];
  /** 所有运行里成功的比例，0 到 1 */
  successRate: number;
  avgSteps: number;
  avgInputTokens: number;
}

export interface BenchOptions {
  name: string;
  tasks: BenchTask[];
  tools: Tool[];
  model: Model;
  /** 每个任务跑几次，默认 1。真实模型每次的表现不一样，跑多次才看得出差别 */
  runs?: number;
  maxSteps?: number;
  /** 每跑完一次回调一次，用来显示进度 */
  onRun?: (task: BenchTask, passed: boolean) => void;
}

const average = (numbers: number[]) => (numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0);

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const { name, tasks, tools, model, runs = 1, maxSteps = 8, onRun } = options;
  // TODO 6：每个任务跑 runs 次，一次一次地跑（不要并行），统计出 BenchReport。
  // - 每次用 runAgent(task.question, { model, tools, maxSteps })。status 是 completed 并且 task.check(answer) 通过，才算成功
  // - runAgent 抛出错误（比如网络断了）：这一次算失败，接着跑下一次；它没有步数和 token，不计入平均值
  // - 每跑完一次，调用 onRun?.(task, 成没成功)
  // - avgSteps、avgInputTokens 是平均值（average 已经写好了）；successRate 是所有运行里成功的比例
  void runAgent;
  void onRun;
  return {
    name,
    tasks: tasks.map((task) => ({ task: task.name, runs, passed: 0, avgSteps: 0, avgInputTokens: 0 })),
    successRate: average([]),
    avgSteps: maxSteps * 0,
    avgInputTokens: 0,
  };
}

/** 把几份报告并排列成一张表，每个任务一行，最后一行是总计 */
export function formatReports(reports: BenchReport[]): string {
  const header = `| 任务 | ${reports.map((r) => r.name).join(' | ')} |`;
  const divider = `|---|${reports.map(() => '---').join('|')}|`;
  const rows = reports[0].tasks.map((task, i) => {
    const cells = reports.map((r) => {
      const t = r.tasks[i];
      return `${t.passed}/${t.runs} · ${t.avgSteps.toFixed(1)} 步 · ${Math.round(t.avgInputTokens)} tokens`;
    });
    return `| ${task.task} | ${cells.join(' | ')} |`;
  });
  const total = reports.map(
    (r) => `${Math.round(r.successRate * 100)}% · ${r.avgSteps.toFixed(1)} 步 · ${Math.round(r.avgInputTokens)} tokens`,
  );
  return [header, divider, ...rows, `| **总计** | ${total.join(' | ')} |`].join('\n');
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { TASKS } = await import('./data/tasks.ts');
  const { createBadLibraryTools } = await import('./tools/library-bad.ts');
  const { createLibraryTools } = await import('./tools/library.ts');
  const model = createModel(providerFromEnv());
  const runs = Number(process.argv[2] ?? 3);
  const progress = (_task: BenchTask, passed: boolean) => process.stdout.write(passed ? '✓' : '✗');
  const reports: BenchReport[] = [];
  for (const [name, tools] of [
    ['改前', createBadLibraryTools()],
    ['改后', createLibraryTools()],
  ] as const) {
    process.stdout.write(`${name}：`);
    reports.push(await runBench({ name, tasks: TASKS, tools, model, runs, onRun: progress }));
    process.stdout.write('\n');
  }
  console.log(`\n${model.name}，每个任务跑 ${runs} 次\n\n${formatReports(reports)}`);
}
