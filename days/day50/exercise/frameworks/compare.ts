// 第 41 天：同一组任务，交给几种实现各跑一遍，比较结果、步数、token 和耗时。
// 和第 21 天比较固定流程与 Agent、第 33 天横评模型是同一个思路：先有一组任务，再谈谁好。
// 运行（需真实模型）：node days/day41/solution/frameworks/compare.ts
import type { Tool } from '../tool.ts';
import { formatUsage, type Usage } from '../usage.ts';
import type { FrameworkResult, FrameworkRunner } from './common.ts';

export interface CompareTask {
  id: string;
  question: string;
  /** 回答里应该有的文字，用来判断对没对 */
  expect?: string;
}

export interface CompareRow {
  task: string;
  framework: string;
  /** 跑出错了就没有 result，有 error */
  result?: FrameworkResult;
  error?: string;
  /** 回答里有没有 expect；没写 expect 时看有没有正常完成 */
  ok: boolean;
  ms: number;
}

export interface CompareOptions {
  tools: () => Tool[];
  system?: string;
  maxSteps?: number;
  /** 当前时间（毫秒），测试时换成假的 */
  clock?: () => number;
}

/**
 * 每个任务、每种实现各跑一次，一个接一个地跑（同时跑会互相抢限流，耗时就不准了）：
 * - 每次都用一套新的工具（tools()），互不影响
 * - 记下开始和结束的 clock()，ms 是两者之差
 * - 出错不要让整次比较失败，记成这一行的 error，ok 是 false
 * - ok：有 expect 时看回答里有没有它；没有 expect 时看 status 是不是 completed
 * 结果按任务、再按 runners 的顺序排列
 */
export async function compareFrameworks(tasks: CompareTask[], runners: Record<string, FrameworkRunner>, options: CompareOptions): Promise<CompareRow[]> {
  const { tools, system, maxSteps, clock = () => performance.now() } = options;
  const rows: CompareRow[] = [];
  for (const task of tasks) {
    for (const [framework, runner] of Object.entries(runners)) {
      const started = clock();
      try {
        const result = await runner({ question: task.question, tools: tools(), system, maxSteps });
        const ok = task.expect ? result.answer.includes(task.expect) : result.status === 'completed';
        rows.push({ task: task.id, framework, result, ok, ms: clock() - started });
      } catch (error) {
        rows.push({ task: task.id, framework, error: (error as Error).message, ok: false, ms: clock() - started });
      }
    }
  }
  return rows;
}

export interface FrameworkSummary {
  framework: string;
  passed: number;
  total: number;
  avgSteps: number;
  avgMs: number;
  usage: Usage;
}

/** 按实现汇总：通过几个、平均步数、平均耗时、合计用量 */
export function summarizeComparison(rows: CompareRow[]): FrameworkSummary[] {
  const groups = new Map<string, CompareRow[]>();
  for (const row of rows) groups.set(row.framework, [...(groups.get(row.framework) ?? []), row]);
  return [...groups].map(([framework, list]) => {
    const done = list.filter((r) => r.result);
    const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
    return {
      framework,
      passed: list.filter((r) => r.ok).length,
      total: list.length,
      avgSteps: avg(done.map((r) => r.result!.steps)),
      avgMs: avg(list.map((r) => r.ms)),
      usage: done.reduce(
        (u, r) => ({
          inputTokens: u.inputTokens + r.result!.usage.inputTokens,
          cachedTokens: u.cachedTokens + r.result!.usage.cachedTokens,
          outputTokens: u.outputTokens + r.result!.usage.outputTokens,
          reasoningTokens: u.reasoningTokens + r.result!.usage.reasoningTokens,
        }),
        { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      ),
    };
  });
}

export function formatComparison(summaries: FrameworkSummary[]): string {
  const lines = ['| 实现 | 通过 | 平均步数 | 平均耗时 | 用量 |', '|---|---|---|---|---|'];
  for (const s of summaries) lines.push(`| ${s.framework} | ${s.passed}/${s.total} | ${s.avgSteps.toFixed(1)} | ${(s.avgMs / 1000).toFixed(1)} 秒 | ${formatUsage(s.usage)} |`);
  return lines.join('\n');
}

/** mini-agent 的几个小任务：要用计算器、要读文件、要写文件（写之前要确认）、不用工具 */
export const MINI_TASKS: CompareTask[] = [
  { id: 'calc', question: '算一下 (17 + 25) * 3 等于多少？', expect: '126' },
  { id: 'calc-2', question: '1234 乘以 5678 是多少？', expect: '7006652' },
  { id: 'chat', question: '用一句话介绍你自己。' },
];

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve } = await import('node:path');
  const { createTools } = await import('../tools/index.ts');
  const { createOpenAIModel } = await import('../openai.ts');
  const { handwrittenRunner } = await import('./common.ts');
  const { aiSdkRunner, createAISDKModel } = await import('./ai-sdk.ts');
  const { agentsSdkRunner, createAgentsModel } = await import('./openai-agents.ts');
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  const rows = await compareFrameworks(
    MINI_TASKS,
    { handwritten: handwrittenRunner(createOpenAIModel()), 'ai-sdk': aiSdkRunner(createAISDKModel()), 'openai-agents': agentsSdkRunner(createAgentsModel()) },
    { tools: () => createTools(workspace) },
  );
  for (const r of rows) console.error(`${r.ok ? '✓' : '✗'} ${r.task} · ${r.framework}${r.error ? `：${r.error}` : ''}`);
  console.log(formatComparison(summarizeComparison(rows)));
}
