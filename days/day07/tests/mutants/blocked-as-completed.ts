// 故意藏了一个 bug 的 Agent，用来检查你写的测试能不能发现它：被内容审核拦截时当成正常完成。
// 除了这一处，其余和参考答案完全一样。
import { runToolCalls, toToolDefinition, type Tool, type ToolResult } from '../../solution/tool.ts';
import type { Message, Model, ToolCall } from '../../solution/types.ts';
import { addUsage, emptyUsage, type Usage } from '../../solution/usage.ts';

const SYSTEM_PROMPT = '你是一个能使用工具的助手。能用工具得到准确结果时就用工具，不要猜。';

/** 正常结束的两种 finish_reason。有的兼容接口在调用工具时也返回 stop */
const NORMAL = new Set(['stop', 'tool_calls', 'content_filter', 'sensitive']);
/** 输出被截断：达到 max_tokens，或者塞满了上下文窗口（GLM、Anthropic 有这个取值） */
const TRUNCATED = new Set(['length', 'model_context_window_exceeded']);
/** 被内容审核拦截：OpenAI 是 content_filter，GLM 是 sensitive */
const BLOCKED = new Set(['content_filter', 'sensitive']);

/**
 * 循环为什么停下：
 * - completed：模型给出了最终回答
 * - max_steps：步数用完了，模型还在调用工具
 * - repeated_calls：模型反复用同样的参数调用同一个工具
 * - tool_errors：工具连续出错
 * - truncated：输出被截断
 * - blocked：被内容审核拦截
 * - unexpected：不认识的 finish_reason，或者模型什么都没说
 */
export type AgentStatus =
  | 'completed'
  | 'max_steps'
  | 'repeated_calls'
  | 'tool_errors'
  | 'truncated'
  | 'blocked'
  | 'unexpected';

export interface AgentOptions {
  /** 用哪个模型。Agent 自己不创建模型，由调用方传进来 */
  model: Model;
  tools: Tool[];
  /** 最多调用几次模型，默认 10 */
  maxSteps?: number;
  /** 名称和参数都相同的工具调用，最多执行几次，默认 2 */
  maxRepeats?: number;
  /** 工具连续出错几次就停下，默认 3 */
  maxToolErrors?: number;
  onUsage?: (usage: Usage) => void;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (call: ToolCall, result: ToolResult) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  status: AgentStatus;
  /** 最后一条回复的文字。没有正常完成时，可能是半截的，也可能是空的 */
  answer: string;
  /** 最后一次调用的 finish_reason，排查问题时有用 */
  finishReason: string;
  /** 调用了几次模型 */
  steps: number;
  usage: Usage;
  /** 完整的对话历史 */
  messages: Message[];
}

/** 用来判断两次工具调用是不是一模一样。参数先解析再序列化，忽略空格之类的差别 */
function callKey(call: ToolCall): string {
  let args = call.function.arguments;
  try {
    args = JSON.stringify(JSON.parse(args));
  } catch {
    // 不是合法的 JSON，就按原样比较
  }
  return `${call.function.name} ${args}`;
}

export async function runAgent(question: string, options: AgentOptions): Promise<AgentResult> {
  const { model, tools, maxSteps = 10, maxRepeats = 2, maxToolErrors = 3 } = options;
  const { onUsage, onText, onReasoning, onToolCall, signal } = options;
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const definitions = tools.map(toToolDefinition);
  const seen = new Map<string, number>(); // 每种工具调用执行过几次
  let usage = emptyUsage();
  let toolErrors = 0; // 连续出错的工具调用数
  let answer = '';
  let finishReason = '';
  let steps = 0;
  let pending: ToolCall[] = []; // 模型最新一轮发起、还没交回结果的工具调用
  const finish = (status: AgentStatus): AgentResult => {
    // 停下时如果还有没执行的工具调用（比如被截断了、在原地打转），给它们补上结果。
    // 每个工具调用后面都要有结果，历史才是完整的，第 10 天的多轮对话才能接着往下聊
    for (const call of pending) messages.push({ role: 'tool', tool_call_id: call.id, content: '没有执行：Agent 已经停止' });
    return { status, answer, finishReason, steps, usage, messages };
  };

  // 护栏一（上）：最多调用 maxSteps 次模型
  while (steps < maxSteps) {
    steps++;
    const result = await model.chat({ messages, tools: definitions }, { onText, onReasoning, signal });
    usage = addUsage(usage, result.usage);
    onUsage?.(result.usage);
    const reply = result.message;
    messages.push(reply);
    answer = reply.content ?? '';
    finishReason = result.finishReason;
    const calls = reply.tool_calls ?? [];
    pending = calls;

    // 护栏二：先看模型为什么停下，不正常就不再往下走。截断时工具参数可能也不完整，不能执行
    if (TRUNCATED.has(finishReason)) return finish('truncated');
    if (!NORMAL.has(finishReason)) return finish('unexpected');
    if (calls.length === 0) return finish(answer.trim() ? 'completed' : 'unexpected');

    // 护栏一（下）：同样的调用已经执行过 maxRepeats 次，再执行结果也不会变，说明模型在原地打转
    for (const call of calls) {
      const key = callKey(call);
      const count = (seen.get(key) ?? 0) + 1;
      if (count > maxRepeats) return finish('repeated_calls');
      seen.set(key, count);
    }

    const results = await runToolCalls(tools, calls, { signal });
    calls.forEach((call, i) => {
      onToolCall?.(call, results[i]);
      messages.push({ role: 'tool', tool_call_id: call.id, content: results[i].content });
    });
    pending = [];

    // 护栏三：出错的结果已经交回模型，让它有机会改正；但连续出错太多次，就别再浪费了
    for (const toolResult of results) toolErrors = toolResult.isError ? toolErrors + 1 : 0;
    if (toolErrors >= maxToolErrors) return finish('tool_errors');
  }
  return finish('max_steps');
}

/** 没有正常完成时，给用户看的说明 */
export function describeStatus(result: AgentResult): string {
  switch (result.status) {
    case 'completed':
      return '';
    case 'max_steps':
      return `调用了 ${result.steps} 次模型还没有完成，已停止`;
    case 'repeated_calls':
      return '模型反复用同样的参数调用同一个工具，已停止';
    case 'tool_errors':
      return '工具连续出错，已停止';
    case 'truncated':
      return '回答达到了长度上限，被截断了';
    case 'blocked':
      return '回答被内容审核拦截了';
    case 'unexpected':
      return `模型异常停止（finish_reason：${result.finishReason || '空'}）`;
  }
}
