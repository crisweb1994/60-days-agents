// 第 59 天手写题一：Agent 循环。面试里最常见的一道：不用任何框架，20 分钟写出来。
// 要点：把回复原样放回历史；工具并行执行、结果按调用的顺序交回；工具出错、叫错名字、参数坏了都当作结果交给模型；最大步数。
export interface Call {
  id: string;
  name: string;
  /** JSON 字符串 */
  arguments: string;
}

export type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Call[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Reply {
  content: string | null;
  tool_calls?: Call[];
}

export type Chat = (messages: Msg[]) => Promise<Reply>;
export type Tools = Record<string, (args: any) => unknown>;

export interface LoopResult {
  status: 'completed' | 'max_steps';
  answer: string;
  steps: number;
  messages: Msg[];
}

/** 执行一个工具调用，什么情况都返回一段文字，不抛错 */
async function runOne(tools: Tools, call: Call): Promise<string> {
  const tool = tools[call.name];
  if (!tool) return `没有工具 ${call.name}，可用的：${Object.keys(tools).join('、')}`;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return `参数不是合法的 JSON：${call.arguments}`;
  }
  try {
    const out = await tool(args);
    return typeof out === 'string' ? out : JSON.stringify(out);
  } catch (error) {
    return `出错：${(error as Error).message}`;
  }
}

/**
 * Agent 循环：
 * - messages 从 [system（有的话）, user] 开始；每一步调用 chat(messages)，回复原样（role: assistant）放进历史，steps 加一
 * - 没有工具调用：completed，answer 是回复的文字（null 当作空字符串）
 * - 有：所有调用并行执行（runOne），每个结果一条 { role: 'tool', tool_call_id, content }，按调用的顺序放进历史，接着下一步
 * - 调用了 maxSteps（默认 10）次模型还没结束：max_steps，answer 是空字符串
 */
export async function runLoop(question: string, { chat, tools, system, maxSteps = 10 }: { chat: Chat; tools: Tools; system?: string; maxSteps?: number }): Promise<LoopResult> {
  const messages: Msg[] = [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user', content: question }];
  for (let steps = 1; steps <= maxSteps; steps++) {
    const reply = await chat(messages);
    messages.push({ role: 'assistant', content: reply.content, ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) });
    if (!reply.tool_calls?.length) return { status: 'completed', answer: reply.content ?? '', steps, messages };
    const results = await Promise.all(reply.tool_calls.map((c) => runOne(tools, c)));
    reply.tool_calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }));
  }
  return { status: 'max_steps', answer: '', steps: maxSteps, messages };
}
