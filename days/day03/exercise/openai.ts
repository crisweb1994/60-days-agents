// 调用 OpenAI 兼容接口。名字里的 openai 指的是接口格式：DeepSeek、通义千问、GLM、Kimi、MiniMax、Ollama 都提供这种接口。
// 第 3 天的练习：先去 sse.ts 完成 TODO 1，再回来完成 TODO 2、3，最后是 agent.ts 里的 TODO 4。
// 检查：npm run check 3
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
      // TODO 2：把这一块合并进去，返回这一块新增的文字和思考内容。
      // - chunk.usage 不为空就记下来（用 parseUsage 转换）。它可能在 choices 为空数组的单独一块里，
      //   也可能挂在带 finish_reason 的最后一块上，所以先处理它，再看 choices
      // - 取 chunk.choices?.[0]，没有就返回空字符串
      // - finish_reason 不为空就记下来
      // - delta.content 接到 content 后面，delta.reasoning_content 接到 reasoning 后面
      // - delta.tool_calls 里的每一项，按 index 找到（或新建）对应的工具调用：
      //   - id、function.name 有值就赋值。有的模型服务每块都带，不能拼接
      //   - function.arguments 拼接到后面
      return { text: '', reasoning: '' };
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
  // TODO 3：流式调用一次模型。
  // - 请求体在 toRequestBody(request) 的基础上，加上 stream: true 和 stream_options: { include_usage: true }
  // - 用 post(body, options.signal) 发请求：带上 signal，才能中途取消
  // - 状态码不是 2xx：和 chat() 一样 throw await toModelError(res)
  // - 用 parseSSE(res.body!) 逐个读取事件：
  //   - data 是 [DONE]：结束
  //   - 否则 JSON.parse 成 ChatCompletionChunk，交给 accumulator.push()
  //   - push() 返回了新增的文字就回调 options.onText，新增了思考内容就回调 options.onReasoning
  //   - 记下有没有收到过 finish_reason
  // - 一直没收到 finish_reason 流就结束了，说明连接中途断了：抛出错误，不要返回半截回复
  // - 最后返回 accumulator.result()
  const accumulator = createAccumulator();
  throw new Error('TODO 3：还没有实现流式调用');
}
