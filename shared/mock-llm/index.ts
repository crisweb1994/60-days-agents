// 本地的 OpenAI 兼容模型服务器，按测试准备好的脚本逐轮回复。
// 学员代码照常用 fetch 调用 /chat/completions；测试决定每一轮返回什么，并检查收到的每个请求。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface MockReply {
  /** 回答的文字。有工具调用时默认是 null，和真实接口一致 */
  content?: string | null;
  /** 模型发起的工具调用。arguments 传对象会转成 JSON 字符串；传字符串可以模拟模型生成了坏掉的 JSON */
  toolCalls?: { id?: string; name: string; arguments: Record<string, unknown> | string }[];
  /** 默认有工具调用时是 tool_calls，否则是 stop；可以改成 length、content_filter、sensitive 等 */
  finishReason?: string;
  /** 不传时按文本长度粗略估算 */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** 等多久再回复，用来测试超时 */
  delayMs?: number;
}

export interface MockFailure {
  status: number;
  message?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface MockLLM {
  /** 填到 OPENAI_BASE_URL 的地址，形如 http://127.0.0.1:54321/v1 */
  readonly baseURL: string;
  /** 收到的每个请求体，按顺序记录 */
  readonly requests: ChatRequest[];
  /** 还没用掉的脚本条数 */
  readonly pending: number;
  /** 追加一轮成功的回复 */
  reply(reply: MockReply): MockLLM;
  /** 追加一次失败的响应，比如 429、503 */
  fail(failure: MockFailure): MockLLM;
  /** 清空脚本和请求记录 */
  reset(): void;
  close(): Promise<void>;
}

type Turn = { reply: MockReply } | { failure: MockFailure };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type Result = { id: string; model: string; message: ChatMessage; finishReason: string; usage: Usage };

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
// 流式返回时每块最多几个字符。故意切得很碎，逼着客户端正确拼接
const CHUNK_SIZE = 4;

export async function startMockLLM(): Promise<MockLLM> {
  const turns: Turn[] = [];
  const requests: ChatRequest[] = [];
  let scripted = 0;
  let nextToolCallId = 1;
  const closing = new AbortController();

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // 服务器正在关闭，中断了还在等待（delayMs）的请求，不用再回复
      if (closing.signal.aborted) return;
      if (res.headersSent) res.end();
      else sendError(res, 500, `mock 服务器出错：${String(error)}`);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      return sendError(res, 404, `mock 只实现了 POST /chat/completions，收到的是 ${req.method} ${req.url}`);
    }
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return sendError(res, 401, '请求头里缺少 Authorization: Bearer <API Key>');
    }
    let body: ChatRequest;
    try {
      body = JSON.parse(await text(req));
    } catch {
      return sendError(res, 400, '请求体不是合法的 JSON');
    }
    const problem = validate(body);
    if (problem) return sendError(res, 400, problem);

    requests.push(body);
    const turn = turns.shift();
    if (!turn) {
      return sendError(
        res,
        500,
        `mock 脚本已用完：测试只准备了 ${scripted} 轮回复，这已经是第 ${requests.length} 个请求。Agent 是不是多调用了一次模型，或者陷入了循环？`,
      );
    }
    const { delayMs } = 'reply' in turn ? turn.reply : turn.failure;
    if (delayMs) await sleep(delayMs, undefined, { signal: closing.signal });

    if ('failure' in turn) {
      const { status, message, headers } = turn.failure;
      return sendError(res, status, message ?? `mock 模拟的 ${status} 错误`, headers);
    }
    const message = toMessage(turn.reply);
    const result: Result = {
      id: `chatcmpl-mock-${requests.length}`,
      model: body.model,
      message,
      finishReason: turn.reply.finishReason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
      usage: toUsage(body, message, turn.reply.usage),
    };
    if (body.stream) return sendStream(res, result, body.stream_options?.include_usage === true);
    sendJSON(res, 200, {
      id: result.id,
      object: 'chat.completion',
      created: now(),
      model: result.model,
      choices: [{ index: 0, message, finish_reason: result.finishReason }],
      usage: result.usage,
    });
  }

  function toMessage(reply: MockReply): ChatMessage {
    const toolCalls = (reply.toolCalls ?? []).map(
      (call): ToolCall => ({
        id: call.id ?? `call_${nextToolCallId++}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        },
      }),
    );
    if (toolCalls.length === 0) return { role: 'assistant', content: reply.content ?? '' };
    return { role: 'assistant', content: reply.content ?? null, tool_calls: toolCalls };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const mock: MockLLM = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    get pending() {
      return turns.length;
    },
    reply(reply) {
      turns.push({ reply });
      scripted++;
      return mock;
    },
    fail(failure) {
      turns.push({ failure });
      scripted++;
      return mock;
    },
    reset() {
      turns.length = 0;
      requests.length = 0;
      scripted = 0;
      nextToolCallId = 1;
    },
    async close() {
      closing.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return mock;
}

// 像真实接口一样检查请求格式。真实接口遇到这些问题会返回 400，这里顺便用中文说清楚错在哪
function validate(body: ChatRequest): string | undefined {
  if (typeof body !== 'object' || body === null) return '请求体必须是 JSON 对象';
  if (typeof body.model !== 'string' || body.model === '') return '缺少 model 字段';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages 必须是非空数组';
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return 'tools 必须是数组';
    for (const [i, tool] of body.tools.entries()) {
      if (tool?.type !== 'function') return `tools[${i}].type 必须是 "function"`;
      if (typeof tool.function?.name !== 'string') return `tools[${i}].function.name 必须是字符串`;
    }
  }
  const waiting = new Set<string>(); // 还没交回结果的工具调用
  for (const [i, message] of body.messages.entries()) {
    if (!ROLES.has(message?.role)) return `messages[${i}].role 不合法：${JSON.stringify(message?.role)}`;
    if (message.role === 'tool') {
      if (!waiting.delete(message.tool_call_id ?? '')) {
        return `messages[${i}] 是 tool 消息，但 tool_call_id ${JSON.stringify(message.tool_call_id)} 对不上前面任何一个等待结果的工具调用`;
      }
      continue;
    }
    if (waiting.size > 0) {
      return `messages[${i}] 之前还有工具调用没交回结果：${[...waiting].join('、')}。每个工具调用后面都要跟一条 tool_call_id 对应的 tool 消息`;
    }
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) waiting.add(call.id);
  }
  if (waiting.size > 0) return `最后还有工具调用没交回结果：${[...waiting].join('、')}`;
  return undefined;
}

function toUsage(body: ChatRequest, message: ChatMessage, usage?: MockReply['usage']): Usage {
  const estimate = (value: string) => Math.max(1, Math.ceil(value.length / 4));
  const output = (message.content ?? '') + (message.tool_calls ?? []).map((call) => call.function.arguments).join('');
  const prompt_tokens = usage?.prompt_tokens ?? estimate(JSON.stringify(body.messages));
  const completion_tokens = usage?.completion_tokens ?? estimate(output);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

// 按 OpenAI 的 SSE 格式分块返回：先发文字，再发每个工具调用的参数，最后是结束原因和 [DONE]
function sendStream(res: ServerResponse, result: Result, includeUsage: boolean) {
  if (res.destroyed) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  const base = { id: result.id, object: 'chat.completion.chunk', created: now(), model: result.model };
  const send = (data: object) => res.write(`data: ${JSON.stringify({ ...base, ...data })}\n\n`);
  const sendDelta = (delta: object, finish_reason: string | null = null) =>
    send({ choices: [{ index: 0, delta, finish_reason }] });

  sendDelta({ role: 'assistant', content: '' });
  for (const piece of split(result.message.content ?? '')) sendDelta({ content: piece });
  result.message.tool_calls?.forEach((call, index) => {
    sendDelta({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
    for (const piece of split(call.function.arguments)) sendDelta({ tool_calls: [{ index, function: { arguments: piece } }] });
  });
  sendDelta({}, result.finishReason);
  if (includeUsage) send({ choices: [], usage: result.usage });
  res.end('data: [DONE]\n\n');
}

function split(value: string): string[] {
  const chars = Array.from(value);
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += CHUNK_SIZE) pieces.push(chars.slice(i, i + CHUNK_SIZE).join(''));
  return pieces;
}

function sendJSON(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

// 错误体和 OpenAI 的格式一致：{ error: { message, type, code } }
function sendError(res: ServerResponse, status: number, message: string, headers?: Record<string, string>) {
  sendJSON(res, status, { error: { message, type: 'mock_error', code: status } }, headers);
}

const now = () => Math.floor(Date.now() / 1000);
