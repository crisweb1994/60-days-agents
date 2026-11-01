// mock 模型的 Anthropic 协议部分：像真实的 Messages API 一样检查 /v1/messages 请求，并按它的格式回复。
// 脚本（MockReply）和 OpenAI 协议共用，所以测试可以用同一份脚本测两种协议。

export interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  [key: string]: unknown;
}

/** mock 发出过的思考块：签名 → 思考内容，以及同一次回复里的工具调用 id。用来检查思考内容有没有被原样传回 */
export type IssuedThinking = Map<string, { thinking: string; toolIds: string[] }>;

const BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
const CHOICE_TYPES = new Set(['auto', 'any', 'none', 'tool']);

const blocksOf = (message: AnthropicMessage): AnthropicBlock[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;

// 真实接口遇到这些问题会返回 400。错误信息用中文说清楚错在哪，必要时附上 Anthropic 的原话，方便搜索
export function validateAnthropic(body: AnthropicRequest, issued: IssuedThinking): string | undefined {
  if (typeof body !== 'object' || body === null) return '请求体必须是 JSON 对象';
  if (typeof body.model !== 'string' || body.model === '') return '缺少 model 字段';
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return 'Anthropic 协议的 max_tokens 是必填的，而且必须是正整数';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages 必须是非空数组';

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return 'tools 必须是数组';
    for (const [i, tool] of body.tools.entries()) {
      if (tool?.type === 'function' || 'function' in (tool ?? {})) {
        return `tools[${i}] 是 OpenAI 的写法。Anthropic 协议的工具定义是 { name, description, input_schema }，外面不包 type: "function"`;
      }
      if (typeof tool?.name !== 'string') return `tools[${i}].name 必须是字符串`;
      if (typeof tool.input_schema !== 'object' || tool.input_schema === null) return `tools[${i}].input_schema 必须是 JSON Schema 对象`;
    }
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (!CHOICE_TYPES.has(choice?.type)) return `tool_choice.type 不合法：${JSON.stringify(choice?.type)}。可选 auto、any、none、tool`;
    if (choice.type === 'tool' && !body.tools?.some((tool) => tool.name === choice.name)) {
      return `tool_choice 指定的工具 ${choice.name} 不在 tools 里`;
    }
  }

  let pending: string[] = []; // 上一条 assistant 消息里、还等着结果的工具调用
  for (const [i, message] of body.messages.entries()) {
    if (message?.role === 'system') return `messages[${i}] 的 role 是 system。Anthropic 协议没有 system 消息，system prompt 要放在顶层的 system 字段`;
    if (message?.role === 'tool') return `messages[${i}] 的 role 是 tool。Anthropic 协议没有 tool 消息，工具结果要作为 tool_result 块放进 user 消息`;
    if (message?.role !== 'user' && message?.role !== 'assistant') return `messages[${i}].role 不合法：${JSON.stringify(message?.role)}`;
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) return `messages[${i}].content 必须是字符串或者块的数组`;
    const blocks = blocksOf(message);
    if (blocks.length === 0) return `messages[${i}].content 不能是空数组`;
    for (const [j, block] of blocks.entries()) {
      if (!BLOCK_TYPES.has(block?.type)) return `messages[${i}].content[${j}].type 不合法：${JSON.stringify(block?.type)}`;
      if (block.type === 'text' && (typeof block.text !== 'string' || block.text === '')) {
        return `messages[${i}].content[${j}] 是空的文字块。Anthropic 协议不接受空的 text 块`;
      }
    }

    if (message.role === 'user') {
      const results = blocks.filter((block) => block.type === 'tool_result');
      const firstOther = blocks.findIndex((block) => block.type !== 'tool_result');
      if (results.length > 0 && firstOther !== -1 && firstOther < results.length) {
        return `messages[${i}] 里，tool_result 块要排在最前面，文字放在它们后面`;
      }
      for (const result of results) {
        if (!pending.includes(String(result.tool_use_id))) {
          return `messages[${i}] 里的 tool_result 的 tool_use_id ${JSON.stringify(result.tool_use_id)} 对不上上一条 assistant 消息里的任何一个 tool_use`;
        }
      }
      const missing = pending.filter((id) => !results.some((result) => result.tool_use_id === id));
      if (missing.length > 0) {
        return `messages[${i}] 没有交回这些工具调用的结果：${missing.join('、')}。每个 tool_use 后面的 user 消息里，都要有对应的 tool_result（Anthropic 的原话：tool_use ids were found without tool_result blocks immediately after）`;
      }
      pending = [];
      continue;
    }

    // assistant 消息
    if (pending.length > 0) {
      return `messages[${i}] 之前的工具调用还没有交回结果：${pending.join('、')}（Anthropic 的原话：tool_use ids were found without tool_result blocks immediately after）`;
    }
    pending = blocks.filter((block) => block.type === 'tool_use').map((block) => String(block.id));
  }
  if (pending.length > 0) return `最后一条 assistant 消息里的工具调用还没有交回结果：${pending.join('、')}`;

  // 思考内容的回传规则：最近一条带工具调用的 assistant 消息，如果当时带着思考块，要原样传回来，而且排在最前面
  const lastAssistant = body.messages.findLast((message) => message.role === 'assistant');
  if (lastAssistant) {
    const blocks = blocksOf(lastAssistant);
    const toolIds = blocks.filter((block) => block.type === 'tool_use').map((block) => String(block.id));
    for (const [signature, record] of issued) {
      if (!record.toolIds.some((id) => toolIds.includes(id))) continue;
      const first = blocks[0];
      if (first?.type !== 'thinking' || first.signature !== signature || first.thinking !== record.thinking) {
        return `最后一条 assistant 消息带着工具调用，而模型当时还输出了思考内容：要把 thinking 块原样传回来（包括 signature），并且排在最前面（Anthropic 的原话：thinking blocks in the latest assistant message cannot be modified）`;
      }
    }
  }
  return undefined;
}

/** 脚本里的 finishReason 用的是 OpenAI 的叫法，换成 Anthropic 的 stop_reason；不认识的原样返回 */
export function toStopReason(finishReason: string): string {
  const map: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };
  return map[finishReason] ?? finishReason;
}

/** 状态码对应的 Anthropic 错误类型 */
export function errorType(status: number): string {
  const map: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    413: 'request_too_large',
    429: 'rate_limit_error',
    500: 'api_error',
    529: 'overloaded_error',
  };
  return map[status] ?? 'api_error';
}
