// 第 42 天：把研究助手的模型层换成 Vercel AI SDK。
// 换哪一层？第 7 天起，研究助手的每一行代码都只认 Model 接口（types.ts）。所以只要用 AI SDK 实现一个 Model，
// 上面的 Agent 循环、护栏、权限、注入防护、追踪、预算、评估一行都不用改，原有的测试和评估照样能跑。
// 这里的 Model 每次只调用一次模型：工具不给 execute，AI SDK 只负责「发请求、收回复」，循环仍然是我们自己的（第 6 天）。
// AI SDK 的多步循环、工具审批、结构化输出，用在 ai-agent.ts 里。
// 第 42 天的练习：TODO 1–4 在这里，TODO 5、6 在 ai-agent.ts。检查：npm run check 42
import { APICallError, generateText, jsonSchema, Output, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolChoice as AIToolChoice, type ToolSet } from 'ai';
import { ModelError } from './errors.ts';
import { fromAISDKUsage } from './frameworks/ai-sdk.ts';
import { safeParse } from './frameworks/common.ts';
import type { ChatOptions, ChatRequest, ChatResult, Message, Model, ToolCall, ToolChoice, ToolDefinition } from './types.ts';

type JSONSchemaInput = Parameters<typeof jsonSchema>[0];

/**
 * 我们的消息换成 AI SDK 的消息：
 * - system、user 原样
 * - assistant：有思考内容就先放一个 reasoning 部分，有文字放 text 部分，每个工具调用放一个 tool-call 部分（参数要解析成对象）
 * - tool：一个 tool-result 部分。AI SDK 要知道工具名，从前面 assistant 的工具调用里按 id 找
 */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  // TODO 1：按上面注释的规则逐条转换。用一个 Map 记下 assistant 消息里每个工具调用的 id → 工具名，tool 消息用它找回工具名（找不到写 unknown）。
  // 工具调用的参数用 safeParse 解析成对象；tool 消息的 output 写成 { type: 'text', value: 内容 }
  void safeParse;
  return messages as unknown as ModelMessage[];
}

/**
 * 工具定义换成 AI SDK 的工具：只有描述和 JSON Schema，没有 execute。没有 execute，AI SDK 就不会执行工具，
 * 只把模型的工具调用交回来。jsonSchema() 不带 validate，也不会替我们校验参数：参数不对时，第 11 天的错误信息更有用
 */
export function toToolSet(tools: ToolDefinition[]): ToolSet {
  // TODO 2（一）：每个工具定义变成 tool({ description, inputSchema: jsonSchema(parameters) })，不要 execute，放进 set[工具名]
  void tool;
  void jsonSchema;
  void tools;
  return {};
}

/** tool_choice：auto、none、required 原样；指定某个工具写成 { type: 'tool', toolName } */
export function toAIToolChoice(choice: ToolChoice | undefined): AIToolChoice<ToolSet> | undefined {
  // TODO 2（二）：undefined 和字符串原样返回；指定工具的换成 { type: 'tool', toolName }
  return choice as AIToolChoice<ToolSet> | undefined;
}

/** finish_reason 换回 OpenAI 的叫法：Agent 循环（第 6 天）认的是这些 */
export function toFinishReason(reason: string, raw?: string): string {
  // TODO 2（三）：stop → stop，tool-calls → tool_calls，length → length，content-filter → content_filter；其他的返回 raw，没有 raw 返回 reason
  void raw;
  return reason;
}

/**
 * AI SDK 的错误换成 ModelError：第 9 天的重试、第 35 天的故障转移都按 ModelError 的状态码和响应头判断。
 * 不是接口错误的（取消、网络、我们自己的错误）原样返回
 */
export function toModelErrorFromAISDK(error: unknown): unknown {
  // TODO 3：不是 APICallError（用 APICallError.isInstance 判断）、或者没有 statusCode 的，原样返回。
  // 否则尝试把 responseBody 解析成 { error: { message, code, type } }（解析不了就用 error.message），
  // 返回 new ModelError(状态码, `模型调用失败（状态码）：信息`, { code, type, headers: new Headers(responseHeaders ?? {}) })
  void APICallError;
  void ModelError;
  return error;
}

/** 输出格式：json_object 用 Output.json()，json_schema 用 Output.object()。AI SDK 会在请求里带上 response_format */
function toOutput(request: ChatRequest) {
  const format = request.responseFormat;
  if (format?.type === 'json_object') return Output.json();
  if (format?.type === 'json_schema') return Output.object({ schema: jsonSchema(format.json_schema.schema as JSONSchemaInput), name: format.json_schema.name });
  return undefined;
}

export interface AISDKModelOptions {
  /** 显示和记录用的名字，默认 ai-sdk */
  name?: string;
}

/**
 * 用 AI SDK 实现我们的 Model：
 * - 消息、工具、tool_choice、输出格式用上面的函数转换；采样参数改名对应（maxTokens → maxOutputTokens，stop → stopSequences）
 * - maxRetries 设成 0：重试归第 9 天的 withRetry 管，两层都重试，一次故障会变成好几倍的请求
 * - stopWhen 是一步：只调用一次模型，循环是我们自己的
 * - allowSystemInMessages：system 消息就在 messages 里，位置不动
 * - 有 onText 或 onReasoning 时用 streamText，边收边回调（text-delta、reasoning-delta）；流里的 error 部分要抛出来
 * - 回复换回我们的 ChatResult；出错换成 ModelError
 */
export function createAISDKChatModel(model: LanguageModel, options: AISDKModelOptions = {}): Model {
  return {
    name: options.name ?? 'ai-sdk',
    async chat(request: ChatRequest, chatOptions: ChatOptions = {}): Promise<ChatResult> {
      // TODO 4：按上面注释的规则实现：
      // - 参数：model、messages（toModelMessages）、allowSystemInMessages: true、有工具时 tools（toToolSet）和 toolChoice（toAIToolChoice）、
      //   output（toOutput）、temperature、topP、maxOutputTokens、stopSequences、maxRetries: 0、stopWhen: stepCountIs(1)、abortSignal
      // - 有 onText 或 onReasoning：streamText（加上 onError: () => {}），遍历 fullStream：text-delta 和 reasoning-delta 的文字在 part.text，
      //   遇到 error 部分抛出 part.error；最后 await 出 text、reasoningText、toolCalls、finishReason、rawFinishReason、totalUsage，交给 toChatResult
      // - 否则 generateText，结果交给 toChatResult
      // - 整个过程 try/catch，抛出 toModelErrorFromAISDK(error)
      void generateText; void streamText; void stepCountIs; void toOutput; void model; void request; void chatOptions;
      throw new Error('TODO 4：还没有实现 AI SDK 的 Model');
    },
  };
}

interface StepLike {
  text: string;
  reasoningText: string | undefined;
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
  finishReason: string;
  rawFinishReason: string | undefined;
  totalUsage: Parameters<typeof fromAISDKUsage>[0];
}

/** AI SDK 的结果换回 ChatResult。工具调用的参数要序列化回字符串，和接口返回的一样（包括叫错名字的调用：交给第 11 天处理） */
export function toChatResult(r: StepLike): ChatResult {
  // TODO 2（四）：
  // - 每个工具调用变成 { id: toolCallId, type: 'function', function: { name: toolName, arguments } }，arguments 是字符串就原样，否则 JSON.stringify（undefined 当作 {}）
  // - message：content 是 text；text 为空时，有工具调用写 null，没有写 ''。有工具调用才加 tool_calls，有思考才加 reasoning_content
  // - finishReason 用 toFinishReason，usage 用 fromAISDKUsage
  void fromAISDKUsage;
  return { message: { role: 'assistant', content: r.text }, finishReason: r.finishReason, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
}
