// 调用 OpenAI 兼容接口。名字里的 openai 指的是接口格式：DeepSeek、通义千问、GLM、Kimi、MiniMax、Ollama 都提供这种接口。
// 第 2 天的练习：补全 TODO 1、2，再去 errors.ts 和 usage.ts 补全 TODO 3–5。
// 检查：npm run check 2
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
  // TODO 1：拼出完整的请求体。现在只有 model 和 messages。
  // - tools：有工具才带上。有的接口不接受空数组，没有工具时不要带这个字段
  // - 采样参数换成接口的字段名：temperature、topP → top_p、maxTokens → max_tokens、stop
  // - 没传的参数不要出现在请求里。提示：值为 undefined 的字段，JSON.stringify 会直接跳过
  return {
    model: process.env.OPENAI_MODEL,
    messages: request.messages,
  };
}

/** 调用一次模型，等它全部生成完再返回 */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  const res = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(toRequestBody(request)),
  });
  // TODO 2：处理响应。
  // - 状态码不是 2xx（res.ok 为 false）：throw await toModelError(res)，toModelError 在 errors.ts 里（TODO 3）
  // - 成功：用 res.json() 解析，取出 choices[0]，返回 { message, finishReason, usage }
  //   - message 原样返回，不要只挑 content 和 tool_calls：推理模型的 reasoning_content 也在里面
  //   - finishReason 来自 finish_reason
  //   - usage 用 parseUsage(data.usage) 转换（TODO 4）
  throw new Error('TODO 2：还没有处理模型的响应');
}
