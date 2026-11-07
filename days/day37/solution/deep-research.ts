// 第 30 天：研究助手 v2，深度研究。把第 21–29 天的成果组装成一条完整的流程：
//   1. 规划：把问题拆成几个子问题（第 23 天）
//   2. 确认：计划先给用户看，用户可以改、可以取消（第 29 天）
//   3. 调研：每个子问题派一个子 Agent，同时去查（第 22、25 天）
//   4. 写报告：根据子 Agent 交回的结论，写一份结构化的报告（第 21 天的「资料在前、问题在后」）
//   5. 核查：逐句对照来源，有问题就改（第 24 天）
// 第 35 天：可以设总时间预算：到点了就用已经查到的写报告，来不及核查就跳过（优雅降级）；可以用检查点，中途失败了重新运行只做没做完的。
// 第 34 天：可以传入 tracer，整次深度研究是一棵 trace：每一步一个 span，每个子 Agent 一个 invoke_agent span。
// 骨架是固定流程（第 21 天）：哪一步做什么由代码决定；只在调研这一步，让子 Agent 自己决定怎么查。
// 运行：node days/day30/solution/deep-research.ts "潮汐协议 3.0 值得升级吗？"
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Checkpoint } from './checkpoint.ts';
import { sanitizeAnswer } from './injection.ts';
import { createDeadline } from './deadline.ts';
import { appendReferences, checkCitations, type CitationReport } from './citations.ts';
import { formatQuestion } from './context.ts';
import { mapLimit } from './parallel.ts';
import { parseSteps } from './plan.ts';
import { dateSection } from './prompts.ts';
import { createResearchTools, type ResearchSetup } from './research.ts';
import { runSubagent, subagentTools, subagentUsage, type SubagentResult } from './subagent.ts';
import { traceAgent, traceModel, traceTools, type Tracer } from './trace.ts';
import type { Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';
import { reviseUntilSupported, type ReviseResult } from './verify.ts';

export const DEEP_PLAN_PROMPT = `你负责为一个深度研究问题制定调研计划：把它拆成几个可以同时、独立调研的子问题。
只输出 JSON，格式是 {"steps": ["子问题1", "子问题2"]}，不要别的文字。
- 2 到 5 个子问题，每个都写得具体、能独立理解：调研它的人看不到原来的问题，也看不到别的子问题
- 子问题之间不要重叠，合起来要能回答原来的问题
- 不要写「汇总」「写报告」这样的子问题，最后会统一写报告`;

export const REPORT_PROMPT = `你是研究助手，负责根据各个子问题的调研结论，写一份研究报告。用户消息里先是调研结论，最后是研究的问题。
报告用 Markdown，结构是：
# 标题（一句话概括问题）

## 结论
三到五句话，直接回答问题。

## 分析
按子问题分小节（### 小标题），写清楚依据。

## 没有查到的
哪些信息没有查到、哪些结论不确定。都查到了就写「无」。

要求：
- 只用调研结论里的信息。每个事实后面保留结论里的 [编号]，写在句子末尾；不要编造编号，不要列来源清单，程序会自动附上
- 不同来源说法不一致时，把两种说法都写出来，并说明各自的来源
- 用中文，不要客套话`;

/** 最多几个子问题 */
export const MAX_SUBQUESTIONS = 5;

export interface ResearchPlan {
  question: string;
  subquestions: string[];
  /** 模型没有给出合格的计划，退回成「问题本身就是唯一的子问题」 */
  fallback: boolean;
}

/** 用户对计划的答复：照着做；改成这几个子问题再做；或者取消 */
export type PlanReview = { action: 'approve' } | { action: 'edit'; subquestions: string[] } | { action: 'cancel'; reason?: string };

/** 解析模型给的计划。格式不对、一个子问题都没有，就把问题本身当作唯一的子问题；最多 MAX_SUBQUESTIONS 个 */
export function parsePlan(question: string, text: string): ResearchPlan {
  const steps = parseSteps(text, MAX_SUBQUESTIONS);
  if (!steps?.length) return { question, subquestions: [question], fallback: true };
  return { question, subquestions: steps, fallback: false };
}

/**
 * 按用户的答复调整计划。返回要调研的子问题，取消时返回 undefined。
 * 用户改过的子问题同样去掉空的、最多 MAX_SUBQUESTIONS 个；改完一个都不剩，就当作取消
 */
export function applyReview(plan: ResearchPlan, review: PlanReview): string[] | undefined {
  if (review.action === 'cancel') return undefined;
  if (review.action === 'approve') return plan.subquestions;
  const edited = review.subquestions.map((s) => s.trim()).filter(Boolean).slice(0, MAX_SUBQUESTIONS);
  return edited.length ? edited : undefined;
}

/** 调研结论排成一段文字，交给写报告的模型 */
export function formatFindingsForReport(findings: SubagentResult[]): string {
  return findings
    .map((f, i) => {
      const note = f.status === 'completed' ? '' : `（这个子问题没有查完：${f.status}）`;
      return `## 子问题 ${i + 1}：${f.task.question}${note}\n${f.findings || '（没有结论）'}`;
    })
    .join('\n\n');
}

/** 深度研究进行到哪一步了，用来给用户显示进度 */
export type DeepResearchEvent =
  | { type: 'plan'; plan: ResearchPlan }
  | { type: 'investigate'; subquestions: string[] }
  | { type: 'subagent'; index: number; result: SubagentResult }
  | { type: 'report' }
  | { type: 'verify'; result: ReviseResult };

export interface DeepResearchOptions {
  model: Model;
  /** 子 Agent 用的模型，默认和 model 一样 */
  subModel?: Model;
  /** 计划给用户确认。不传就直接照着做 */
  review?: (plan: ResearchPlan) => Promise<PlanReview>;
  /** 同时最多几个子 Agent，默认 3 */
  concurrency?: number;
  /** 每个子 Agent 最多调用几次模型，默认 8 */
  subagentSteps?: number;
  /** 写完报告以后核查几轮，默认 1；0 表示不核查 */
  verifyRounds?: number;
  onEvent?: (event: DeepResearchEvent) => void;
  now?: () => Date;
  signal?: AbortSignal;
  /** 追踪（第 34 天） */
  tracer?: Tracer;
  /** 总时间预算，毫秒（第 35 天）。到点了还没查完的子问题就不等了 */
  timeBudgetMs?: number;
  /** 留给写报告和核查的时间，默认是预算的 40%。调研只能用剩下的（第 35 天） */
  reserveMs?: number;
  /** 检查点：每做完一步存下结果，重新运行时跳过做过的（第 35 天） */
  checkpoint?: Checkpoint;
}

/** 每一步的用量，最后一项是合计 */
export interface DeepResearchUsage {
  plan: Usage;
  subagents: Usage;
  report: Usage;
  verify: Usage;
  total: Usage;
}

export interface DeepResearchResult {
  status: 'completed' | 'cancelled';
  plan: ResearchPlan;
  /** 实际调研的子问题（用户可能改过） */
  subquestions: string[];
  findings: SubagentResult[];
  /** 报告（核查改过的话就是改过的那一版），不带来源列表 */
  report: string;
  /** 报告加上来源列表 */
  text: string;
  citations: CitationReport;
  verification?: ReviseResult;
  usage: DeepResearchUsage;
  /** 为了赶时间放弃了什么，比如「子问题 2 超时，没有查完」。什么都没放弃是空数组（第 35 天） */
  degraded: string[];
}

/** 第一步：把问题拆成子问题 */
export async function makeResearchPlan(question: string, model: Model, signal?: AbortSignal): Promise<{ plan: ResearchPlan; usage: Usage }> {
  const result = await model.chat(
    {
      messages: [
        { role: 'system', content: DEEP_PLAN_PROMPT },
        { role: 'user', content: question },
      ],
    },
    { signal },
  );
  return { plan: parsePlan(question, result.message.content ?? ''), usage: result.usage };
}

/** 第四步：根据调研结论写报告。资料在前、问题在后 */
export async function writeReport(question: string, findings: SubagentResult[], model: Model, now: Date, signal?: AbortSignal): Promise<{ report: string; usage: Usage }> {
  const content = formatQuestion([dateSection(now)], `调研结论：\n\n${formatFindingsForReport(findings)}\n\n研究的问题：${question}`);
  const result = await model.chat(
    {
      messages: [
        { role: 'system', content: REPORT_PROMPT },
        { role: 'user', content },
      ],
    },
    { signal },
  );
  return { report: (result.message.content ?? '').trim(), usage: result.usage };
}

/** 深度研究：规划 → 确认 → 并行调研 → 写报告 → 核查 */
export async function deepResearch(question: string, setup: ResearchSetup, options: DeepResearchOptions): Promise<DeepResearchResult> {
  const { tracer } = options;
  if (!tracer) return deepResearchOnce(question, setup, options);
  const traced = { ...options, model: traceModel(options.model, tracer), subModel: options.subModel && traceModel(options.subModel, tracer) };
  return traceAgent(tracer, 'deep_research', () => deepResearchOnce(question, setup, traced));
}

async function deepResearchOnce(question: string, setup: ResearchSetup, options: DeepResearchOptions): Promise<DeepResearchResult> {
  const { model, subModel = model, review, concurrency = 3, subagentSteps = 8, verifyRounds = 1, onEvent, now = () => new Date(), tracer, timeBudgetMs, checkpoint } = options;
  // 第 35 天：总时间预算。overall 是整件事的期限（加上用户的取消），调研只能用到「期限减去留给报告的时间」
  const deadline = timeBudgetMs === undefined ? undefined : createDeadline(timeBudgetMs);
  const reserve = options.reserveMs ?? Math.round((timeBudgetMs ?? 0) * 0.4);
  const signal = deadline ? (options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal) : options.signal;
  const degraded: string[] = [];
  /** 有检查点时，做过的步骤直接拿存下的结果 */
  const saved = <T>(key: string, fn: () => Promise<T>): Promise<T> => (checkpoint ? checkpoint.step(key, fn) : fn());
  const usage: DeepResearchUsage = { plan: emptyUsage(), subagents: emptyUsage(), report: emptyUsage(), verify: emptyUsage(), total: emptyUsage() };
  // 所有子 Agent 共用一个来源登记：报告里的 [编号] 才对得上，核查时也能找到每个来源读到的内容
  const created = createResearchTools({ ...setup, plan: undefined, subagents: undefined, askUser: false });
  const tools = tracer ? traceTools(created.tools, tracer) : created.tools;
  const sources = created.sources;
  created.guard?.trustText(question);
  /** 有 tracer 时，把一步包成一个 span */
  const step = <T>(name: string, fn: () => Promise<T>): Promise<T> => (tracer ? tracer.withSpan(name, {}, () => fn()) : fn());

  const planned = await saved('plan', () => step('plan', () => makeResearchPlan(question, model, signal)));
  usage.plan = planned.usage;
  const plan = planned.plan;
  onEvent?.({ type: 'plan', plan });

  // 用户确认过的计划也存进检查点：重新运行时不用再问一遍
  let subquestions = checkpoint?.get<string[]>('subquestions');
  if (!subquestions) {
    subquestions = review ? applyReview(plan, await review(plan)) : plan.subquestions;
    if (subquestions) await checkpoint?.set('subquestions', subquestions);
  }
  const total = () => ({ ...usage, total: [usage.plan, usage.subagents, usage.report, usage.verify].reduce(addUsage, emptyUsage()) });
  if (!subquestions) {
    return { status: 'cancelled', plan, subquestions: [], findings: [], report: '', text: '', citations: { ok: true, cited: [], problems: [] }, usage: total(), degraded };
  }
  onEvent?.({ type: 'investigate', subquestions });

  const context = `这是研究「${question}」的一部分`;
  const investigateSignal = deadline ? AbortSignal.any([signal!, deadline.within(deadline.remaining() - reserve)]) : signal;
  const settled = await step('investigate', () =>
    mapLimit(
      subquestions,
      concurrency,
      async (sub, index) => {
        // 检查点：查完了的子问题不再查。出错的不存，下次还要再查
        const key = `subagent:${index}:${sub}`;
        const done = checkpoint?.get<SubagentResult>(key);
        if (done) return done;
        const result = await traceAgent(tracer, 'subagent', () => runSubagent({ question: sub, context }, { model: subModel, tools: subagentTools(tools), maxSteps: subagentSteps, signal: investigateSignal }), {
          'research.subquestion': sub,
        });
        if (result.status !== 'error') await checkpoint?.set(key, result);
        onEvent?.({ type: 'subagent', index, result });
        return result;
      },
      investigateSignal,
    ),
  );
  // 时间到了（不是用户取消）：没查完的子问题注明，用已经有的结论接着写报告
  const timedOut = investigateSignal?.aborted && !options.signal?.aborted;
  const findings = settled.map((r, i): SubagentResult => {
    const result: SubagentResult =
      r.status === 'fulfilled'
        ? r.value
        : { task: { question: subquestions[i], context }, status: 'error', findings: '（没有执行）', usage: emptyUsage(), steps: 0, toolCalls: 0 };
    if (timedOut && result.status === 'error') {
      degraded.push(`子问题 ${i + 1} 超时，没有查完`);
      return { ...result, findings: '（时间预算用完了，没有查完）' };
    }
    return result;
  });
  usage.subagents = subagentUsage(findings);

  onEvent?.({ type: 'report' });
  const written = await saved('report', () => step('report', () => writeReport(question, findings, model, now(), signal)));
  usage.report = written.usage;

  let report = written.report;
  let verification: ReviseResult | undefined;
  if (verifyRounds > 0 && deadline && deadline.remaining() < reserve / 2) {
    // 剩下的时间不到留出来的一半：核查多半做不完，跳过，先把报告交出去
    degraded.push('时间不够，跳过了核查');
  } else if (verifyRounds > 0) {
    try {
      verification = await step('verify', () => reviseUntilSupported(question, report, sources, { model, maxRounds: verifyRounds, signal }));
      usage.verify = verification.usage;
      report = verification.answer;
      onEvent?.({ type: 'verify', result: verification });
    } catch (error) {
      // 核查做到一半时间到了：交出没核查过的报告，而不是什么都不交
      if (!deadline?.signal.aborted || options.signal?.aborted) throw error;
      verification = undefined;
      degraded.push('核查超时，报告没有核查完');
    }
  }

  // 报告里不明来源的图片和链接去掉（第 37 天）
  if (created.guard) report = sanitizeAnswer(report, sources).text;
  const citations = checkCitations(report, sources, { researched: true });
  return { status: 'completed', plan, subquestions, findings, report, text: appendReferences(report, citations.cited), citations, verification, usage: total(), degraded };
}

/** 报告存进工作目录的 reports/ 下面，文件名是日期加上问题的开头。返回文件的路径 */
export async function saveReport(workspace: string, question: string, text: string, now = new Date()): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug = question.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'report';
  const dir = join(workspace, 'reports');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stamp}-${slug}.md`);
  await writeFile(path, `${text}\n`);
  return path;
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { createInterface } = await import('node:readline/promises');
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { loadDocs } = await import('./docs-setup.ts');
  const { formatUsage } = await import('./usage.ts');
  const question = process.argv.slice(2).join(' ');
  if (!question) {
    console.error('用法：deep-research.ts <问题>');
    process.exit(1);
  }
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const result = await deepResearch(question, { workspace, search: searchProviderFromEnv(), docs: await loadDocs(process.env.DOCS_DIR) }, {
    model: createModel(providerFromEnv()),
    review: async (plan) => {
      console.log(`\n计划：\n${plan.subquestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
      const answer = (await rl.question('回车开始；输入新的子问题（用 ; 分隔）修改；输入 n 取消 > ')).trim();
      if (answer === '') return { action: 'approve' };
      if (answer.toLowerCase() === 'n') return { action: 'cancel' };
      return { action: 'edit', subquestions: answer.split(/[;；]/) };
    },
    onEvent: (e) => {
      if (e.type === 'subagent') console.error(`↳ 子问题 ${e.index + 1} ${e.result.status === 'completed' ? '查完了' : `没有查完（${e.result.status}）`}`);
      if (e.type === 'report') console.error('· 写报告');
      if (e.type === 'verify') console.error(`· 核查：${e.result.reports.at(-1)!.problems.length} 处问题（${e.result.stopped}）`);
    },
  });
  rl.close();
  if (result.status === 'cancelled') {
    console.log('已取消');
  } else {
    const path = await saveReport(workspace, question, result.text);
    console.log(`\n${result.text}\n\n报告已保存：${path}\n${formatUsage(result.usage.total)}`);
  }
}
