// 第 31 天：跑评估。把评估集里的每条用例交给被测的对象（target）跑一遍，记下输出、用量和耗时，再用代码检查期望。
// target 是一个函数：给它一条用例，它交回回答、用量、调用了哪些工具、引用了哪些来源。
// 研究助手、固定流程、深度研究，只要包成 target，就能用同一套评估集比较（第 33 天的横评就靠这个）。
import { missingFacts } from '../compare.ts';
import { mapLimit } from '../parallel.ts';
import { research, type ResearchSetup } from '../research.ts';
import type { Message, Model } from '../types.ts';
import { addUsage, emptyUsage, type Usage } from '../usage.ts';
import type { EvalCase } from './dataset.ts';

/** 被测对象跑完一条用例交回的东西 */
export interface TargetOutput {
  answer: string;
  usage: Usage;
  /** 按顺序调用过的工具和参数。被安全策略拦下的带着 blocked（第 37 天） */
  toolCalls: { name: string; arguments: unknown; blocked?: boolean }[];
  /** 回答里引用到的来源的网址（本地文档是 doc:路径） */
  cited: string[];
  /** 引用检查发现的问题（第 20 天的 checkCitations） */
  citationProblems: string[];
  /** Agent 为什么停下：completed、max_steps…… */
  status: string;
}

export type Target = (c: EvalCase, signal?: AbortSignal) => Promise<TargetOutput>;

export interface CaseResult {
  id: string;
  question: string;
  tags: string[];
  /** 跑出错了就没有 output，有 error */
  output?: TargetOutput;
  error?: string;
  /** 耗时，单位毫秒 */
  ms: number;
}

export interface EvalRun {
  /** 这次评估的名字，比如 baseline、prompt-v2、deepseek */
  name: string;
  /** 开始的时间，ISO 格式 */
  startedAt: string;
  results: CaseResult[];
}

export interface RunEvalOptions {
  name?: string;
  /** 同时跑几条，默认 2。太多容易被限流，限流又会让耗时的数字不准 */
  concurrency?: number;
  /** 每跑完一条回调一次，用来显示进度 */
  onResult?: (result: CaseResult, done: number, total: number) => void;
  /** 当前时间（毫秒），测试时换成假的 */
  clock?: () => number;
  now?: () => Date;
  signal?: AbortSignal;
}

/**
 * 跑一遍评估。用 mapLimit 同时跑，最多 concurrency 条：
 * - 每条用例记下开始和结束的 clock()，ms 是两者之差
 * - target 抛出错误：不要让整次评估失败，记成这条用例的 error（错误的 message），没有 output。
 *   出错也是结果：一个改动让 3 条用例开始报错，正是评估要发现的
 * - 每跑完一条，onResult(结果, 已完成几条, 一共几条)
 * - results 的顺序和 cases 一样，不按完成的先后
 */
export async function runEval(cases: EvalCase[], target: Target, options: RunEvalOptions = {}): Promise<EvalRun> {
  const { name = 'run', concurrency = 2, onResult, clock = () => performance.now(), now = () => new Date(), signal } = options;
  const startedAt = now().toISOString();
  let done = 0;
  const settled = await mapLimit(
    cases,
    concurrency,
    async (c) => {
      const start = clock();
      const base = { id: c.id, question: c.question, tags: c.tags };
      let result: CaseResult;
      try {
        const output = await target(c, signal);
        result = { ...base, output, ms: clock() - start };
      } catch (error) {
        result = { ...base, error: (error as Error).message, ms: clock() - start };
      }
      onResult?.(result, ++done, cases.length);
      return result;
    },
    signal,
  );
  // mapLimit 在取消时，没开始的那些是 rejected
  const results = settled.map((r, i): CaseResult => (r.status === 'fulfilled' ? r.value : { id: cases[i].id, question: cases[i].question, tags: cases[i].tags, error: '没有执行', ms: 0 }));
  return { name, startedAt, results };
}

/** 说「没有查到」的几种常见写法。资料里没有答案的用例，回答里要有其中之一 */
export const NOT_FOUND = /没有查到|没查到|没有找到|没找到|查不到|找不到|无法确认|没有相关|未找到|未查到|没有提到|没有给出|没有公开/;

export interface CheckResult {
  pass: boolean;
  /** 没有出现的事实 */
  missing: string[];
  /** 出现了的禁止内容 */
  forbidden: string[];
  /** 没有引用到的来源 */
  missingSources: string[];
  /** unanswerable 的用例：回答有没有说没查到。不是 unanswerable 的用例总是 true */
  admitsUnknown: boolean;
}

/**
 * 用代码检查一条用例的期望（只看 facts、forbidden、sources、unanswerable，工具调用的检查在第 32 天）：
 * - missing：用第 21 天的 missingFacts 找出没出现的事实
 * - forbidden：回答里出现了的禁止内容（原样比较）
 * - missingSources：expected.sources 里，没有任何一个 cited 网址包含它的
 * - admitsUnknown：unanswerable 的用例，回答要匹配 NOT_FOUND
 * 四项都没问题才 pass。没有 output（出错了）一律不通过，missing 是全部的事实
 */
export function checkExpectations(c: EvalCase, output: TargetOutput | undefined): CheckResult {
  const { facts, forbidden, sources, unanswerable } = c.expected;
  if (!output) return { pass: false, missing: missingFacts('', facts), forbidden: [], missingSources: [...sources], admitsUnknown: !unanswerable };
  const missing = missingFacts(output.answer, facts);
  const found = forbidden.filter((f) => output.answer.includes(f));
  const missingSources = sources.filter((s) => !output.cited.some((url) => url.includes(s)));
  const admitsUnknown = !unanswerable || NOT_FOUND.test(output.answer);
  return { pass: !missing.length && !found.length && !missingSources.length && admitsUnknown, missing, forbidden: found, missingSources, admitsUnknown };
}

/** 一组用例的统计 */
export interface GroupSummary {
  /** 标签；整体是 all */
  group: string;
  total: number;
  passed: number;
  errors: number;
  /** 通过的比例，0 到 1 */
  passRate: number;
}

export interface RunSummary {
  overall: GroupSummary;
  /** 每个标签一组，按标签第一次出现的顺序 */
  byTag: GroupSummary[];
  /** 没通过的用例和原因 */
  failures: { id: string; reasons: string[] }[];
  usage: Usage;
  /** 耗时的中位数 */
  medianMs: number;
}

/** 没通过的原因，给人看 */
export function failureReasons(check: CheckResult, error?: string): string[] {
  if (error) return [`出错：${error}`];
  const reasons: string[] = [];
  if (check.missing.length) reasons.push(`缺少 ${check.missing.join('、')}`);
  if (check.forbidden.length) reasons.push(`出现了不该有的 ${check.forbidden.join('、')}`);
  if (check.missingSources.length) reasons.push(`没有引用 ${check.missingSources.join('、')}`);
  if (!check.admitsUnknown) reasons.push('资料里没有答案，但回答没有说没查到');
  return reasons;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 汇总一次评估：整体和每个标签的通过率、出错的条数，没通过的用例和原因，总用量和耗时的中位数。
 * cases 用来找到每条结果的期望（按 id 对上）
 */
export function summarizeRun(run: EvalRun, cases: EvalCase[]): RunSummary {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = run.results.map((r) => {
    const c = byId.get(r.id);
    if (!c) throw new Error(`评估结果里的 ${r.id} 不在评估集里`);
    return { result: r, check: checkExpectations(c, r.output) };
  });
  const group = (name: string, members: typeof rows): GroupSummary => {
    const passed = members.filter((m) => m.check.pass).length;
    return { group: name, total: members.length, passed, errors: members.filter((m) => m.result.error).length, passRate: members.length ? passed / members.length : 0 };
  };
  const tags = [...new Set(rows.flatMap((r) => r.result.tags))];
  return {
    overall: group('all', rows),
    byTag: tags.map((tag) => group(tag, rows.filter((r) => r.result.tags.includes(tag)))),
    failures: rows.filter((r) => !r.check.pass).map((r) => ({ id: r.result.id, reasons: failureReasons(r.check, r.result.error) })),
    usage: rows.reduce((sum, r) => addUsage(sum, r.result.output?.usage ?? emptyUsage()), emptyUsage()),
    medianMs: median(rows.map((r) => r.result.ms)),
  };
}

/** 汇总排成给人看的文字：一张表，加上没通过的用例 */
export function formatRunSummary(summary: RunSummary): string {
  const percent = (v: number) => `${Math.round(v * 100)}%`;
  const row = (g: GroupSummary) => `| ${g.group} | ${g.total} | ${g.passed} | ${percent(g.passRate)} | ${g.errors} |`;
  const lines = ['| 分组 | 条数 | 通过 | 通过率 | 出错 |', '|---|---|---|---|---|', row(summary.overall), ...summary.byTag.map(row)];
  if (summary.failures.length) {
    lines.push('', '没通过的：', ...summary.failures.map((f) => `- ${f.id}：${f.reasons.join('；')}`));
  }
  lines.push('', `耗时中位数 ${(summary.medianMs / 1000).toFixed(1)} 秒 · 输入 ${summary.usage.inputTokens} tokens · 输出 ${summary.usage.outputTokens} tokens`);
  return lines.join('\n');
}

/** 被安全策略拦下的工具调用，结果是这样开头的（第 37 天） */
const BLOCKED_PREFIX = '工具执行出错：这个调用被安全策略拦下了';

/** 从对话历史里按顺序找出所有的工具调用。参数解析不了就保留原来的字符串。第 37 天：被安全策略拦下的标上 blocked */
export function toolCallsOf(messages: Message[]): TargetOutput['toolCalls'] {
  const blocked = new Set(messages.flatMap((m) => (m.role === 'tool' && m.content.startsWith(BLOCKED_PREFIX) ? [m.tool_call_id] : [])));
  return messages.flatMap((m) =>
    m.role === 'assistant'
      ? (m.tool_calls ?? []).map((call) => {
          let args: unknown = call.function.arguments;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            // 保留原样
          }
          return { name: call.function.name, arguments: args, ...(blocked.has(call.id) ? { blocked: true } : {}) };
        })
      : [],
  );
}

/**
 * 把第 20 天的 research() 包成 target。每条用例都用一套新的配置（makeSetup）：
 * 工作目录、来源登记、记忆都是新的，用例之间互不影响，换个顺序跑结果也一样
 */
export function researchTarget(makeSetup: () => Promise<ResearchSetup>, model: Model, options: { now?: () => Date; maxSteps?: number } = {}): Target {
  return async (c, signal) => {
    const setup = await makeSetup();
    const r = await research(c.question, setup, { model, signal, ...options });
    return {
      answer: r.answer,
      usage: r.result.usage,
      toolCalls: toolCallsOf(r.result.messages),
      cited: r.report.cited.map((s) => s.url),
      citationProblems: r.report.problems,
      status: r.result.status,
    };
  };
}
