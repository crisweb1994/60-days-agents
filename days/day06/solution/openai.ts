// 调用 OpenAI 兼容接口。名字里的 openai 指的是接口格式：DeepSeek、通义千问、GLM、Kimi、MiniMax、Ollama 都提供这种接口。
import { ModelError, toModelError } from './errors.ts';
import { parseSSE } from './sse.ts';
import type { AssistantMessage, ChatOptions, ChatRequest, ChatResult, ToolCall } from './types.ts';
import { emptyUsage, parseUsage, type RawUsage, type Usage } from './usage.ts';

/** 接口返回的 JSON 里，我们用得到的部分 */
type ChatCompletion = {
  choices: { message: AssistantMessage; finish_reason: string }[];
  usage?: RawUsage;
};

/** 流式返回的一块。delta 里只有这一块新增的内容 */
export type ChatCompletionChunk = {
  choices?: {
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
};

/** 把 ChatRequest 转成接口要的请求体：字段名换成下划线风格，没传的参数不发 */
export function toRequestBody(request: ChatRequest): Record<string, unknown> {
  return {
    model: process.env.OPENAI_MODEL,
    messages: request.messages,
    // 有的接口不接受空的 tools 数组，没有工具时干脆不带这个字段
    tools: request.tools?.length ? request.tools : undefined,
    tool_choice: request.toolChoice,
    response_format: request.responseFormat,
    // 值为 undefined 的字段，JSON.stringify 会直接跳过，所以没传的参数不会出现在请求里
    temperature: request.temperature,
    top_p: request.topP,
    max_tokens: request.maxTokens,
    stop: request.stop,
  };
}

function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });
}

/** 调用一次模型，等它全部生成完再返回 */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  const res = await post(toRequestBody(request));
  if (!res.ok) throw await toModelError(res);
  const data = (await res.json()) as ChatCompletion;
  const [choice] = data.choices;
  // message 原样返回：推理模型的 reasoning_content 也在里面，放回历史时要带上
  return { message: choice.message, finishReason: choice.finish_reason, usage: parseUsage(data.usage) };
}

/** 把流式返回的一块块增量，拼成和非流式一样的完整回复 */
export function createAccumulator() {
  let content = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  let finishReason = '';
  let usage: Usage = emptyUsage();

  return {
    /** 合并一块，返回这一块新增的文字和思考内容 */
    push(chunk: ChatCompletionChunk): { text: string; reasoning: string } {
      // usage 有的在单独的最后一块里（choices 是空数组），有的挂在带 finish_reason 的那一块上
      if (chunk.usage) usage = parseUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) return { text: '', reasoning: '' };
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const text = delta.content ?? '';
      const thinking = delta.reasoning_content ?? '';
      content += text;
      reasoning += thinking;
      for (const part of delta.tool_calls ?? []) {
        // 同一个工具调用的参数分散在好几块里，靠 index 认出是哪一个
        const call = (toolCalls[part.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        // id 和 name 一般只在第一块出现；有的模型服务每块都带，所以是赋值而不是拼接
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name = part.function.name;
        call.function.arguments += part.function?.arguments ?? '';
      }
      return { text, reasoning: thinking };
    },

    /** 全部合并完以后，得到完整的回复 */
    result(): ChatResult {
      const message: AssistantMessage = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.length) message.tool_calls = toolCalls;
      return { message, finishReason, usage };
    },
  };
}

/** 流式调用一次模型：每生成一段文字就回调 onText，全部生成完再返回完整的回复 */
export async function chatStream(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
  // include_usage：让接口在最后交回 usage。不加的话，有的模型服务在流式模式下不返回用量
  const body = { ...toRequestBody(request), stream: true, stream_options: { include_usage: true } };
  const res = await post(body, options.signal);
  if (!res.ok) throw await toModelError(res);

  const accumulator = createAccumulator();
  let finished = false;
  for await (const { data } of parseSSE(res.body!)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data) as ChatCompletionChunk & { error?: { message?: string } };
    // 有的模型服务在输出过程中出错时，会在流里发一个 error 对象
    if (chunk.error) throw new ModelError(res.status, `模型在输出过程中出错：${chunk.error.message}`);
    const { text, reasoning } = accumulator.push(chunk);
    if (reasoning) options.onReasoning?.(reasoning);
    if (text) options.onText?.(text);
    if (chunk.choices?.[0]?.finish_reason) finished = true;
  }
  // 没收到 finish_reason 就结束了，说明回复不完整，不能当成正常的回答
  if (!finished) throw new Error('流式响应没有正常结束：还没收到 finish_reason，连接就关闭了');
  return accumulator.result();
}
