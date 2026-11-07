// 和模型交换的数据：消息、工具定义、一次请求和一次回复。
import type { Usage } from './usage.ts';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/** Anthropic 协议的思考块。签名证明它是模型生成的，回传时必须原样带上 */
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  /** 推理模型的思考内容。DeepSeek、通义千问、GLM、Kimi 都用这个字段名；Anthropic 协议的思考文字也会放在这里，方便显示 */
  reasoning_content?: string;
  /** Anthropic 协议返回的思考块，原样保存，下一次请求时原样传回（第 8 天） */
  thinking_blocks?: ThinkingBlock[];
};

export type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: 'function';
  function: { name: string; description?: string; parameters: object };
};

/** 让模型按什么格式输出。字段和接口的写法一致 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: object; strict?: boolean } };

/** 模型要不要调用工具：auto 由它决定，none 不调用，required 必须调用，也可以指定某个工具 */
export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/** 一次请求。采样参数都是可选的：不传，就用模型服务的默认值 */
export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** 输出格式：JSON 模式或 JSON Schema 约束（第 4 天） */
  responseFormat?: ResponseFormat;
  /** 随机程度，越低越稳定。各家的取值范围不一样，有的模型不让改 */
  temperature?: number;
  /** 核采样，一般和 temperature 只调一个 */
  topP?: number;
  /** 这次最多输出多少 token。超出就截断，finish_reason 为 length */
  maxTokens?: number;
  /** 生成到这些字符串时停止 */
  stop?: string[];
}

/** 一次回复 */
export interface ChatResult {
  message: AssistantMessage;
  /** 模型为什么停下：stop、length、tool_calls……第 6 天细讲 */
  finishReason: string;
  usage: Usage;
}

/** 调用模型时的回调和取消信号 */
export interface ChatOptions {
  /** 模型每生成一段文字，就回调一次，拿到的是新增的部分 */
  onText?: (text: string) => void;
  /** 推理模型每生成一段思考内容，就回调一次 */
  onReasoning?: (text: string) => void;
  /** 用来取消请求，比如用户按了 Ctrl+C */
  signal?: AbortSignal;
}

/**
 * 一个能调用的模型。Agent 只依赖这个接口：背后是哪家的接口、哪种协议、是真模型还是测试用的假模型，它都不关心。
 * 有两个实现：createOpenAIModel（openai.ts）和 createAnthropicModel（anthropic.ts）
 */
export interface Model {
  /** 用来显示和记录，比如 openai:deepseek-flash */
  readonly name: string;
  /** 调用一次模型。有 onText 时边生成边回调，最后返回完整的回复 */
  chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult>;
}
