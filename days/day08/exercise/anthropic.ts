// 调用 Anthropic 协议的接口：Claude，以及 DeepSeek、通义千问、GLM、Kimi、MiniMax、Ollama 提供的 Anthropic 兼容接口。
// 对外和 openai.ts 一样实现 Model 接口；对内负责在我们的消息格式（沿用 OpenAI 的写法）和 Anthropic 的写法之间来回转换。
// 第 8 天的练习：补全这个文件里的 TODO 1–3。检查：npm run check 8
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
  // TODO 1（上）：按角色转换：
  // - user：内容不为空就是一个 text 块，空的返回 []
  // - tool：一个 tool_result 块，tool_use_id 就是 tool_call_id
  // - assistant：依次放入
  //   1. message.thinking_blocks 里的思考块，原样放在最前面（只有 reasoning_content、没有思考块的不放：没有签名，Anthropic 不认）
  //   2. 有文字就放一个 text 块
  //   3. 每个工具调用一个 tool_use 块：id、name，input 用 parseArguments(arguments) 把 JSON 字符串变成对象
  throw new Error('TODO 1：还没有实现 toBlocks()');
}

/** 把 ChatRequest 转成 Anthropic 协议的请求体 */
export function toAnthropicRequest(request: ChatRequest, config: AnthropicConfig): AnthropicRequestBody {
  if (request.responseFormat) throw new Error('Anthropic 协议的适配器还不支持 responseFormat');
  // TODO 1（下）：拼出请求体。
  // - system：把所有 system 消息的内容用两个换行连起来，放到顶层的 system 字段；没有就不带
  // - messages：其余的消息用 toBlocks 转换，跳过转换后为空的。角色只有 user 和 assistant：tool 消息算 user。
  //   和上一条角色相同时，块合并进上一条，不新建一条：这样一轮的所有工具结果在同一条 user 消息里，
  //   用户接着说的话排在工具结果后面
  // - max_tokens：必填。用 request.maxTokens，没有就用 config.maxTokens，再没有就用 8192
  // - tools：换成 { name, description, input_schema }，没有工具时不带
  // - tool_choice：用 toAnthropicToolChoice 换算；temperature、top_p 原样；stop 放进 stop_sequences
  throw new Error('TODO 1：还没有实现 toAnthropicRequest()');
}

/** Anthropic 的 stop_reason 换成 OpenAI 的叫法：Agent 只认这一套。不认识的原样交回，让 Agent 当作异常处理 */
export function toFinishReason(stopReason: string): string {
  // TODO 3（上）：end_turn 和 stop_sequence → stop，tool_use → tool_calls，max_tokens → length，
  // refusal → content_filter（拒绝回答，相当于被拦截）。其他的原样返回
  return stopReason;
}

/** Anthropic 的 usage 换成我们的 Usage。它的 input_tokens 不包括缓存命中和写入缓存的部分，要加回来 */
export function toUsage(raw: AnthropicUsage): Usage {
  // TODO 3（下）：inputTokens 是 input_tokens、cache_read_input_tokens、cache_creation_input_tokens 三者之和；
  // cachedTokens 是 cache_read_input_tokens；reasoningTokens 来自 output_tokens_details.thinking_tokens。没有的字段算 0
  return { inputTokens: raw.input_tokens ?? 0, cachedTokens: 0, outputTokens: raw.output_tokens ?? 0, reasoningTokens: 0 };
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
      // TODO 2：按 event.type 处理一个事件，返回这个事件新增的文字和思考内容（没有就是空字符串）。
      // - message_start：记下 event.message.usage（输入的 token 数在这里）
      // - content_block_start：在 blocks[event.index] 放一个新块：{ ...event.content_block, json: '' }
      // - content_block_delta：找到 blocks[event.index]，按 event.delta.type 处理：
      //   - text_delta：把 delta.text 接到 block.text 后面，作为新增的文字返回
      //   - thinking_delta：把 delta.thinking 接到 block.thinking 后面，作为新增的思考内容返回
      //   - input_json_delta：把 delta.partial_json 接到 block.json 后面（工具参数是一段段到的）
      //   - signature_delta：把 delta.signature 接到 block.signature 后面
      // - message_delta：记下 event.delta.stop_reason；event.usage 是累计值，合并进 usage（覆盖同名字段）
      // - message_stop：stopped = true
      // - error：抛出 ModelError，状态码用 ERROR_STATUS 按错误类型查（查不到用 500），带上 error.type 和 error.message
      // - 其他（ping，以及以后可能新增的事件）：忽略
      return { text: '', reasoning: '' };
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
