// 第 40 天：研究助手服务。把第 31–39 天的成果包成一个别人能调用的 HTTP 服务：
//   鉴权：每个调用方一个 API Key，比较时用固定时间的比较
//   请求：限制大小、校验格式，错了就用 4xx 说清楚
//   研究：输入护栏 → research() 或 deepResearch() → 输出护栏 → 生成内容标识（第 39 天）
//         模型包上预算（第 36 天）和时间预算（第 35 天），整次请求是一棵 trace（第 34 天），注入防护默认开启（第 37 天）
//   并发：同时最多跑几个研究，满了就 429，不排长队
//   两种调法：POST /v1/research 等结果；POST /v1/runs 先拿到编号，再用 GET /v1/runs/:id 查（第 45 天换成真正的队列）
// 只用 node:http，不引入 Web 框架：今天关心的是一个服务要做哪些事，而不是哪个框架的写法。
// 运行：SERVICE_API_KEYS=dev-key:me node days/day40/solution/service.ts
//      curl -H 'Authorization: Bearer dev-key' -H 'Content-Type: application/json' -d '{"question":"潮汐协议 3.0 的默认端口是多少？"}' localhost:8787/v1/research
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { describeStatus } from './agent.ts';
import { addExplicitLabel } from './compliance.ts';
import { BudgetExceededError, createLedger, withBudget, type Budget } from './cost.ts';
import { deepResearch } from './deep-research.ts';
import { toolCallsOf } from './eval/run.ts';
import { lengthGuard, piiGuard, runGuarded, type GuardEvent, type GuardedOptions } from './guardrails.ts';
import { research, type ResearchSetup } from './research.ts';
import { createTracer, type SpanExporter, type Tracer } from './trace.ts';
import type { ChatOptions, ChatRequest, Model } from './types.ts';
import { addUsage, calcCost, emptyUsage, type Price, type Usage } from './usage.ts';

/** 带着 HTTP 状态码的错误：路由里抛出它，handle 会原样转成响应 */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

export interface ServiceUser {
  id: string;
  name?: string;
}

// ---------- 鉴权 ----------

const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** 把 API Key 表预先算成哈希。内存里不留明文，比较时两边长度也一样 */
export function hashApiKeys(apiKeys: Record<string, ServiceUser>): { hash: Buffer; user: ServiceUser }[] {
  return Object.entries(apiKeys).map(([key, user]) => ({ hash: sha256(key), user }));
}

/**
 * 从 Authorization 头里认出调用方。格式是 Bearer <key>，Bearer 不分大小写。
 * 比较用 timingSafeEqual，而且每一个 key 都比一遍，不提前退出：比较花的时间不能透露 key 的内容和位置
 */
export function authenticate(header: string | undefined, keys: { hash: Buffer; user: ServiceUser }[]): ServiceUser | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match) return undefined;
  const hash = sha256(match[1]);
  let found: ServiceUser | undefined;
  for (const entry of keys) {
    if (timingSafeEqual(entry.hash, hash)) found = entry.user;
  }
  return found;
}

// ---------- 请求体 ----------

/**
 * 读出 JSON 请求体。Content-Type 不是 JSON 是 415；超过 maxBytes 是 413（读到超了就停，不把整个请求体读进内存）；
 * 解析不了是 400
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '请求体要是 JSON，请加上 Content-Type: application/json');
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new HttpError(413, `请求体太大了，最多 ${maxBytes} 字节`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, `请求体太大了，最多 ${maxBytes} 字节`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
}

export const ResearchRequestSchema = z.strictObject({
  question: z.string().trim().min(1, '问题不能是空的'),
  /** quick：一个 Agent 查资料作答（第 20 天）；deep：规划、并行子 Agent、写报告（第 30 天） */
  mode: z.enum(['quick', 'deep']).default('quick'),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

/** 校验请求体。不对就是 400，错误信息写明是哪个字段、错在哪；多余的字段也算错（多半是拼错了） */
export function parseResearchRequest(body: unknown): ResearchRequest {
  const parsed = ResearchRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue.path.length ? issue.path.join('.') : '请求体';
  throw new HttpError(400, `参数不对：${field}：${issue.message}`);
}

// ---------- 并发 ----------

export interface Limiter {
  /** 还有空位就占一个，返回 true；满了返回 false，不等待 */
  tryAcquire(): boolean;
  release(): void;
  active(): number;
}

/** 同时最多 max 个。满了直接拒绝（429），而不是排队：研究一次要几分钟，排在后面的请求多半等到超时 */
export function createLimiter(max: number): Limiter {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return false;
      active++;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
    },
    active: () => active,
  };
}

// ---------- 研究 ----------

/** 包一层模型，把每次调用的用量加起来：一次请求花了多少，要写进响应 */
export function meterModel(model: Model): { model: Model; usage: () => Usage } {
  let total = emptyUsage();
  return {
    model: {
      name: model.name,
      async chat(request: ChatRequest, options?: ChatOptions) {
        const result = await model.chat(request, options);
        total = addUsage(total, result.usage);
        return result;
      },
    },
    usage: () => total,
  };
}

export interface ServiceResult {
  id: string;
  /** answered：正常回答；blocked：被护栏拦下；fallback：出了问题，给的是兜底的答复（第 39 天） */
  status: 'answered' | 'blocked' | 'fallback';
  mode: ResearchRequest['mode'];
  /** 交给用户的文字：回答、来源列表、生成内容的标识 */
  text: string;
  /** 回答引用到的来源 */
  sources: { id: number; url: string; title: string }[];
  /** 调用过的工具，界面画进度、评估看轨迹都用得到（deep 模式是空的） */
  toolCalls: { name: string; arguments: unknown; blocked?: boolean }[];
  /** 引用检查发现的问题 */
  citationProblems: string[];
  /** 研究为什么停下：completed、max_steps……被拦下、出错时没有 */
  researchStatus?: string;
  /** 为了赶时间放弃了什么（deep 模式，第 35 天） */
  degraded: string[];
  usage: Usage;
  /** 花了多少元。配置了单价才有 */
  cost?: number;
  traceId?: string;
  /** 护栏改过、拦下的记录 */
  guardEvents: GuardEvent[];
  /** 出错时的原始错误。只进日志，handle 不会把它写进响应 */
  error?: string;
}

export interface RunContext {
  setup: ResearchSetup;
  model: Model;
  guards: GuardedOptions;
  /** 这次任务的预算（上级是这个用户今天的预算） */
  budget?: Budget;
  tracer?: Tracer;
  /** 整次研究最多多久，毫秒 */
  timeBudgetMs: number;
  price?: Price;
  /** 调用方断开、或者用户取消 */
  signal?: AbortSignal;
  id?: string;
}

/**
 * 跑一次研究请求：
 * - 模型先包预算（有 budget 时），再包 meterModel 记用量
 * - quick：research()，信号是「时间预算」和 ctx.signal 合在一起；deep：deepResearch()，时间预算交给它自己管（它会优雅降级）
 * - 用 runGuarded 包住：输入护栏 → 研究 → 输出护栏；正常回答的加上显式标识
 * - 研究没完成又一个字都没答出来，当作出错（兜底）；答了一半的，后面注明原因
 * - 有 tracer 时，整件事包在一个 span 里，traceId 写进结果
 */
export async function runResearchRequest(request: ResearchRequest, ctx: RunContext): Promise<ServiceResult> {
  const { setup, guards, budget, tracer, timeBudgetMs, price, signal } = ctx;
  const id = ctx.id ?? randomUUID();
  const meter = meterModel(budget ? withBudget(ctx.model, budget) : ctx.model);
  let captured: Pick<ServiceResult, 'sources' | 'toolCalls' | 'citationProblems' | 'researchStatus' | 'degraded'> | undefined;

  const handler = async (question: string): Promise<string> => {
    if (request.mode === 'deep') {
      const r = await deepResearch(question, setup, { model: meter.model, tracer, timeBudgetMs, signal });
      if (r.status === 'cancelled') throw new Error('深度研究被取消了');
      captured = { sources: r.citations.cited, toolCalls: [], citationProblems: r.citations.problems, researchStatus: r.status, degraded: r.degraded };
      return r.text;
    }
    const deadline = AbortSignal.timeout(timeBudgetMs);
    const r = await research(question, setup, { model: meter.model, tracer, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    captured = { sources: r.report.cited, toolCalls: toolCallsOf(r.result.messages), citationProblems: r.report.problems, researchStatus: r.result.status, degraded: [] };
    if (r.result.status !== 'completed' && !r.answer.trim()) throw new Error(`研究没有完成：${describeStatus(r.result)}`);
    return r.result.status === 'completed' ? r.text : `${r.text}\n\n（${describeStatus(r.result)}）`;
  };

  const run = async (traceId?: string): Promise<ServiceResult> => {
    const g = await runGuarded(request.question, handler, { ...guards, signal });
    const usage = meter.usage();
    return {
      id,
      status: g.status,
      mode: request.mode,
      text: g.status === 'answered' ? addExplicitLabel(g.text) : g.text,
      sources: (captured?.sources ?? []).map(({ id: n, url, title }) => ({ id: n, url, title })),
      toolCalls: captured?.toolCalls ?? [],
      citationProblems: captured?.citationProblems ?? [],
      ...(captured?.researchStatus ? { researchStatus: captured.researchStatus } : {}),
      degraded: captured?.degraded ?? [],
      usage,
      ...(price ? { cost: calcCost(usage, price) } : {}),
      ...(traceId ? { traceId } : {}),
      guardEvents: g.events,
      ...(g.error ? { error: g.error } : {}),
    };
  };

  if (!tracer) return run();
  return tracer.withSpan('research_request', { 'request.id': id, 'research.mode': request.mode }, async (span) => {
    const result = await run(span.span.traceId);
    span.setAttributes({ 'request.status': result.status });
    if (result.error) span.recordError(new Error(result.error));
    return result;
  });
}

// ---------- 服务 ----------

export interface LogEntry {
  time: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  userId?: string;
  traceId?: string;
  /** 研究的结果：answered、blocked、fallback */
  outcome?: string;
  guardEvents?: GuardEvent[];
  /** 内部的错误信息：只进日志，不给调用方看 */
  error?: string;
}

export interface RunRecord {
  id: string;
  userId: string;
  status: 'running' | 'done' | 'failed';
  createdAt: string;
  result?: ServiceResult;
}

export interface ServiceOptions {
  /** API Key → 调用方 */
  apiKeys: Record<string, ServiceUser>;
  model: Model;
  /** 每次请求一套新的研究配置：工作目录、来源登记、记忆。按用户分开，第 46 天再换成数据库 */
  makeSetup: (user: ServiceUser) => Promise<ResearchSetup>;
  /** 护栏。默认是长度和脱敏（不需要额外的模型）；要内容审核就传 defaultGuards(审核模型) */
  guards?: GuardedOptions;
  /** 按用户、按天的预算（第 36 天）。不传就不限 */
  ledger?: ReturnType<typeof createLedger>;
  /** 单价。传了就在结果里写上花了多少钱 */
  price?: Price;
  /** 一次研究最多多久，默认 180 秒 */
  timeBudgetMs?: number;
  /** 同时最多跑几个研究，默认 4 */
  maxConcurrent?: number;
  /** 请求体最大多少字节，默认 16KB */
  maxBodyBytes?: number;
  /** trace 导出到哪里，比如 Langfuse（第 34 天）。不传也会记 trace，只是不导出 */
  exporter?: SpanExporter;
  /** 每个请求一条日志，默认以 JSON 写到 stderr */
  log?: (entry: LogEntry) => void;
}

export interface ResearchService {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  limiter: Limiter;
  /** 异步的运行，按编号存在内存里。进程重启就没了，第 45 天换成队列和数据库 */
  runs: Map<string, RunRecord>;
  /** 还没跑完的异步运行，测试和优雅退出时等它们 */
  idle(): Promise<void>;
}

export const DEFAULT_GUARDS: GuardedOptions = { input: [lengthGuard(4000), piiGuard()], output: [piiGuard()] };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/** 给调用方看的结果：去掉内部的错误信息 */
function publicResult({ error: _error, ...rest }: ServiceResult) {
  return rest;
}

export function createResearchService(options: ServiceOptions): ResearchService {
  const { model, makeSetup, guards = DEFAULT_GUARDS, ledger, price, timeBudgetMs = 180_000, maxConcurrent = 4, maxBodyBytes = 16 * 1024, exporter } = options;
  const log = options.log ?? ((entry: LogEntry) => console.error(JSON.stringify(entry)));
  const keys = hashApiKeys(options.apiKeys);
  const limiter = createLimiter(maxConcurrent);
  const runs = new Map<string, RunRecord>();
  const pending = new Set<Promise<void>>();

  /** 鉴权、读请求体、校验、占并发的位置、开预算。都过了才返回，调用方负责 release */
  const admit = async (req: IncomingMessage, user: ServiceUser) => {
    const request = parseResearchRequest(await readJsonBody(req, maxBodyBytes));
    let budget: Budget | undefined;
    if (ledger) {
      budget = ledger.taskBudget(user.id);
      try {
        budget.check();
      } catch (error) {
        if (error instanceof BudgetExceededError) throw new HttpError(429, '今天的额度用完了，明天再来吧', { 'retry-after': '3600' });
        throw error;
      }
    }
    if (!limiter.tryAcquire()) throw new HttpError(429, '现在太忙了，请稍后再试', { 'retry-after': '30' });
    return { request, budget };
  };

  const context = async (user: ServiceUser, budget: Budget | undefined, id: string, signal?: AbortSignal): Promise<RunContext> => ({
    setup: await makeSetup(user),
    model,
    guards,
    budget,
    tracer: createTracer({ exporter }),
    timeBudgetMs,
    price,
    signal,
    id,
  });

  async function route(req: IncomingMessage, res: ServerResponse, entry: LogEntry): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const allow = (methods: string[]) => {
      if (!methods.includes(method)) throw new HttpError(405, `${pathname} 只支持 ${methods.join('、')}`, { allow: methods.join(', ') });
    };

    if (pathname === '/healthz') {
      allow(['GET']);
      return send(res, 200, { status: 'ok', active: limiter.active(), maxConcurrent });
    }
    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(pathname);
    if (pathname !== '/v1/research' && pathname !== '/v1/runs' && !runMatch) throw new HttpError(404, `没有 ${pathname} 这个接口`);

    const user = authenticate(req.headers.authorization, keys);
    if (!user) throw new HttpError(401, '缺少或者无效的 API Key：请加上 Authorization: Bearer <key>', { 'www-authenticate': 'Bearer' });
    entry.userId = user.id;

    if (pathname === '/v1/research') {
      allow(['POST']);
      const { request, budget } = await admit(req, user);
      // 调用方断开了，就别再花钱接着查
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const result = await runResearchRequest(request, await context(user, budget, entry.requestId, controller.signal));
        Object.assign(entry, { traceId: result.traceId, outcome: result.status, guardEvents: result.guardEvents, error: result.error });
        return send(res, 200, publicResult(result), result.traceId ? { 'x-trace-id': result.traceId } : {});
      } finally {
        limiter.release();
      }
    }

    if (pathname === '/v1/runs') {
      allow(['POST']);
      const { request, budget } = await admit(req, user);
      const id = randomUUID();
      const record: RunRecord = { id, userId: user.id, status: 'running', createdAt: new Date().toISOString() };
      runs.set(id, record);
      // 不等它跑完。调用方断开也不取消：它会回来查结果
      const job = (async () => {
        try {
          record.result = await runResearchRequest(request, await context(user, budget, id));
          record.status = 'done';
          if (record.result.error) log({ ...entry, path: `/v1/runs/${id}`, status: 200, ms: 0, outcome: record.result.status, error: record.result.error });
        } catch (error) {
          record.status = 'failed';
          log({ ...entry, path: `/v1/runs/${id}`, status: 500, ms: 0, error: (error as Error).message });
        } finally {
          limiter.release();
        }
      })();
      pending.add(job);
      void job.finally(() => pending.delete(job));
      return send(res, 202, { id, status: 'running' }, { location: `/v1/runs/${id}` });
    }

    allow(['GET']);
    const record = runs.get(runMatch![1]);
    // 别人的运行也说「没有」：不透露这个编号存不存在
    if (!record || record.userId !== user.id) throw new HttpError(404, '没有这个运行');
    const { userId: _userId, result, ...rest } = record;
    return send(res, 200, { ...rest, ...(result ? { result: publicResult(result) } : {}) });
  }

  return {
    limiter,
    runs,
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    async handle(req, res) {
      const started = performance.now();
      const requestId = randomUUID();
      res.setHeader('x-request-id', requestId);
      const entry: LogEntry = { time: new Date().toISOString(), requestId, method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], status: 0, ms: 0 };
      try {
        await route(req, res, entry);
      } catch (error) {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message }, error.headers);
        } else {
          // 意料之外的错误：调用方只看到一句话和请求编号，细节进日志
          entry.error = (error as Error).message;
          send(res, 500, { error: '服务出错了，请稍后再试', requestId });
        }
      } finally {
        entry.status = res.statusCode;
        entry.ms = Math.round(performance.now() - started);
        log(entry);
      }
    },
  };
}

/** 启动服务。port 传 0 就随便找一个空闲的端口（测试用） */
export async function startService(options: ServiceOptions & { port?: number; host?: string }): Promise<{ url: string; service: ResearchService; close(): Promise<void> }> {
  const service = createResearchService(options);
  const server = createServer((req, res) => void service.handle(req, res));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    service,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.idle();
    },
  };
}

/** 读 SERVICE_API_KEYS：「key1:用户1,key2:用户2」 */
export function parseApiKeys(text: string | undefined): Record<string, ServiceUser> {
  const keys: Record<string, ServiceUser> = {};
  for (const pair of (text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, id] = pair.split(':');
    if (!key || !id) throw new Error(`SERVICE_API_KEYS 的格式是「key1:用户1,key2:用户2」，这一项不对：${pair}`);
    keys[key] = { id };
  }
  return keys;
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve, join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const { createFailoverModel } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { loadDocs } = await import('./docs-setup.ts');
  const { createMemoryStore } = await import('./memory.ts');
  const { langfuseExporterFromEnv } = await import('./trace.ts');
  const { parsePrice } = await import('./usage.ts');
  const apiKeys = parseApiKeys(process.env.SERVICE_API_KEYS);
  if (!Object.keys(apiKeys).length) {
    console.error('先设置 SERVICE_API_KEYS，比如 SERVICE_API_KEYS=dev-key:me');
    process.exit(1);
  }
  const root = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  const docs = await loadDocs(process.env.DOCS_DIR);
  const price = parsePrice(process.env.OPENAI_PRICE);
  const { url } = await startService({
    port: Number(process.env.PORT ?? 8787),
    apiKeys,
    model: createFailoverModel(),
    price,
    ledger: price ? createLedger({ price, perUserDaily: Number(process.env.USER_DAILY_BUDGET ?? 5), perTask: Number(process.env.TASK_BUDGET ?? 0.5) }) : undefined,
    exporter: langfuseExporterFromEnv(),
    makeSetup: async (user) => {
      const workspace = join(root, 'users', user.id);
      await mkdir(workspace, { recursive: true });
      return { workspace, search: searchProviderFromEnv(), docs, memory: createMemoryStore(join(workspace, '.mini-agent', 'memory')) };
    },
  });
  console.error(`研究助手服务已启动：${url}`);
}
