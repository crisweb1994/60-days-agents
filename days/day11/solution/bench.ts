// 第 11 天：用一组小任务比较两套工具。每个任务跑几次，统计成功率、平均步数和平均输入 token。
// 运行（需真实模型）：node days/day11/solution/bench.ts [每个任务跑几次，默认 3]
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
  const reports: TaskReport[] = [];
  const allSteps: number[] = [];
  const allTokens: number[] = [];
  let passedTotal = 0;
  for (const task of tasks) {
    const steps: number[] = [];
    const tokens: number[] = [];
    let passed = 0;
    // 一个一个地跑，不并行：免得触发限流，也方便看进度
    for (let run = 0; run < runs; run++) {
      let ok = false;
      try {
        const result = await runAgent(task.question, { model, tools, maxSteps });
        // 没有正常完成（步数用完、原地打转……）的不算成功，哪怕半截的回答里碰巧有答案
        ok = result.status === 'completed' && task.check(result.answer);
        steps.push(result.steps);
        tokens.push(result.usage.inputTokens);
      } catch {
        // 调用模型出错，这一次算失败，接着跑下一次
      }
      if (ok) passed++;
      onRun?.(task, ok);
    }
    passedTotal += passed;
    allSteps.push(...steps);
    allTokens.push(...tokens);
    reports.push({ task: task.name, runs, passed, avgSteps: average(steps), avgInputTokens: average(tokens) });
  }
  return {
    name,
    tasks: reports,
    successRate: tasks.length ? passedTotal / (tasks.length * runs) : 0,
    avgSteps: average(allSteps),
    avgInputTokens: average(allTokens),
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
