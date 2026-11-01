// 和模型交换的数据：消息、工具定义、一次请求和一次回复。第 1 天写在 agent.ts 里，今天单独放一个文件。
import type { Usage } from './usage.ts';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  /** 推理模型的思考内容。DeepSeek、通义千问、GLM、Kimi 都用这个字段名 */
  reasoning_content?: string;
};

export type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: 'function';
  function: { name: string; description?: string; parameters: object };
};

/** 一次请求。采样参数都是可选的：不传，就用模型服务的默认值 */
export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
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
