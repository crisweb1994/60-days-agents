// 第 6 天：带三道护栏的 Agent 循环。
// 护栏一：防止死循环（最大步数、重复调用）；护栏二：处理异常停止（截断、拦截、未知原因）；护栏三：工具连续出错时停下。
// 第 6 天的练习：在 runAgent() 里补上 TODO 1–4。检查：npm run check 6
// 直接运行：node days/day06/exercise/agent.ts "算一下 (1234 + 5678) * 9，再把结果写进 result.txt"
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatStream } from './openai.ts';
import { runToolCalls, toToolDefinition, type Tool, type ToolResult } from './tool.ts';
import { createTools } from './tools/index.ts';
import type { Message, ToolCall } from './types.ts';
import { addUsage, emptyUsage, formatUsage, parsePrice, type Usage } from './usage.ts';

const SYSTEM_PROMPT = '你是一个能使用工具的助手。能用工具得到准确结果时就用工具，不要猜。';

/** 正常结束的两种 finish_reason。有的兼容接口在调用工具时也返回 stop */
const NORMAL = new Set(['stop', 'tool_calls']);
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
  const { tools, maxSteps = 10, maxRepeats = 2, maxToolErrors = 3, onUsage, onText, onReasoning, onToolCall, signal } =
    options;
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
    // TODO 4：停下时如果还有没执行的工具调用（pending 不为空，比如被截断了、在原地打转），
    // 给每一个补上一条 tool 消息，比如「没有执行：Agent 已经停止」。
    // 每个工具调用后面都要有结果，历史才是完整的，第 10 天的多轮对话才能接着往下聊
    return { status, answer, finishReason, steps, usage, messages };
  };

  // TODO 1（上）：现在的循环没有上限。改成最多调用 maxSteps 次模型，用完了就 return finish('max_steps')
  while (true) {
    steps++;
    const result = await chatStream({ messages, tools: definitions }, { onText, onReasoning, signal });
    usage = addUsage(usage, result.usage);
    onUsage?.(result.usage);
    const reply = result.message;
    messages.push(reply);
    answer = reply.content ?? '';
    finishReason = result.finishReason;
    const calls = reply.tool_calls ?? [];
    pending = calls;

    // TODO 2：先看模型为什么停下，不正常就 return finish(对应的 status)，不再往下走：
    // - finishReason 在 TRUNCATED 里：truncated。工具参数可能也被截断了，不能执行
    // - 在 BLOCKED 里：blocked
    // - 不在 NORMAL 里（不认识的取值）：unexpected
    // - 没有工具调用：有回答（去掉空白后不为空）就是 completed，什么都没说就是 unexpected
    if (calls.length === 0) return finish('completed');

    // TODO 1（下）：用 callKey(call) 判断两个调用是不是一样，用 seen 记下每种调用执行过几次。
    // 某个调用这次执行就会超过 maxRepeats 次：说明模型在原地打转，return finish('repeated_calls')，不再执行

    const results = await runToolCalls(tools, calls, { signal });
    calls.forEach((call, i) => {
      onToolCall?.(call, results[i]);
      messages.push({ role: 'tool', tool_call_id: call.id, content: results[i].content });
    });
    pending = [];

    // TODO 3：出错的结果已经交回模型，让它有机会改正。但要数一数工具连续出错了几次（toolErrors）：
    // 按顺序看每个结果，出错就加一，成功就清零。达到 maxToolErrors 就 return finish('tool_errors')
  }
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

// 直接运行这个文件时：边生成边打印回答，显示每一次工具调用；没有正常完成时说明原因
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  const price = parsePrice(process.env.OPENAI_PRICE);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  // 思考、回答、工具调用三种输出之间空一行；思考内容用暗色显示
  let lastKind = '';
  const print = (kind: 'thinking' | 'text' | 'tool', text: string) => {
    if (lastKind && lastKind !== kind) process.stdout.write('\n\n');
    else if (kind === 'tool' && lastKind === 'tool') process.stdout.write('\n');
    lastKind = kind;
    process.stdout.write(kind === 'thinking' ? `\x1b[2m${text}\x1b[0m` : text);
  };
  try {
    const result = await runAgent(process.argv[2] ?? '计算 (1234 + 5678) * 9，再把算式和结果写进 result.txt', {
      tools: createTools(workspace),
      signal: controller.signal,
      onReasoning: (text) => print('thinking', text),
      onText: (text) => print('text', text),
      onToolCall: (call, toolResult) => {
        const status = toolResult.isError ? '✗' : '✓';
        print('tool', `${status} ${call.function.name} ${call.function.arguments}\n  ${toolResult.content.split('\n')[0]}`);
      },
    });
    if (result.status !== 'completed') console.log(`\n\n（${describeStatus(result)}）`);
    console.log(`\n\n合计 ${result.steps} 次调用：${formatUsage(result.usage, price)}`);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log('\n（已中断）');
    process.exitCode = 130;
  }
}
