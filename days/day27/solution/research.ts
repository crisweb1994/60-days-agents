// 第 20 天：研究助手 v1。把第 11–19 天的成果组装在一起：
// 联网搜索和读网页（第 12 天）、MCP 服务器（第 13、14 天）、按预算组装上下文和压缩（第 15、16 天）、
// 本地文档检索（第 17、18 天）、记忆（第 19 天）。接到问题以后查资料、读来源、带引用作答。
// 第 23 天：可以带上计划工具 update_plan；planResearch() 先规划后执行，失败了重新规划。
// 第 24 天：research() 可以在回答以后核查引用，有问题就让模型改（verify.ts）。
// 第 25 天：可以带上 delegate_research，把子问题交给并行的子 Agent；orchestrate() 是主 Agent 加子 Agent 的研究。
// 第 27 天：可以带上浏览器工具，读要运行 JavaScript 才有内容的网页。
// 运行（一次性回答一个问题）：node days/day20/solution/research.ts "潮汐协议 3.0 有什么变化？"
// 用子 Agent（第 25 天）：node days/day25/solution/research.ts --subagents "对比潮汐协议 2.x 和 3.0 的性能和迁移成本"
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts';
import { createBrowserTools, type BrowserToolsOptions } from './browser.ts';
import { appendReferences, checkCitations, usedResearchTools, type CitationReport } from './citations.ts';
import { offloadLargeResults } from './compact.ts';
import { formatQuestion, type DynamicSection } from './context.ts';
import type { McpHost } from './mcp.ts';
import {
  createPlanTool,
  createStepExecutor,
  createSynthesizer,
  planAndExecute,
  stepTools,
  type PlanBoard,
  type PlanExecuteResult,
  type PlanStep,
} from './plan.ts';
import { memorySection, type MemoryStore } from './memory.ts';
import { dateSection, ORCHESTRATOR_PROMPT, RESEARCH_PROMPT } from './prompts.ts';
import { createDelegateTool, subagentTools, subagentUsage, type DelegateOptions, type SubagentResult } from './subagent.ts';
import { reviseUntilSupported, type ReviseResult } from './verify.ts';
import type { Retriever } from './rag/hybrid.ts';
import type { Reranker } from './rag/rerank.ts';
import type { SearchProvider } from './search.ts';
import type { Tool } from './tool.ts';
import { createDocsTools } from './tools/docs.ts';
import { createTools } from './tools/index.ts';
import { createMemoryTools } from './tools/memory.ts';
import type { Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';
import { createSourceRegistry, type FetchPageOptions, type SourceRegistry } from './web.ts';

export interface ResearchSetup {
  /** 读写文件的工具限制在这个目录里，大的工具结果也写在这里 */
  workspace: string;
  /** 搜索服务。没有就只能读给定的网址 */
  search?: SearchProvider;
  /** 本地文档：目录和建好的检索器。没有就不能查本地文档 */
  docs?: { root: string; retriever: Retriever; reranker?: Reranker };
  memory?: MemoryStore;
  mcp?: McpHost;
  /** 来源登记。一次会话共用一个，编号才能前后一致 */
  sources?: SourceRegistry;
  /** fetch_page 的选项，测试时用来允许访问本机 */
  fetchOptions?: Omit<FetchPageOptions, 'signal'>;
  /** 计划。有它就加上 update_plan 工具（第 23 天） */
  plan?: PlanBoard;
  /** 浏览器。有它就加上 browser_open 等四个工具（第 27 天） */
  browser?: Omit<BrowserToolsOptions, 'sources'>;
  /** 子 Agent。有它就加上 delegate_research 工具（第 25 天） */
  subagents?: Omit<DelegateOptions, 'tools'>;
}

export interface ResearchTools {
  tools: Tool[];
  sources: SourceRegistry;
  /** 派出过的子 Agent 的结果，用来算它们的用量。没有配置子 Agent 时是 undefined（第 25 天） */
  subagents?: readonly SubagentResult[];
}

/**
 * 组装研究助手的全部工具：计算、读写文件、HTTP、网页、本地文档、记忆，再加上 MCP 服务器的工具。
 * 网页和本地文档共用一个来源登记，回答里的编号统一。名字重复的工具只留第一个（内置的优先），免得模型不知道该用哪个
 */
export function createResearchTools(setup: ResearchSetup): ResearchTools {
  const sources = setup.sources ?? createSourceRegistry();
  const all = [
    ...createTools(setup.workspace, { search: setup.search, sources, fetchOptions: setup.fetchOptions }),
    ...(setup.docs ? createDocsTools({ ...setup.docs, sources }) : []),
    ...(setup.browser ? createBrowserTools({ ...setup.browser, sources }).tools : []),
    ...(setup.memory ? createMemoryTools(setup.memory) : []),
    ...(setup.plan ? [createPlanTool(setup.plan)] : []),
    ...(setup.mcp?.tools ?? []),
  ];
  const seen = new Set<string>();
  const tools = all.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)));
  // 太长的工具结果写进 .context/results/，上下文里只放开头和文件的位置（第 16 天）
  const offloaded = offloadLargeResults(tools, { workspace: setup.workspace });
  if (!setup.subagents) return { tools: offloaded, sources };
  // 子 Agent 和主 Agent 共用一个来源登记，它们交回的 [编号] 主 Agent 直接就能用（第 25 天）
  const delegate = createDelegateTool({ ...setup.subagents, tools: subagentTools(offloaded) });
  return { tools: [...offloaded, delegate.tool], sources, subagents: delegate.results };
}

export interface ResearchResult {
  result: AgentResult;
  /** 最终的回答。核查以后改过，就是改过的那一版（第 24 天） */
  answer: string;
  /** 回答加上来源列表 */
  text: string;
  report: CitationReport;
  /** 这一轮有没有查资料 */
  researched: boolean;
  /** 核查和修改的过程。没有要求核查、或者没有查资料时是 undefined（第 24 天） */
  verification?: ReviseResult;
}

export interface ResearchOptions extends Pick<AgentOptions, 'onText' | 'onToolCall' | 'confirm' | 'signal' | 'maxSteps'> {
  model: Model;
  now?: () => Date;
  /** 回答以后核查引用，有问题就改（第 24 天）。judge 是核查用的模型，默认和 model 一样 */
  verify?: { judge?: Model; maxRounds?: number };
}

/** 回答一个研究问题：带上日期和记忆，查资料、作答，附上来源，检查引用的格式 */
export async function research(question: string, setup: ResearchSetup, options: ResearchOptions): Promise<ResearchResult> {
  const { model, now = () => new Date(), verify, ...agentOptions } = options;
  const { tools, sources } = createResearchTools(setup);
  const dynamic: DynamicSection[] = [dateSection(now())];
  const remembered = setup.memory ? await memorySection(setup.memory) : undefined;
  if (remembered) dynamic.push(remembered);
  const result = await runAgent(formatQuestion(dynamic, question), {
    ...agentOptions,
    model,
    tools,
    system: RESEARCH_PROMPT,
    maxSteps: agentOptions.maxSteps ?? 15,
  });
  const researched = usedResearchTools(result.messages);
  const verification =
    verify && researched && result.status === 'completed'
      ? await reviseUntilSupported(question, result.answer, sources, { model, ...verify, signal: agentOptions.signal })
      : undefined;
  const answer = verification?.answer ?? result.answer;
  const report = checkCitations(answer, sources, { researched });
  return { result, answer, text: appendReferences(answer, report.cited), report, researched, verification };
}

export interface OrchestrateResult extends ResearchResult {
  subagents: SubagentResult[];
  /** 主 Agent、子 Agent 各自的用量和合计。result.usage 只有主 Agent 的 */
  usage: { main: Usage; subagents: Usage; total: Usage };
}

export interface OrchestrateOptions extends ResearchOptions, Pick<DelegateOptions, 'concurrency' | 'maxTasks' | 'onSubagent'> {
  /** 子 Agent 用的模型，默认和主 Agent 一样 */
  subModel?: Model;
}

/**
 * 第 25 天：主 Agent 加子 Agent 的研究。主 Agent 带着 delegate_research，可以把子问题同时交给子 Agent，再汇总它们的结论。
 * 子 Agent 的用量不在主 Agent 的 result.usage 里，要单独加上
 */
export async function orchestrate(question: string, setup: ResearchSetup, options: OrchestrateOptions): Promise<OrchestrateResult> {
  const { model, subModel = model, concurrency, maxTasks, onSubagent, now = () => new Date(), verify, ...agentOptions } = options;
  const { tools, sources, subagents = [] } = createResearchTools({ ...setup, subagents: { model: subModel, concurrency, maxTasks, onSubagent } });
  const result = await runAgent(formatQuestion([dateSection(now())], question), {
    ...agentOptions,
    model,
    tools,
    system: ORCHESTRATOR_PROMPT,
    maxSteps: agentOptions.maxSteps ?? 10,
  });
  const researched = usedResearchTools(result.messages);
  const verification =
    verify && researched && result.status === 'completed'
      ? await reviseUntilSupported(question, result.answer, sources, { model, ...verify, signal: agentOptions.signal })
      : undefined;
  const answer = verification?.answer ?? result.answer;
  const report = checkCitations(answer, sources, { researched });
  const sub = subagentUsage([...subagents]);
  const main = addUsage(result.usage, verification?.usage ?? emptyUsage());
  return {
    result,
    answer,
    text: appendReferences(answer, report.cited),
    report,
    researched,
    verification,
    subagents: [...subagents],
    usage: { main, subagents: sub, total: addUsage(main, sub) },
  };
}

export interface PlannedResearchResult extends PlanExecuteResult {
  /** 回答加上来源列表 */
  text: string;
  report: CitationReport;
}

/**
 * 第 23 天：先规划后执行的研究。计划由代码管：模型先列出步骤，每一步交给一个只看这一步的 Agent 去查，
 * 失败了就重新规划，最后汇总。所有步骤共用一个来源登记，汇总时的 [编号] 才对得上
 */
export async function planResearch(
  question: string,
  setup: ResearchSetup,
  options: { model: Model; onPlan?: (steps: PlanStep[]) => void; maxReplans?: number; signal?: AbortSignal },
): Promise<PlannedResearchResult> {
  const { model, ...rest } = options;
  const { tools, sources } = createResearchTools({ ...setup, plan: undefined });
  const result = await planAndExecute(question, {
    ...rest,
    planner: model,
    execute: createStepExecutor(model, stepTools(tools)),
    synthesize: createSynthesizer(model),
  });
  const report = checkCitations(result.answer, sources, { researched: result.done.length > 0 });
  return { ...result, text: appendReferences(result.answer, report.cited), report };
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { createMemoryStore } = await import('./memory.ts');
  const { loadDocs } = await import('./docs-setup.ts');
  const args = process.argv.slice(2);
  const withSubagents = args[0] === '--subagents';
  const question = (withSubagents ? args.slice(1) : args).join(' ');
  if (!question) {
    console.error('用法：research.ts [--subagents] <问题>');
    process.exit(1);
  }
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  const setup: ResearchSetup = {
    workspace,
    search: searchProviderFromEnv(),
    docs: await loadDocs(process.env.DOCS_DIR),
    memory: createMemoryStore(resolve(workspace, '.mini-agent', 'memory')),
  };
  const onToolCall: AgentOptions['onToolCall'] = (call, r) => console.error(`${r.isError ? '✗' : '✓'} ${call.function.name} ${call.function.arguments}`);
  const model = createModel(providerFromEnv());
  let text: string;
  let report: CitationReport;
  if (withSubagents) {
    const { formatUsage } = await import('./usage.ts');
    const result = await orchestrate(question, setup, {
      model,
      onToolCall,
      onSubagent: (e) => console.error(e.type === 'start' ? `↳ 子 Agent ${e.index + 1}：${e.task.question}` : `↳ 子 Agent ${e.index + 1} 完成（${e.result.steps} 步，${e.result.toolCalls} 次工具调用）`),
    });
    ({ text, report } = result);
    console.error(`\n主 Agent：${formatUsage(result.usage.main)}\n子 Agent：${formatUsage(result.usage.subagents)}`);
  } else {
    ({ text, report } = await research(question, setup, { model, onToolCall }));
  }
  console.log(`\n${text}`);
  if (!report.ok) console.log(`\n引用检查：\n${report.problems.map((p) => `- ${p}`).join('\n')}`);
}
