// 第 20 天：研究助手 v1。把第 11–19 天的成果组装在一起：
// 联网搜索和读网页（第 12 天）、MCP 服务器（第 13、14 天）、按预算组装上下文和压缩（第 15、16 天）、
// 本地文档检索（第 17、18 天）、记忆（第 19 天）。接到问题以后查资料、读来源、带引用作答。
// 运行（一次性回答一个问题）：node days/day20/solution/research.ts "潮汐协议 3.0 有什么变化？"
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts';
import { appendReferences, checkCitations, usedResearchTools, type CitationReport } from './citations.ts';
import { offloadLargeResults } from './compact.ts';
import { formatQuestion, type DynamicSection } from './context.ts';
import type { McpHost } from './mcp.ts';
import { memorySection, type MemoryStore } from './memory.ts';
import { dateSection, RESEARCH_PROMPT } from './prompts.ts';
import type { Retriever } from './rag/hybrid.ts';
import type { Reranker } from './rag/rerank.ts';
import type { SearchProvider } from './search.ts';
import type { Tool } from './tool.ts';
import { createDocsTools } from './tools/docs.ts';
import { createTools } from './tools/index.ts';
import { createMemoryTools } from './tools/memory.ts';
import type { Model } from './types.ts';
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
}

export interface ResearchTools {
  tools: Tool[];
  sources: SourceRegistry;
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
    ...(setup.memory ? createMemoryTools(setup.memory) : []),
    ...(setup.mcp?.tools ?? []),
  ];
  const seen = new Set<string>();
  const tools = all.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)));
  // 太长的工具结果写进 .context/results/，上下文里只放开头和文件的位置（第 16 天）
  return { tools: offloadLargeResults(tools, { workspace: setup.workspace }), sources };
}

export interface ResearchResult {
  result: AgentResult;
  /** 回答加上来源列表 */
  text: string;
  report: CitationReport;
  /** 这一轮有没有查资料 */
  researched: boolean;
}

export interface ResearchOptions extends Pick<AgentOptions, 'onText' | 'onToolCall' | 'confirm' | 'signal' | 'maxSteps'> {
  model: Model;
  now?: () => Date;
}

/** 回答一个研究问题：带上日期和记忆，查资料、作答，附上来源，检查引用的格式 */
export async function research(question: string, setup: ResearchSetup, options: ResearchOptions): Promise<ResearchResult> {
  const { model, now = () => new Date(), ...agentOptions } = options;
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
  const report = checkCitations(result.answer, sources, { researched });
  return { result, text: appendReferences(result.answer, report.cited), report, researched };
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
  const question = process.argv.slice(2).join(' ');
  if (!question) {
    console.error('用法：research.ts <问题>');
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
  const { text, report } = await research(question, setup, {
    model: createModel(providerFromEnv()),
    onToolCall: (call, r) => console.error(`${r.isError ? '✗' : '✓'} ${call.function.name} ${call.function.arguments}`),
  });
  console.log(`\n${text}`);
  if (!report.ok) console.log(`\n引用检查：\n${report.problems.map((p) => `- ${p}`).join('\n')}`);
}
