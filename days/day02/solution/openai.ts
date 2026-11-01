// 调用 OpenAI 兼容接口。名字里的 openai 指的是接口格式：DeepSeek、通义千问、GLM、Kimi、MiniMax、Ollama 都提供这种接口。
import { toModelError } from './errors.ts';
import type { AssistantMessage, ChatRequest, ChatResult } from './types.ts';
import { parseUsage, type RawUsage } from './usage.ts';

/** 接口返回的 JSON 里，我们用得到的部分 */
type ChatCompletion = {
  choices: { message: AssistantMessage; finish_reason: string }[];
  usage?: RawUsage;
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

/** 调用一次模型，等它全部生成完再返回 */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  const res = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(toRequestBody(request)),
  });
  if (!res.ok) throw await toModelError(res);
  const data = (await res.json()) as ChatCompletion;
  const [choice] = data.choices;
  // message 原样返回：推理模型的 reasoning_content 也在里面，放回历史时要带上
  return { message: choice.message, finishReason: choice.finish_reason, usage: parseUsage(data.usage) };
}
