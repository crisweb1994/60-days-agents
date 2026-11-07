// 第 34 天：可观测性。把一次运行里的每一次模型调用、每一次工具调用记成一个 span，span 套着 span，组成一棵树（trace）。
// span 的名字和属性按 OpenTelemetry 的 GenAI 语义约定来写（gen_ai.*），导出成 OTLP/HTTP 的 JSON：
// Langfuse、Jaeger、各家云厂商的可观测平台都认这个格式，换平台不用改代码。
// 这里没有用 OpenTelemetry 的 SDK，自己写了一个最小的实现，为了看清楚 span 里到底有什么。实际项目里用官方 SDK 更省事，概念是一样的。
// 第 34 天的练习：TODO 1–5 都在这里。检查：npm run check 34
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { classifyError } from './retry.ts';
import type { Tool } from './tool.ts';
import type { ChatOptions, ChatRequest, Model } from './types.ts';

export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue>;

export interface Span {
  /** 一次 trace 的 id，32 位十六进制。同一棵树上的 span 都一样 */
  traceId: string;
  /** 16 位十六进制 */
  spanId: string;
  /** 父 span 的 id。根 span 没有 */
  parentSpanId?: string;
  name: string;
  /** client：调用外部服务（模型）；internal：程序内部的一步 */
  kind: 'internal' | 'client';
  /** 开始和结束的时间，毫秒（Unix 时间） */
  startTime: number;
  endTime?: number;
  attributes: Attributes;
  status: { code: 'unset' | 'ok' | 'error'; message?: string };
  events: { name: string; time: number; attributes: Attributes }[];
}

/** 正在进行的 span。结束（end）以后，它进入 tracer 的缓冲区，等着被导出 */
export interface ActiveSpan {
  readonly span: Span;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  /** 记下一个错误：状态改成 error，加上 error.type 属性和一个 exception 事件 */
  recordError(error: unknown): void;
  end(): void;
}

export interface SpanExporter {
  export(spans: Span[]): Promise<void>;
}

export interface TracerOptions {
  exporter?: SpanExporter;
  /** 缓冲了多少个结束的 span 就自动导出一次，默认 50 */
  batchSize?: number;
  /** 当前时间（毫秒），测试时换成假的 */
  clock?: () => number;
  /** 生成 id 的随机字节，测试时换成固定的 */
  randomHex?: (bytes: number) => string;
  /** 导出失败时回调。追踪出错绝不能让 Agent 出错 */
  onExportError?: (error: unknown) => void;
}

export interface Tracer {
  /** 开始一个 span。不指定 parent 时，父 span 是当前上下文里的那个（withSpan 设置的） */
  startSpan(name: string, attributes?: Attributes, options?: { kind?: Span['kind']; parent?: Span | null }): ActiveSpan;
  /** 开始一个 span，在它的上下文里运行 fn：fn 里面开始的 span 都是它的子 span。fn 抛出错误时记下错误再抛出；最后总会结束 span */
  withSpan<T>(name: string, attributes: Attributes, fn: (span: ActiveSpan) => Promise<T>, options?: { kind?: Span['kind'] }): Promise<T>;
  /** 当前上下文里的 span */
  current(): Span | undefined;
  /** 已经结束的 span（包括已经导出的），按结束的顺序 */
  readonly finished: readonly Span[];
  /** 把缓冲区里的 span 都导出 */
  flush(): Promise<void>;
}

const defaultHex = (bytes: number) => randomBytes(bytes).toString('hex');

export function createTracer(options: TracerOptions = {}): Tracer {
  const { exporter, batchSize = 50, clock = () => Date.now(), randomHex = defaultHex, onExportError = (e) => console.error('导出 trace 失败：', e) } = options;
  const storage = new AsyncLocalStorage<Span>();
  const finished: Span[] = [];
  let buffer: Span[] = [];

  const flush = async () => {
    if (!exporter || !buffer.length) return;
    const batch = buffer;
    buffer = [];
    try {
      await exporter.export(batch);
    } catch (error) {
      onExportError(error);
    }
  };

  const startSpan: Tracer['startSpan'] = (name, attributes = {}, { kind = 'internal', parent } = {}) => {
    const parentSpan = parent === null ? undefined : (parent ?? storage.getStore());
    const span: Span = {
      traceId: parentSpan?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      ...(parentSpan ? { parentSpanId: parentSpan.spanId } : {}),
      name,
      kind,
      startTime: clock(),
      attributes: { ...attributes },
      status: { code: 'unset' },
      events: [],
    };
    let ended = false;
    return {
      span,
      setAttributes: (attrs) => Object.assign(span.attributes, attrs),
      addEvent: (eventName, attrs = {}) => span.events.push({ name: eventName, time: clock(), attributes: attrs }),
      recordError(error) {
        const message = error instanceof Error ? error.message : String(error);
        span.status = { code: 'error', message };
        span.attributes['error.type'] = errorType(error);
        span.events.push({ name: 'exception', time: clock(), attributes: { 'exception.message': message, 'exception.type': error instanceof Error ? error.name : typeof error } });
      },
      end() {
        if (ended) return; // 结束两次只算一次
        ended = true;
        span.endTime = clock();
        finished.push(span);
        buffer.push(span);
        if (buffer.length >= batchSize) void flush();
      },
    };
  };

  return {
    startSpan,
    async withSpan(name, attributes, fn, opts = {}) {
      const active = startSpan(name, attributes, { kind: opts.kind });
      // TODO 1：用 storage.run(active.span, () => fn(active)) 运行 fn：fn 里面（包括它 await 的异步操作）
      // 再开始的 span，storage.getStore() 拿到的就是这个 span，它们就成了子 span。
      // fn 抛出错误：active.recordError(错误)，再抛出；不管成功还是失败，最后都要 active.end()（用 finally）
      const result = await fn(active);
      active.end();
      return result;
},
    current: () => storage.getStore(),
    finished,
    flush,
  };
}

/** 错误的种类，写进 error.type。模型的错误用第 9 天的分类（rate_limit、timeout……），其他的用错误的名字 */
export function errorType(error: unknown): string {
  const { kind } = classifyError(error);
  if (kind !== 'unknown') return kind;
  return error instanceof Error ? error.name : 'unknown';
}

// ---------- 给模型和工具加上追踪 ----------

export interface TraceModelOptions {
  /** gen_ai.provider.name，比如 deepseek、moonshot。不填就用模型名冒号前面的部分（openai、anthropic，其实是协议） */
  provider?: string;
  /**
   * 是否把消息的内容记进 span（gen_ai.input.messages、gen_ai.output.messages）。默认不记：
   * 用户的问题、读到的网页、模型的回答都可能有隐私，记下来就要按隐私数据来管。记的时候先 redact、再截断
   */
  captureContent?: boolean;
  /** 内容最多记多少个字符，默认 4000 */
  maxContentChars?: number;
}

/**
 * 包一层模型：每次调用是一个 client span，名字是「chat 模型名」，按 GenAI 约定记下：
 * - 开始时：gen_ai.operation.name（chat）、gen_ai.provider.name、gen_ai.request.model；
 *   请求里有 temperature、maxTokens 时记 gen_ai.request.temperature、gen_ai.request.max_tokens
 * - 结束时：gen_ai.response.finish_reasons（数组）、gen_ai.usage.input_tokens、gen_ai.usage.output_tokens
 * - 出错：recordError（withSpan 会做），再抛出
 * 返回的还是一个 Model，Agent 察觉不到区别
 */
export function traceModel(model: Model, tracer: Tracer, options: TraceModelOptions = {}): Model {
  const [prefix, ...rest] = model.name.split(':');
  const requestModel = rest.join(':') || model.name;
  const { provider = prefix, captureContent = false, maxContentChars = 4000 } = options;
  const clip = (value: unknown) => {
    const text = redact(JSON.stringify(value));
    return text.length > maxContentChars ? `${text.slice(0, maxContentChars)}…（截断）` : text;
  };
  return {
    name: model.name,
    chat(request: ChatRequest, chatOptions?: ChatOptions) {
      // TODO 2：用 tracer.withSpan(`chat ${requestModel}`, 属性, async (span) => {...}, { kind: 'client' }) 包住 model.chat：
      // - 开始时的属性：gen_ai.operation.name、gen_ai.provider.name、gen_ai.request.model，
      //   请求里有 temperature、maxTokens 才记；captureContent 时 gen_ai.input.messages 是 clip(request.messages)
      // - 调用完：span.setAttributes 记下 finish_reasons（数组）、input_tokens、output_tokens；captureContent 时记 gen_ai.output.messages
      void provider;
      void clip;
      return model.chat(request, chatOptions);
},
  };
}

/**
 * 给工具加上追踪：每次执行是一个 span，名字是「execute_tool 工具名」，属性有 gen_ai.operation.name（execute_tool）、
 * gen_ai.tool.name、gen_ai.tool.type（function），有 context.call 时还有 gen_ai.tool.call.id。工具抛出错误时 span 记成 error
 */
export function traceTools(tools: Tool[], tracer: Tracer): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    execute(input, context) {
      // TODO 3：用 tracer.withSpan(`execute_tool ${tool.name}`, 属性, async () => tool.execute(input, context)) 包住执行。
      // 属性：gen_ai.operation.name 是 execute_tool、gen_ai.tool.name、gen_ai.tool.type 是 function；
      // context.call 有值时加上 gen_ai.tool.call.id
      return tool.execute(input, context);
},
  }));
}

/** 一个 Agent 的一次运行：invoke_agent span，属性 gen_ai.operation.name、gen_ai.agent.name。里面的模型和工具调用都是它的子 span */
export function traceAgent<T>(tracer: Tracer | undefined, name: string, fn: () => Promise<T>, attributes: Attributes = {}): Promise<T> {
  if (!tracer) return fn();
  return tracer.withSpan(`invoke_agent ${name}`, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': name, ...attributes }, () => fn());
}

// ---------- 隐私 ----------

const REDACTIONS: [RegExp, string][] = [
  [/\b(sk|pk|ak)-[A-Za-z0-9_-]{8,}/g, '[密钥]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [密钥]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱]'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份证号]'],
];

/** 记进 trace 之前，把密钥、邮箱、手机号、身份证号换掉。第 39 天会做得更完整 */
export function redact(text: string): string {
  return REDACTIONS.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);
}

// ---------- 导出：OTLP/HTTP JSON ----------

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } };

/** 一个属性值换成 OTLP 的写法。整数写成字符串（int64 在 JSON 里要用字符串），小数是 doubleValue */
export function toOtlpValue(value: AttributeValue): OtlpValue {
  // TODO 4（一）：数组 → arrayValue（每一项是 stringValue）；布尔 → boolValue；
  // 整数 → intValue（写成字符串）；小数 → doubleValue；其余 → stringValue
  return { stringValue: String(value) };
}

const toOtlpAttributes = (attributes: Attributes) => Object.entries(attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) }));

/** 毫秒换成纳秒，写成字符串 */
export const toNanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

const KINDS = { internal: 1, client: 3 } as const;
const STATUS = { unset: 0, ok: 1, error: 2 } as const;

/**
 * 一批 span 换成 OTLP/HTTP 的 JSON 请求体：
 * { resourceSpans: [{ resource: { attributes: [service.name] }, scopeSpans: [{ scope: { name }, spans: [...] }] }] }
 * 每个 span：traceId、spanId、parentSpanId（有才写）、name、kind（internal 是 1，client 是 3）、
 * startTimeUnixNano、endTimeUnixNano（纳秒，字符串）、attributes、status（code：unset 0、ok 1、error 2，有 message 才写）、events
 */
export function toOtlp(spans: Span[], serviceName: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: toOtlpAttributes({ 'service.name': serviceName }) },
        scopeSpans: [
          {
            scope: { name: '60-days-agent' },
            // TODO 4（二）：按上面注释的字段，把每个 span 换成 OTLP 的写法。
            // 枚举用 KINDS、STATUS 换成数字，时间用 toNanos，属性用 toOtlpAttributes；没有结束时间就用开始时间
            spans: spans.map((s) => {
              void KINDS;
              void STATUS;
              return { traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name, kind: s.kind, startTimeUnixNano: s.startTime, attributes: s.attributes, status: s.status, events: s.events };
            }),
          },
        ],
      },
    ],
  };
}

export interface OtlpExporterOptions {
  /** 完整的地址，比如 http://localhost:3000/api/public/otel/v1/traces */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  timeoutMs?: number;
}

/** 用 OTLP/HTTP 的 JSON 格式导出。返回的不是 2xx 就抛出错误（tracer 会交给 onExportError） */
export function createOtlpExporter({ endpoint, headers = {}, serviceName = 'research-assistant', timeoutMs = 10_000 }: OtlpExporterOptions): SpanExporter {
  return {
    async export(spans) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(toOtlp(spans, serviceName)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`导出 trace 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
  };
}

/**
 * Langfuse 的导出器：OTLP 的地址是 <LANGFUSE_BASE_URL>/api/public/otel/v1/traces，
 * 用 Basic 认证，用户名是公钥、密码是私钥。没有配置 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY 就返回 undefined
 */
export function langfuseExporterFromEnv(env: NodeJS.ProcessEnv = process.env): SpanExporter | undefined {
  const { LANGFUSE_BASE_URL = 'http://localhost:3000', LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return undefined;
  const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');
  return createOtlpExporter({ endpoint: `${LANGFUSE_BASE_URL.replace(/\/+$/, '')}/api/public/otel/v1/traces`, headers: { Authorization: `Basic ${auth}` } });
}

// ---------- 在服务之间传递 trace（选读） ----------

/** W3C Trace Context 的 traceparent 请求头：00-traceId-spanId-01。调用别的服务（比如 HTTP 部署的 MCP 服务器）时带上它，对方的 span 就能接到这棵树上 */
export function traceparentOf(span: Span): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

/** 解析 traceparent。格式不对返回 undefined */
export function parseTraceparent(header: string | undefined): { traceId: string; spanId: string } | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header?.trim() ?? '');
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2] };
}

// ---------- 看 trace：树、失败、摘要 ----------

export interface SpanNode {
  span: Span;
  children: SpanNode[];
}

/** 把 span 排成树。父 span 不在这批里的，当作根。子 span 按开始时间排序 */
export function buildTree(spans: readonly Span[]): SpanNode[] {
  const nodes = new Map(spans.map((span) => [span.spanId, { span, children: [] as SpanNode[] }]));
  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentSpanId ? nodes.get(node.span.parentSpanId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: SpanNode[]) => {
    list.sort((a, b) => a.span.startTime - b.span.startTime);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

const duration = (span: Span) => (span.endTime ?? span.startTime) - span.startTime;

/** 一个 span 在树里的一行：名字、耗时、token、出错的原因 */
function describeSpan(span: Span): string {
  const parts = [`${span.name}  ${(duration(span) / 1000).toFixed(2)} 秒`];
  const input = span.attributes['gen_ai.usage.input_tokens'];
  const output = span.attributes['gen_ai.usage.output_tokens'];
  if (input !== undefined) parts.push(`输入 ${input} / 输出 ${output} tokens`);
  if (span.status.code === 'error') parts.push(`✗ ${span.attributes['error.type'] ?? 'error'}：${span.status.message ?? ''}`);
  return parts.join(' · ');
}

/** 一棵 trace 排成缩进的文字，方便在终端里看 */
export function formatTrace(spans: readonly Span[]): string {
  const lines: string[] = [];
  const walk = (node: SpanNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${describeSpan(node.span)}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of buildTree(spans)) walk(root, 0);
  return lines.join('\n');
}

export interface Failure {
  span: Span;
  /** 从根到它的每一层的名字 */
  path: string[];
}

/**
 * 找出失败的根源：状态是 error、而且子孙里没有别的 error 的 span。
 * 一个工具出错，它的父 span（Agent）往往也跟着出错；要看的是最底下那个，它才是原因。按开始时间排
 */
export function findFailures(spans: readonly Span[]): Failure[] {
  // TODO 5：用 buildTree 排成树，从每个根往下走（递归）。走到一个节点时：
  // - 先走完它的所有子节点，看子孙里有没有 error
  // - 它自己是 error、子孙里又没有 error：它就是一个根源，记下它和路径（从根到它的每一层的 name）
  // 最后按开始时间排序
  void buildTree;
  void spans;
  return [];
}

export interface TraceSummary {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  /** 最慢的一次模型或工具调用 */
  slowest?: { name: string; ms: number };
}

/** 一棵 trace 的摘要 */
export function summarizeTrace(spans: readonly Span[]): TraceSummary {
  const calls = spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'chat' || s.attributes['gen_ai.operation.name'] === 'execute_tool');
  const slowest = calls.reduce<Span | undefined>((max, s) => (!max || duration(s) > duration(max) ? s : max), undefined);
  const sum = (key: string) => spans.reduce((total, s) => total + (typeof s.attributes[key] === 'number' ? (s.attributes[key] as number) : 0), 0);
  return {
    modelCalls: spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'chat').length,
    toolCalls: spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'execute_tool').length,
    inputTokens: sum('gen_ai.usage.input_tokens'),
    outputTokens: sum('gen_ai.usage.output_tokens'),
    errors: spans.filter((s) => s.status.code === 'error').length,
    ...(slowest ? { slowest: { name: slowest.name, ms: duration(slowest) } } : {}),
  };
}
