// 第 42 天：把研究助手的模型层换成 Vercel AI SDK。
// 换哪一层？第 7 天起，研究助手的每一行代码都只认 Model 接口（types.ts）。所以只要用 AI SDK 实现一个 Model，
// 上面的 Agent 循环、护栏、权限、注入防护、追踪、预算、评估一行都不用改，原有的测试和评估照样能跑。
// 这里的 Model 每次只调用一次模型：工具不给 execute，AI SDK 只负责「发请求、收回复」，循环仍然是我们自己的（第 6 天）。
// AI SDK 的多步循环、工具审批、结构化输出，用在 ai-agent.ts 里。
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
  const names = new Map<string, string>();
  return messages.map((m): ModelMessage => {
    if (m.role === 'tool') {
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id, toolName: names.get(m.tool_call_id) ?? 'unknown', output: { type: 'text', value: m.content } }] };
    }
    if (m.role !== 'assistant') return { role: m.role, content: m.content };
    const parts: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = [];
    if (m.reasoning_content) parts.push({ type: 'reasoning', text: m.reasoning_content });
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const call of m.tool_calls ?? []) {
      names.set(call.id, call.function.name);
      parts.push({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: safeParse(call.function.arguments) });
    }
    return { role: 'assistant', content: parts };
  });
}

/**
 * 工具定义换成 AI SDK 的工具：只有描述和 JSON Schema，没有 execute。没有 execute，AI SDK 就不会执行工具，
 * 只把模型的工具调用交回来。jsonSchema() 不带 validate，也不会替我们校验参数：参数不对时，第 11 天的错误信息更有用
 */
export function toToolSet(tools: ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) set[t.function.name] = tool({ description: t.function.description, inputSchema: jsonSchema<unknown>(t.function.parameters as JSONSchemaInput) });
  return set;
}

/** tool_choice：auto、none、required 原样；指定某个工具写成 { type: 'tool', toolName } */
export function toAIToolChoice(choice: ToolChoice | undefined): AIToolChoice<ToolSet> | undefined {
  if (choice === undefined || typeof choice === 'string') return choice;
  return { type: 'tool', toolName: choice.function.name };
}

/** finish_reason 换回 OpenAI 的叫法：Agent 循环（第 6 天）认的是这些 */
export function toFinishReason(reason: string, raw?: string): string {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    default:
      return raw || reason;
  }
}

/**
 * AI SDK 的错误换成 ModelError：第 9 天的重试、第 35 天的故障转移都按 ModelError 的状态码和响应头判断。
 * 不是接口错误的（取消、网络、我们自己的错误）原样返回
 */
export function toModelErrorFromAISDK(error: unknown): unknown {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return error;
  let code: string | undefined;
  let type: string | undefined;
  let detail = error.message;
  try {
    const body = JSON.parse(error.responseBody ?? '') as { error?: { message?: string; code?: unknown; type?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code != null) code = String(body.error.code);
    type = body.error?.type;
  } catch {
    // 不是 JSON，用 AI SDK 给的信息
  }
  return new ModelError(error.statusCode, `模型调用失败（${error.statusCode}）：${detail}`, { code, type, headers: new Headers(error.responseHeaders ?? {}) });
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
      const { onText, onReasoning, signal } = chatOptions;
      const params = {
        model,
        messages: toModelMessages(request.messages),
        allowSystemInMessages: true,
        ...(request.tools?.length ? { tools: toToolSet(request.tools), toolChoice: toAIToolChoice(request.toolChoice) } : {}),
        output: toOutput(request),
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        stopSequences: request.stop,
        maxRetries: 0,
        stopWhen: stepCountIs(1),
        abortSignal: signal,
      };
      try {
        if (onText || onReasoning) {
          const stream = streamText({ ...params, onError: () => {} });
          for await (const part of stream.fullStream) {
            if (part.type === 'text-delta') onText?.(part.text);
            else if (part.type === 'reasoning-delta') onReasoning?.(part.text);
            else if (part.type === 'error') throw part.error;
          }
          return toChatResult({
            text: await stream.text,
            reasoningText: await stream.reasoningText,
            toolCalls: await stream.toolCalls,
            finishReason: await stream.finishReason,
            rawFinishReason: await stream.rawFinishReason,
            totalUsage: await stream.totalUsage,
          });
        }
        return toChatResult(await generateText(params));
      } catch (error) {
        throw toModelErrorFromAISDK(error);
      }
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
  const toolCalls: ToolCall[] = r.toolCalls.map((c) => ({
    id: c.toolCallId,
    type: 'function',
    function: { name: c.toolName, arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}) },
  }));
  return {
    message: {
      role: 'assistant',
      content: r.text || (toolCalls.length ? null : ''),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(r.reasoningText ? { reasoning_content: r.reasoningText } : {}),
    },
    finishReason: toFinishReason(r.finishReason, r.rawFinishReason),
    usage: fromAISDKUsage(r.totalUsage),
  };
}
