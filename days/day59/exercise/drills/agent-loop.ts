// 第 59 天手写题一：Agent 循环。面试里最常见的一道：不用任何框架，20 分钟写出来。
// 第 59 天的练习：TODO 1 在这里，20 分钟。不要看前面任何一天的代码，计时写。检查：npm run check 59
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
  // TODO 1（一）：找工具、解析参数、执行；三种出错都返回文字（见测试里的写法）
  void tools; void call;
  return '';
}

/**
 * Agent 循环：
 * - messages 从 [system（有的话）, user] 开始；每一步调用 chat(messages)，回复原样（role: assistant）放进历史，steps 加一
 * - 没有工具调用：completed，answer 是回复的文字（null 当作空字符串）
 * - 有：所有调用并行执行（runOne），每个结果一条 { role: 'tool', tool_call_id, content }，按调用的顺序放进历史，接着下一步
 * - 调用了 maxSteps（默认 10）次模型还没结束：max_steps，answer 是空字符串
 */
export async function runLoop(question: string, { chat, tools, system, maxSteps = 10 }: { chat: Chat; tools: Tools; system?: string; maxSteps?: number }): Promise<LoopResult> {
  // TODO 1（二）
  void question; void chat; void tools; void system; void maxSteps;
  throw new Error('TODO 1：还没有实现 runLoop');
}
