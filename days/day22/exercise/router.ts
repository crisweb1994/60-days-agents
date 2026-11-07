// 第 22 天：路由。不是每个问题都要走完整的研究流程：「你好」不用查资料，「我们的网关怎么回滚」只要查内部文档。
// 先用一个便宜的模型给问题分类，再按类别交给不同的 prompt、工具和模型：
//   chat     → 便宜的模型直接回答，不带工具
//   docs     → 便宜的模型，只带本地文档的工具
//   research → 强的模型，完整的研究助手（第 20 天）
// 第 22 天的练习：TODO 3–5 在这里。检查：npm run check 22
// 运行：node days/day22/exercise/router.ts "我们的网关怎么回滚？"
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
  // TODO 3（一）：
  // - 去掉首尾空白和外面的 ```json ```，按 JSON 解析，取 route 字段；它是 ROUTES 里的一个才算数
  // - 不是 JSON 时，看文字里提到了哪几个类别（按单词匹配，比如 /\bdocs\b/）：只提到一个就是它，提到好几个就当解析不了
  void text;
  return undefined;
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
  // TODO 3（二）：
  // - 用 mapLimit 同时发出 votes 个同样的请求（上面的 request），用 fulfilled 只留成功的；把它们的用量累加起来
  // - 每个回复用 parseRoute 解析，解析不了的扔掉，剩下的用 vote 投票
  // - 一票都没有：route 是 FALLBACK_ROUTE，votes 是空数组，agreement 是 0，fallback 是 true
  void fulfilled;
  void mapLimit;
  void vote;
  void addUsage;
  void emptyUsage;
  throw new Error(`TODO 3：还没有实现 classify()（${model.name}，${votes} 次，${request.messages.length}，${Boolean(signal)}）`);
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
  // TODO 4：按 classification.route 分三条路走，每条路的 usage 都要加上分类的用量（addUsage）：
  // - 分到 docs 但 setup.docs 不存在，改走 research
  // - chat：cheap.chat，system 是 CHAT_PROMPT，user 是带日期的问题：formatQuestion([dateSection(now())], question)；不带工具
  // - docs：用 cheap 模型 runAgent，工具只有 createDocsTools({ ...setup.docs, sources })（sources 用 setup.sources，没有就新建），
  //   system 是 DOCS_PROMPT，问题也带上日期。用 checkCitations 检查引用（researched 用 usedResearchTools 判断），appendReferences 附上来源
  // - research：research(question, setup, { model: strong, now, signal })
  // model 字段写回答用的模型的 name
  void CHAT_PROMPT;
  void DOCS_PROMPT;
  void formatQuestion;
  void dateSection;
  void runAgent;
  void createDocsTools;
  void createSourceRegistry;
  void checkCitations;
  void usedResearchTools;
  void appendReferences;
  void cheap;
  const route: Route = 'research';
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
  // TODO 5：
  // - 用 mapLimit 同时分类，同时最多 concurrency 个
  // - confusion 先把 3×3 的每一格都填上 0，再按「应该走的、实际走的」计数；分类出错（rejected）的不计入混淆矩阵
  // - 分错的、出错的都放进 mistakes，出错的 actual 写 'error'，顺序和 cases 一致
  // - accuracy = 分对的个数 / 总数（总数为 0 时是 0）
  void classifyFn;
  void concurrency;
  throw new Error(`TODO 5：还没有实现 evaluateRouter()（${cases.length} 个问题）`);
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
