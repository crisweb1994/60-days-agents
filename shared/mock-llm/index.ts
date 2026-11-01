// 本地的模型服务器，按测试准备好的脚本逐轮回复。同时实现了两种协议：
// - OpenAI 兼容接口：POST …/chat/completions
// - Anthropic 协议：POST …/v1/messages（第 8 天起）
// 学员代码照常用 fetch 调用；测试决定每一轮返回什么，并检查收到的每个请求。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  errorType,
  toStopReason,
  validateAnthropic,
  type AnthropicBlock,
  type AnthropicRequest,
  type IssuedThinking,
} from './anthropic.ts';

export type { AnthropicBlock, AnthropicMessage, AnthropicRequest, AnthropicTool } from './anthropic.ts';

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
  reasoning_content?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export type ToolChoiceParam = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export type ResponseFormatParam =
  | { type: 'text' | 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean; description?: string };
    };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoiceParam;
  response_format?: ResponseFormatParam;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

export interface MockReply {
  /** 回答的文字。有工具调用时默认是 null，和真实接口一致 */
  content?: string | null;
  /** 思考内容。OpenAI 兼容接口放在 reasoning_content 字段里；Anthropic 协议是一个带签名的 thinking 块 */
  reasoning?: string;
  /** 模型发起的工具调用。arguments 传对象会转成 JSON 字符串；传字符串可以模拟模型生成了坏掉的 JSON */
  toolCalls?: { id?: string; name: string; arguments: Record<string, unknown> | string }[];
  /**
   * 默认有工具调用时是 tool_calls，否则是 stop；可以改成 length、content_filter、sensitive 等。
   * Anthropic 协议会自动换成对应的 stop_reason（stop → end_turn，tool_calls → tool_use，length → max_tokens，
   * content_filter → refusal），其他取值原样返回
   */
  finishReason?: string;
  /** 不传时按文本长度粗略估算。可以带上额外字段，比如 prompt_tokens_details、completion_tokens_details */
  usage?: { prompt_tokens: number; completion_tokens: number; [key: string]: unknown };
  /** 等多久再回复，用来测试超时 */
  delayMs?: number;
  /** 流式返回时，每块之间等多久。用来测试中途取消 */
  chunkDelayMs?: number;
  /** 流式返回时，发完这么多块就直接断开连接，模拟传到一半网络断了 */
  disconnectAfter?: number;
}

export interface MockFailure {
  /** HTTP 状态码，默认 500 */
  status?: number;
  message?: string;
  /** 错误体里的 error.type 和 error.code，比如 { type: 'insufficient_quota', code: 'insufficient_quota' } */
  type?: string;
  code?: string;
  headers?: Record<string, string>;
  /** 直接返回这段原始内容，不包装成 JSON。比如网关返回的 HTML 错误页 */
  body?: string;
  /** 不返回任何响应，直接断开连接，模拟网络错误 */
  disconnect?: boolean;
  delayMs?: number;
}

export interface MockLLM {
  /** 填到 OPENAI_BASE_URL 的地址，形如 http://127.0.0.1:54321/v1 */
  readonly baseURL: string;
  /** 填到 ANTHROPIC_BASE_URL 的地址，形如 http://127.0.0.1:54321。客户端会在后面加上 /v1/messages */
  readonly anthropicBaseURL: string;
  /** 收到的每个 OpenAI 兼容请求，按顺序记录 */
  readonly requests: ChatRequest[];
  /** 收到的每个 Anthropic 协议请求，按顺序记录 */
  readonly anthropicRequests: AnthropicRequest[];
  /** 还没用掉的脚本条数 */
  readonly pending: number;
  /** 追加一轮成功的回复 */
  reply(reply: MockReply): MockLLM;
  /** 追加一次失败的响应，比如 429、503，或者直接断开连接 */
  fail(failure: MockFailure): MockLLM;
  /** 清空脚本和请求记录 */
  reset(): void;
  close(): Promise<void>;
}

type Turn = { reply: MockReply } | { failure: MockFailure };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number; [key: string]: unknown };
type Result = { id: string; model: string; message: ChatMessage; finishReason: string; usage: Usage };
type Protocol = 'openai' | 'anthropic';

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
// 流式返回时每块最多几个字符。故意切得很碎，逼着客户端正确拼接
const CHUNK_SIZE = 4;

export async function startMockLLM(): Promise<MockLLM> {
  const turns: Turn[] = [];
  const requests: ChatRequest[] = [];
  const anthropicRequests: AnthropicRequest[] = [];
  const issued: IssuedThinking = new Map();
  let scripted = 0;
  let nextToolCallId = 1;
  let nextSignature = 1;
  const closing = new AbortController();

  const server = createServer((req, res) => {
    // 客户端断开（比如 AbortController 取消了请求）时，停止还在等待的 delayMs 和分块发送
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const signal = AbortSignal.any([closing.signal, gone.signal]);
    const protocol: Protocol = req.url?.endsWith('/v1/messages') ? 'anthropic' : 'openai';
    handle(req, res, protocol, signal).catch((error: unknown) => {
      if (signal.aborted) return;
      if (res.headersSent) res.end();
      else sendError(res, protocol, 500, `mock 服务器出错：${String(error)}`);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse, protocol: Protocol, signal: AbortSignal): Promise<void> {
    const isOpenAI = req.url?.endsWith('/chat/completions');
    if (req.method !== 'POST' || (!isOpenAI && protocol !== 'anthropic')) {
      return sendError(res, protocol, 404, `mock 只实现了 POST /chat/completions 和 POST /v1/messages，收到的是 ${req.method} ${req.url}`);
    }
    if (protocol === 'openai' && !req.headers.authorization?.startsWith('Bearer ')) {
      return sendError(res, protocol, 401, '请求头里缺少 Authorization: Bearer <API Key>');
    }
    if (protocol === 'anthropic') {
      if (!req.headers['x-api-key'] && !req.headers.authorization?.startsWith('Bearer ')) {
        return sendError(res, protocol, 401, '请求头里缺少 x-api-key 或 Authorization: Bearer <API Key>');
      }
      if (!req.headers['anthropic-version']) return sendError(res, protocol, 400, '请求头里缺少 anthropic-version，比如 2023-06-01');
    }

    let body: ChatRequest | AnthropicRequest;
    try {
      body = JSON.parse(await text(req));
    } catch {
      return sendError(res, protocol, 400, '请求体不是合法的 JSON');
    }
    const problem =
      protocol === 'openai' ? validate(body as ChatRequest) : validateAnthropic(body as AnthropicRequest, issued);
    if (problem) return sendError(res, protocol, 400, problem);
    if (protocol === 'openai') requests.push(body as ChatRequest);
    else anthropicRequests.push(body as AnthropicRequest);

    const turn = turns.shift();
    const count = requests.length + anthropicRequests.length;
    if (!turn) {
      return sendError(
        res,
        protocol,
        500,
        `mock 脚本已用完：测试只准备了 ${scripted} 轮回复，这已经是第 ${count} 个请求。Agent 是不是多调用了一次模型，或者陷入了循环？`,
      );
    }
    const { delayMs } = 'reply' in turn ? turn.reply : turn.failure;
    if (delayMs) await sleep(delayMs, undefined, { signal });
    if ('failure' in turn) return sendFailure(req, res, protocol, turn.failure);

    if (protocol === 'anthropic') return replyAnthropic(res, body as AnthropicRequest, turn.reply, count, signal);
    const chat = body as ChatRequest;
    const message = toMessage(turn.reply);
    const result: Result = {
      id: `chatcmpl-mock-${count}`,
      model: chat.model,
      message,
      finishReason: turn.reply.finishReason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
      usage: toUsage(chat.messages, message, turn.reply.usage),
    };
    if (chat.stream) {
      return writeEvents(res, openAIEvents(result, chat.stream_options?.include_usage === true), turn.reply, signal, 'data: [DONE]\n\n');
    }
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
    const message: ChatMessage = { role: 'assistant', content: reply.content ?? (toolCalls.length ? null : '') };
    if (reply.reasoning !== undefined) message.reasoning_content = reply.reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return message;
  }

  /** 按 Anthropic Messages API 的格式回复：内容是一组块，思考块带签名，工具调用是 tool_use 块 */
  function replyAnthropic(res: ServerResponse, body: AnthropicRequest, reply: MockReply, count: number, signal: AbortSignal) {
    const blocks: AnthropicBlock[] = [];
    const toolIds: string[] = [];
    let signature: string | undefined;
    if (reply.reasoning !== undefined) {
      signature = `mock-signature-${nextSignature++}`;
      blocks.push({ type: 'thinking', thinking: reply.reasoning, signature });
    }
    if (reply.content) blocks.push({ type: 'text', text: reply.content });
    for (const call of reply.toolCalls ?? []) {
      const id = call.id ?? `toolu_${nextToolCallId++}`;
      toolIds.push(id);
      blocks.push({ type: 'tool_use', id, name: call.name, input: call.arguments });
    }
    if (signature) issued.set(signature, { thinking: reply.reasoning ?? '', toolIds });

    const stopReason = toStopReason(reply.finishReason ?? (toolIds.length ? 'tool_calls' : 'stop'));
    const outputText = blocks.map((block) => JSON.stringify(block)).join('');
    const promptTokens = reply.usage?.prompt_tokens ?? estimate(JSON.stringify(body.messages));
    const cached = Number((reply.usage?.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0);
    const usage = {
      input_tokens: promptTokens - cached,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: reply.usage?.completion_tokens ?? estimate(outputText),
    };
    const id = `msg_mock_${count}`;

    if (!body.stream) {
      // 非流式时 tool_use 的 input 是对象；脚本给的是坏掉的 JSON 字符串时，没法表示，就放一个空对象
      const content = blocks.map((block) =>
        block.type === 'tool_use' && typeof block.input === 'string' ? { ...block, input: tryParse(block.input) } : block,
      );
      return sendJSON(res, 200, { id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage });
    }

    const events: string[] = [];
    const event = (type: string, data: object) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', {
      message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
    });
    event('ping', {});
    blocks.forEach((block, index) => {
      if (block.type === 'thinking') {
        event('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        for (const piece of split(String(block.thinking))) event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } });
        event('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
      } else if (block.type === 'text') {
        event('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const piece of split(String(block.text))) event('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
      } else {
        event('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        const json = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
        for (const piece of split(json)) event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
      }
      event('content_block_stop', { index });
    });
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    event('message_stop', {});
    return writeEvents(res, events, reply, signal);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const mock: MockLLM = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    anthropicBaseURL: `http://127.0.0.1:${port}`,
    requests,
    anthropicRequests,
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
      anthropicRequests.length = 0;
      issued.clear();
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

// 像真实接口一样检查 OpenAI 兼容请求的格式。真实接口遇到这些问题会返回 400，这里顺便用中文说清楚错在哪
function validate(body: ChatRequest): string | undefined {
  if (typeof body !== 'object' || body === null) return '请求体必须是 JSON 对象';
  if (typeof body.model !== 'string' || body.model === '') return '缺少 model 字段';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages 必须是非空数组';
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return 'tools 必须是数组';
    if (body.tools.length === 0) return 'tools 不能是空数组。没有工具时，请求里不要带 tools 字段';
    for (const [i, tool] of body.tools.entries()) {
      if (tool?.type !== 'function') return `tools[${i}].type 必须是 "function"`;
      if (typeof tool.function?.name !== 'string') return `tools[${i}].function.name 必须是字符串`;
    }
  }
  const choiceProblem = validateToolChoice(body);
  if (choiceProblem) return choiceProblem;
  const formatProblem = validateResponseFormat(body);
  if (formatProblem) return formatProblem;
  if (body.stream_options !== undefined && body.stream !== true) return 'stream_options 只能在 stream 为 true 时使用';

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

function validateToolChoice(body: ChatRequest): string | undefined {
  const choice: unknown = body.tool_choice;
  if (choice === undefined) return undefined;
  if (!body.tools) return 'tool_choice 要和 tools 一起使用：请求里没有 tools，就不要带 tool_choice';
  if (typeof choice === 'string') {
    if (['auto', 'none', 'required'].includes(choice)) return undefined;
    return `tool_choice 不合法：${JSON.stringify(choice)}。可选 "auto"、"none"、"required"，或者 { type: "function", function: { name } }`;
  }
  const named = choice as { type?: unknown; function?: { name?: unknown } } | null;
  if (named?.type !== 'function' || typeof named.function?.name !== 'string') {
    return 'tool_choice 指定工具时要写成 { type: "function", function: { name: "工具名" } }';
  }
  const name = named.function.name;
  if (!body.tools.some((tool) => tool.function.name === name)) return `tool_choice 指定的工具 ${name} 不在 tools 里`;
  return undefined;
}

function validateResponseFormat(body: ChatRequest): string | undefined {
  const format = body.response_format as { type?: unknown; json_schema?: { name?: unknown; schema?: unknown } } | undefined;
  if (format === undefined) return undefined;
  if (format?.type === 'text') return undefined;
  if (format?.type === 'json_object') {
    // OpenAI 和 DeepSeek 都有这条规则：提示词里得提到 json，模型才知道要输出什么
    const mentioned = body.messages.some(
      (message) =>
        ['system', 'developer', 'user'].includes(message.role) &&
        typeof message.content === 'string' &&
        /json/i.test(message.content),
    );
    if (mentioned) return undefined;
    return '使用 response_format: { type: "json_object" } 时，system 或 user 消息里必须出现「json」这个词，最好再给一个输出样例';
  }
  if (format?.type === 'json_schema') {
    const schema = format.json_schema;
    if (typeof schema?.name === 'string' && typeof schema.schema === 'object' && schema.schema !== null) return undefined;
    return 'response_format 为 json_schema 时，要写成 { type: "json_schema", json_schema: { name, schema, strict } }';
  }
  return `response_format.type 不合法：${JSON.stringify(format?.type)}。可选 "text"、"json_object"、"json_schema"`;
}

const estimate = (value: string) => Math.max(1, Math.ceil(value.length / 4));

function tryParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function toUsage(messages: unknown, message: ChatMessage, usage?: MockReply['usage']): Usage {
  if (usage) return { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
  const output = (message.content ?? '') + (message.tool_calls ?? []).map((call) => call.function.arguments).join('');
  const reasoning = message.reasoning_content ? estimate(message.reasoning_content) : 0;
  const prompt_tokens = estimate(JSON.stringify(messages));
  const completion_tokens = estimate(output) + reasoning;
  const result: Usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
  if (reasoning) result.completion_tokens_details = { reasoning_tokens: reasoning };
  return result;
}

/** OpenAI 的 SSE 格式：先发思考和文字，再发每个工具调用的参数，最后是结束原因（和 usage） */
function openAIEvents(result: Result, includeUsage: boolean): string[] {
  const base = { id: result.id, object: 'chat.completion.chunk', created: now(), model: result.model };
  const chunks: object[] = [];
  const delta = (value: object, finish_reason: string | null = null) =>
    chunks.push({ ...base, choices: [{ index: 0, delta: value, finish_reason }] });

  delta({ role: 'assistant', content: '' });
  for (const piece of split(result.message.reasoning_content ?? '')) delta({ reasoning_content: piece });
  for (const piece of split(result.message.content ?? '')) delta({ content: piece });
  result.message.tool_calls?.forEach((call, index) => {
    delta({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
    for (const piece of split(call.function.arguments)) delta({ tool_calls: [{ index, function: { arguments: piece } }] });
  });
  delta({}, result.finishReason);
  if (includeUsage) chunks.push({ ...base, choices: [], usage: result.usage });
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
}

/** 逐个写出 SSE 事件。支持每块之间的延迟（chunkDelayMs）和传到一半断开（disconnectAfter） */
async function writeEvents(res: ServerResponse, events: string[], reply: MockReply, signal: AbortSignal, trailer = '') {
  if (res.destroyed) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  for (const [i, event] of events.entries()) {
    if (i === reply.disconnectAfter) {
      // 模拟传到一半连接断了：先让客户端收到已经发出的块，再直接关掉，不发结束标记
      await sleep(20, undefined, { signal });
      res.destroy();
      return;
    }
    if (i > 0 && reply.chunkDelayMs) await sleep(reply.chunkDelayMs, undefined, { signal });
    if (res.destroyed) return; // 客户端已经取消了请求
    res.write(event);
  }
  res.end(trailer);
}

function sendFailure(req: IncomingMessage, res: ServerResponse, protocol: Protocol, failure: MockFailure) {
  if (failure.disconnect) {
    req.socket.destroy();
    return;
  }
  const status = failure.status ?? 500;
  if (failure.body !== undefined) {
    const type = failure.body.trimStart().startsWith('<') ? 'text/html' : 'text/plain';
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, ...failure.headers });
    res.end(failure.body);
    return;
  }
  const message = failure.message ?? `mock 模拟的 ${status} 错误`;
  sendError(res, protocol, status, message, failure.headers, failure.type, failure.code);
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

// 错误体的格式按协议来：OpenAI 是 { error: { message, type, code } }，Anthropic 是 { type: 'error', error: { type, message } }
function sendError(
  res: ServerResponse,
  protocol: Protocol,
  status: number,
  message: string,
  headers?: Record<string, string>,
  type?: string,
  code?: string,
) {
  if (protocol === 'anthropic') {
    sendJSON(res, status, { type: 'error', error: { type: type ?? errorType(status), message } }, headers);
    return;
  }
  sendJSON(res, status, { error: { message, type: type ?? 'mock_error', code: code ?? null } }, headers);
}

const now = () => Math.floor(Date.now() / 1000);
