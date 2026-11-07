// 第 22 天：路由。不是每个问题都要走完整的研究流程：「你好」不用查资料，「我们的网关怎么回滚」只要查内部文档。
// 先用一个便宜的模型给问题分类，再按类别交给不同的 prompt、工具和模型：
//   chat     → 便宜的模型直接回答，不带工具
//   docs     → 便宜的模型，只带本地文档的工具
//   research → 强的模型，完整的研究助手（第 20 天）
// 运行：node days/day22/solution/router.ts "我们的网关怎么回滚？"
import { runAgent } from './agent.ts';
import { appendReferences, checkCitations, usedResearchTools } from './citations.ts';
import { formatQuestion } from './context.ts';
import { fulfilled, mapLimit, vote } from './parallel.ts';
import { dateSection } from './prompts.ts';
import { research, type ResearchSetup } from './research.ts';
import { createDocsTools } from './tools/docs.ts';
import type { Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';
import { createSourceRegistry } from './web.ts';

export const ROUTES = ['chat', 'docs', 'research'] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTER_PROMPT = `你负责给用户的问题分类，决定交给谁处理。只输出 JSON，格式是 {"route": "类别", "reason": "一句话理由"}，不要别的文字。

类别：
- chat：不用查资料就能回答：打招呼、常识和概念解释、翻译、改写、写作、简单计算
- docs：关于我们团队自己的潮汐网关，要查内部文档：部署、配置、值班、错误码、容量、证书
- research：要上网查：新近的事、具体的数据和价格、某个产品或协议的版本和变化、要对比多个来源

拿不准时选 research。`;

export const CHAT_PROMPT = '你是一个简洁友好的助手。直接回答用户的问题，篇幅和问题相称。不知道的就说不知道，不要编造具体的数据。';

export const DOCS_PROMPT = `你是潮汐网关的内部文档助手。用 search_docs、grep_docs、read_doc 查本地文档，根据文档回答。
- 每个结论后面用 [编号] 标明出自哪篇文档，编号用工具结果里给的
- 文档里没有的，直接说文档里没有写，不要猜
- 用中文回答，先给结论，再给依据`;

/** 拿不准、模型的输出解析不了时走哪条路。选最稳妥的：多花点钱，总比答错好 */
export const FALLBACK_ROUTE: Route = 'research';

/** 解析分类结果：优先按 JSON 解析；不是 JSON 时，文字里只提到一个类别也算。解析不了返回 undefined */
export function parseRoute(text: string): Route | undefined {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const route = (JSON.parse(json) as { route?: unknown })?.route;
    return ROUTES.includes(route as Route) ? (route as Route) : undefined;
  } catch {
    const mentioned = ROUTES.filter((route) => new RegExp(`\\b${route}\\b`).test(text));
    return mentioned.length === 1 ? mentioned[0] : undefined;
  }
}

export interface Classification {
  route: Route;
  /** 每次分类的结果（解析不了的不算） */
  votes: Route[];
  /** 得票最多的占几成。只分类一次时是 1 */
  agreement: number;
  /** 没有一次能解析，用了 FALLBACK_ROUTE */
  fallback: boolean;
  usage: Usage;
}

export interface ClassifyOptions {
  /** 分类几次，取多数。默认 1；设成 3，花三倍的钱换更稳定的结果 */
  votes?: number;
  signal?: AbortSignal;
}

/** 给问题分类。分类几次就同时发几个请求，再投票；全都解析不了就走 FALLBACK_ROUTE */
export async function classify(question: string, model: Model, options: ClassifyOptions = {}): Promise<Classification> {
  const { votes = 1, signal } = options;
  const request = {
    messages: [
      { role: 'system' as const, content: ROUTER_PROMPT },
      { role: 'user' as const, content: question },
    ],
    maxTokens: 200,
  };
  const results = fulfilled(await mapLimit(Array.from({ length: votes }), votes, () => model.chat(request, { signal }), signal));
  const usage = results.reduce((sum, r) => addUsage(sum, r.usage), emptyUsage());
  const routes = results.map((r) => parseRoute(r.message.content ?? '')).filter((r): r is Route => r !== undefined);
  const result = vote(routes);
  if (!result) return { route: FALLBACK_ROUTE, votes: [], agreement: 0, fallback: true, usage };
  return { route: result.winner, votes: routes, agreement: result.agreement, fallback: false, usage };
}

export interface RouterDeps {
  /** 分类用的模型：便宜、快就行 */
  router: Model;
  /** 回答简单问题、查本地文档用的模型 */
  cheap: Model;
  /** 做研究用的模型 */
  strong: Model;
  setup: ResearchSetup;
  votes?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface RoutedAnswer {
  route: Route;
  classification: Classification;
  /** 回答加上来源列表 */
  text: string;
  /** 回答用的是哪个模型 */
  model: string;
  /** 分类加上回答，一共的用量 */
  usage: Usage;
}

/** 先分类，再按类别回答。docs 类的问题，没有配置本地文档时改走 research */
export async function routeQuestion(question: string, deps: RouterDeps): Promise<RoutedAnswer> {
  const { router, cheap, strong, setup, votes, now = () => new Date(), signal } = deps;
  const classification = await classify(question, router, { votes, signal });
  let route = classification.route;
  if (route === 'docs' && !setup.docs) route = 'research';
  const dated = formatQuestion([dateSection(now())], question);

  if (route === 'chat') {
    const result = await cheap.chat(
      {
        messages: [
          { role: 'system', content: CHAT_PROMPT },
          { role: 'user', content: dated },
        ],
      },
      { signal },
    );
    return { route, classification, text: result.message.content ?? '', model: cheap.name, usage: addUsage(classification.usage, result.usage) };
  }

  if (route === 'docs') {
    const sources = setup.sources ?? createSourceRegistry();
    const result = await runAgent(dated, { model: cheap, tools: createDocsTools({ ...setup.docs!, sources }), system: DOCS_PROMPT, signal });
    const report = checkCitations(result.answer, sources, { researched: usedResearchTools(result.messages) });
    return { route, classification, text: appendReferences(result.answer, report.cited), model: cheap.name, usage: addUsage(classification.usage, result.usage) };
  }

  const { text, result } = await research(question, setup, { model: strong, now, signal });
  return { route, classification, text, model: strong.name, usage: addUsage(classification.usage, result.usage) };
}

export interface RouterEval {
  total: number;
  correct: number;
  /** correct / total。分类出错（抛出异常）的也算在 total 里 */
  accuracy: number;
  /** confusion[应该走的][实际走的] = 几个问题。一眼看出最容易把哪一类错分成哪一类 */
  confusion: Record<Route, Record<Route, number>>;
  /** 分错的问题。分类出错时 actual 是 error */
  mistakes: { question: string; expected: Route; actual: Route | 'error' }[];
}

/** 在一组标好答案的问题上评估分类器。问题之间互不相干，同时跑 concurrency 个 */
export async function evaluateRouter(
  cases: { question: string; route: Route }[],
  classifyFn: (question: string) => Promise<Route>,
  concurrency = 4,
): Promise<RouterEval> {
  const results = await mapLimit(cases, concurrency, (c) => classifyFn(c.question));
  const confusion = Object.fromEntries(ROUTES.map((e) => [e, Object.fromEntries(ROUTES.map((a) => [a, 0]))])) as RouterEval['confusion'];
  const mistakes: RouterEval['mistakes'] = [];
  results.forEach((result, i) => {
    const { question, route: expected } = cases[i];
    const actual = result.status === 'fulfilled' ? result.value : 'error';
    if (actual !== 'error') confusion[expected][actual]++;
    if (actual !== expected) mistakes.push({ question, expected, actual });
  });
  const correct = cases.length - mistakes.length;
  return { total: cases.length, correct, accuracy: cases.length ? correct / cases.length : 0, confusion, mistakes };
}

/** 把混淆矩阵排成表格：每一行是应该走的路，每一列是实际走的路 */
export function formatConfusion(confusion: RouterEval['confusion']): string {
  const header = `| 应该 \\ 实际 | ${ROUTES.join(' | ')} |`;
  const rows = ROUTES.map((expected) => `| ${expected} | ${ROUTES.map((actual) => confusion[expected][actual]).join(' | ')} |`);
  return [header, `|---|${ROUTES.map(() => '---').join('|')}|`, ...rows].join('\n');
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const { createCheapModel, createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { loadDocs } = await import('./docs-setup.ts');
  const { formatUsage } = await import('./usage.ts');
  const question = process.argv.slice(2).join(' ');
  if (!question) {
    console.error('用法：router.ts <问题>');
    process.exit(1);
  }
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  const cheap = createCheapModel();
  const answer = await routeQuestion(question, {
    router: cheap,
    cheap,
    strong: createModel(providerFromEnv()),
    setup: { workspace, search: searchProviderFromEnv(), docs: await loadDocs(process.env.DOCS_DIR) },
  });
  console.log(`（走 ${answer.route}，用 ${answer.model}）\n\n${answer.text}\n\n${formatUsage(answer.usage)}`);
}
