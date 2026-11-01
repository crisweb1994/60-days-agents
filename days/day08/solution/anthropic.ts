// 调用 Anthropic 协议的接口：Claude，以及 DeepSeek、通义千问、GLM、Kimi、MiniMax、Ollama 提供的 Anthropic 兼容接口。
// 对外和 openai.ts 一样实现 Model 接口；对内负责在我们的消息格式（沿用 OpenAI 的写法）和 Anthropic 的写法之间来回转换。
import { ModelError, toModelError } from './errors.ts';
import { parseSSE } from './sse.ts';
import type {
  AssistantMessage,
  ChatOptions,
  ChatRequest,
  ChatResult,
  Message,
  Model,
  ThinkingBlock,
  ToolCall,
  ToolChoice,
} from './types.ts';
import type { Usage } from './usage.ts';

export interface AnthropicConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Anthropic 协议要求每次都写明 max_tokens。请求里没指定时用这个值，默认 8192 */
  maxTokens?: number;
}

/** 从环境变量读取配置。只在程序的入口调用 */
export function anthropicConfigFromEnv(): AnthropicConfig {
  const { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = process.env;
  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY || !ANTHROPIC_MODEL) {
    throw new Error('缺少 ANTHROPIC_BASE_URL、ANTHROPIC_API_KEY 或 ANTHROPIC_MODEL。先在 .env 里填好');
  }
  return { baseURL: ANTHROPIC_BASE_URL, apiKey: ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL };
}

/** Anthropic 协议的内容块：一条消息的 content 是一组块 */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | ThinkingBlock;

export type AnthropicMessage = { role: 'user' | 'assistant'; content: Block[] };

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema: object }[];
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

/** Anthropic 的 usage：input_tokens 不包括缓存的部分 */
export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
};

/** 工具参数在我们这里是 JSON 字符串，Anthropic 要的是对象。当初模型生成的 JSON 不合法时，只能换成空对象 */
function parseArguments(args: string): unknown {
  try {
    const value: unknown = JSON.parse(args || '{}');
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function toAnthropicToolChoice(choice: ToolChoice): AnthropicRequestBody['tool_choice'] {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.function.name };
}

/** 一条消息转成 Anthropic 的内容块。system 消息不在这里处理 */
function toBlocks(message: Message): Block[] {
  if (message.role === 'user') return message.content ? [{ type: 'text', text: message.content }] : [];
  if (message.role === 'tool') return [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
  if (message.role !== 'assistant') return [];
  // 思考块排在最前面，原样传回。只有 reasoning_content、没有思考块（比如来自 OpenAI 兼容接口）的，没有签名，不能传
  const blocks: Block[] = [...(message.thinking_blocks ?? [])];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  }
  return blocks;
}

/** 把 ChatRequest 转成 Anthropic 协议的请求体 */
export function toAnthropicRequest(request: ChatRequest, config: AnthropicConfig): AnthropicRequestBody {
  if (request.responseFormat) throw new Error('Anthropic 协议的适配器还不支持 responseFormat');
  // system prompt 放在顶层的 system 字段，不在 messages 里
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages: AnthropicMessage[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    const blocks = toBlocks(message);
    if (blocks.length === 0) continue; // 空的回复：Anthropic 不接受空的内容
    // tool 消息变成 user 消息里的 tool_result 块。相邻的同角色消息合并成一条：
    // 一轮的所有工具结果放进同一条 user 消息，用户接着说的话排在工具结果后面
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  return {
    model: config.model,
    max_tokens: request.maxTokens ?? config.maxTokens ?? 8192,
    system: system || undefined,
    messages,
    tools: request.tools?.length
      ? request.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        }))
      : undefined,
    tool_choice: request.toolChoice ? toAnthropicToolChoice(request.toolChoice) : undefined,
    temperature: request.temperature,
    top_p: request.topP,
    stop_sequences: request.stop,
  };
}

/** Anthropic 的 stop_reason 换成 OpenAI 的叫法：Agent 只认这一套。不认识的原样交回，让 Agent 当作异常处理 */
export function toFinishReason(stopReason: string): string {
  const map: Record<string, string> = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    max_tokens: 'length',
    refusal: 'content_filter',
  };
  // model_context_window_exceeded 原样交回，Agent 会把它当作截断；pause_turn 只有服务端工具才会出现
  return map[stopReason] ?? stopReason;
}

/** Anthropic 的 usage 换成我们的 Usage。它的 input_tokens 不包括缓存命中和写入缓存的部分，要加回来 */
export function toUsage(raw: AnthropicUsage): Usage {
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (raw.input_tokens ?? 0) + cacheRead + cacheWrite,
    cachedTokens: cacheRead,
    outputTokens: raw.output_tokens ?? 0,
    reasoningTokens: raw.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** 流式事件的 data。Anthropic 的每个事件都有 type，和 SSE 的事件名一样 */
type StreamEvent = { type: string; [key: string]: any };

/** 错误类型对应的状态码，第 9 天的重试要靠它判断 */
const ERROR_STATUS: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, api_error: 500 };

/** 把 Anthropic 的流式事件拼成完整的回复 */
export function createAnthropicAccumulator() {
  // 按 index 存放每个内容块；工具参数的 JSON 片段先拼在 json 里
  const blocks: (Block & { json?: string })[] = [];
  let stopReason = '';
  let usage: AnthropicUsage = {};
  let stopped = false;

  return {
    /** 是否收到了 message_stop */
    get stopped() {
      return stopped;
    },

    /** 合并一个事件，返回这个事件新增的文字和思考内容 */
    push(event: StreamEvent): { text: string; reasoning: string } {
      const none = { text: '', reasoning: '' };
      switch (event.type) {
        case 'message_start':
          usage = { ...event.message?.usage };
          return none;
        case 'content_block_start':
          blocks[event.index] = { ...event.content_block, json: '' };
          return none;
        case 'content_block_delta': {
          const block = blocks[event.index] as Record<string, any>;
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            block.text += delta.text;
            return { text: delta.text, reasoning: '' };
          }
          if (delta.type === 'thinking_delta') {
            block.thinking += delta.thinking;
            return { text: '', reasoning: delta.thinking };
          }
          if (delta.type === 'input_json_delta') block.json += delta.partial_json;
          if (delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
          return none;
        }
        case 'message_delta':
          // stop_reason 在这里；usage 是累计值，output_tokens 以这里的为准
          stopReason = event.delta?.stop_reason ?? stopReason;
          usage = { ...usage, ...event.usage };
          return none;
        case 'message_stop':
          stopped = true;
          return none;
        case 'error':
          throw new ModelError(ERROR_STATUS[event.error?.type] ?? 500, `模型在输出过程中出错：${event.error?.message}`, {
            type: event.error?.type,
          });
        default:
          // ping，以及以后可能新增的事件类型：忽略
          return none;
      }
    },

    /** 全部合并完以后，得到和 OpenAI 那边一样的 ChatResult */
    result(): ChatResult {
      const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      const toolCalls: ToolCall[] = blocks.flatMap((block) =>
        block.type === 'tool_use'
          ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: block.json || JSON.stringify(block.input ?? {}) } }]
          : [],
      );
      const thinking = blocks.flatMap((block): ThinkingBlock[] => {
        if (block.type === 'thinking') return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
        if (block.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: block.data }];
        return [];
      });
      const message: AssistantMessage = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      const reasoning = thinking.flatMap((block) => (block.type === 'thinking' ? [block.thinking] : [])).join('');
      if (reasoning) message.reasoning_content = reasoning;
      if (thinking.length) message.thinking_blocks = thinking;
      if (toolCalls.length) message.tool_calls = toolCalls;
      return { message, finishReason: toFinishReason(stopReason), usage: toUsage(usage) };
    },
  };
}

/** 创建一个调用 Anthropic 协议接口的模型 */
export function createAnthropicModel(config: AnthropicConfig = anthropicConfigFromEnv()): Model {
  return {
    name: `anthropic:${config.model}`,
    async chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
      const res = await fetch(`${config.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 官方接口以 Authorization: Bearer 为主，x-api-key 是兼容保留的；各家的兼容接口两种都有人用，所以两个都带上
          Authorization: `Bearer ${config.apiKey}`,
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ ...toAnthropicRequest(request, config), stream: true }),
        signal: options.signal,
      });
      if (!res.ok) throw await toModelError(res);

      const accumulator = createAnthropicAccumulator();
      for await (const { data } of parseSSE(res.body!)) {
        const event = JSON.parse(data) as StreamEvent;
        // DeepSeek 的文档提到，超时时可能发来一个没有事件名、只有 error 的数据块
        if (!event.type && event.error) throw new ModelError(500, `模型在输出过程中出错：${event.error.message}`);
        const { text, reasoning } = accumulator.push(event);
        if (reasoning) options.onReasoning?.(reasoning);
        if (text) options.onText?.(text);
      }
      // 没收到 message_stop 就结束了，说明回复不完整（Anthropic 协议没有 [DONE]，以 message_stop 结束）
      if (!accumulator.stopped) throw new Error('流式响应没有正常结束：还没收到 message_stop，连接就关闭了');
      return accumulator.result();
    },
  };
}
