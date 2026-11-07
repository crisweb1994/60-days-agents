// 第 10 天：Agent 循环加上两样东西：接着之前的对话往下聊（history），以及执行有副作用的工具之前征得用户同意（confirm）。
// 命令行程序在 cli.ts，多轮对话的状态在 session.ts。
// 第 26 天：stopOn：成功执行了这些工具就停下，把控制权交回调用方（多 Agent 的交接要用到）。
// 第 28 天：工具列表可以在运行中变长（按需检索工具），每一步都按当前的 tools 重新生成工具定义。
// 第 29 天：人在回路。按权限策略决定工具要不要问用户；没人可问时，循环暂停（paused），把现场交给调用方保存，
// 用户批准或者回答以后，用 resumeAgent 从停下的地方接着跑。
// 第 29 天的练习：TODO 3、4 在这里。检查：npm run check 29
import type { PermissionPolicy } from './permissions.ts';
import {
  executeTool,
  runToolCalls,
  toToolDefinition,
  type ApprovalRequest,
  type Interrupt,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './tool.ts';
import type { Message, Model, ToolCall } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';

export const SYSTEM_PROMPT = '你是一个能使用工具的助手。能用工具得到准确结果时就用工具，不要猜。';

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
 * - stopped：成功执行了 stopOn 里的工具，按约定停下（第 26 天）
 * - paused：有工具调用在等用户批准或者回答，暂停了（第 29 天）
 */
export type AgentStatus =
  | 'completed'
  | 'max_steps'
  | 'repeated_calls'
  | 'tool_errors'
  | 'truncated'
  | 'blocked'
  | 'unexpected'
  | 'stopped'
  | 'paused';

export interface AgentOptions {
  /** 用哪个模型。Agent 自己不创建模型，由调用方传进来 */
  model: Model;
  tools: Tool[];
  /** system prompt，默认是 SYSTEM_PROMPT。研究助手用 web.ts 里的 RESEARCH_PROMPT（第 12 天） */
  system?: string;
  /** 之前的对话历史（上一次运行返回的 messages）。有它就接着往下聊，没有就从 system prompt 开始 */
  history?: Message[];
  /** 执行有副作用的工具之前，问用户同不同意。不提供时，这类工具一律不执行 */
  confirm?: (request: ApprovalRequest) => Promise<boolean>;
  /** 最多调用几次模型，默认 10 */
  maxSteps?: number;
  /** 名称和参数都相同的工具调用，最多执行几次，默认 2 */
  maxRepeats?: number;
  /** 工具连续出错几次就停下，默认 3 */
  maxToolErrors?: number;
  /** 成功执行了这些工具（结果不是错误）就停下，status 是 stopped。比如交接给另一个 Agent 的工具（第 26 天） */
  stopOn?: string[];
  onUsage?: (usage: Usage) => void;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (call: ToolCall, result: ToolResult) => void;
  signal?: AbortSignal;
  /** 权限策略：按风险等级决定允许、问用户还是禁止（第 29 天） */
  policy?: PermissionPolicy;
  /** 用户说过「以后都可以」的工具。恢复时用户选了 always，会加进这里（第 29 天） */
  grants?: Set<string>;
  /** 要问用户、又没有 confirm 或 ask 时，暂停而不是当作拒绝（第 29 天） */
  pausable?: boolean;
  /** 直接问用户一个问题（ask_user 用）（第 29 天） */
  ask?: ToolContext['ask'];
}

/** 一次暂停时的现场：恢复时要用到的全部状态。都是普通的数据，可以存成 JSON（第 29 天） */
export interface PausedRun {
  /** 对话历史，最后一条是带着工具调用的 assistant 消息，工具的结果还没放进去 */
  messages: Message[];
  /** 最近一轮的每个工具调用：已经执行完的带着 result，在等用户的带着 interrupt */
  calls: { call: ToolCall; result?: ToolResult; interrupt?: Interrupt }[];
  steps: number;
  usage: Usage;
  /** 护栏的计数：每种工具调用执行过几次、连续出错几次 */
  seen: [string, number][];
  toolErrors: number;
}

/** 用户对一个中断的答复：批准或者拒绝（always 表示这次会话里这个工具都可以）；或者回答问题 */
export type Resolution = { approved: boolean; always?: boolean } | { answer: string };

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
  /** 暂停时的现场（status 是 paused 时才有）（第 29 天） */
  paused?: PausedRun;
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

/** 循环里会变的状态。runAgent 从零开始，resumeAgent 从暂停的现场开始 */
interface LoopState {
  messages: Message[];
  steps: number;
  usage: Usage;
  seen: Map<string, number>;
  toolErrors: number;
}

export async function runAgent(question: string, options: AgentOptions): Promise<AgentResult> {
  // 接着之前的对话：复制一份历史再追加，不改调用方传进来的数组
  const messages: Message[] = options.history?.length
    ? [...options.history, { role: 'user', content: question }]
    : [
        { role: 'system', content: options.system ?? SYSTEM_PROMPT },
        { role: 'user', content: question },
      ];
  return loop({ messages, steps: 0, usage: emptyUsage(), seen: new Map(), toolErrors: 0 }, options);
}

/** 执行工具时的上下文：取消信号、确认、权限策略、能不能暂停、怎么问用户 */
function toolContext(options: AgentOptions): ToolContext {
  const { signal, confirm, policy, grants, pausable, ask } = options;
  return { signal, confirm, policy, grants, pausable, ask };
}

/**
 * Agent 循环。resumed 是恢复时已经有了结果的那一轮工具调用：先把它们的结果放进历史，再接着调用模型
 */
async function loop(state: LoopState, options: AgentOptions, resumed?: { calls: ToolCall[]; results: ToolResult[] }): Promise<AgentResult> {
  const { model, tools, maxSteps = 10, maxRepeats = 2, maxToolErrors = 3 } = options;
  const { onUsage, onText, onReasoning, onToolCall, signal } = options;
  const { messages, seen } = state;
  let answer = '';
  let finishReason = '';
  let pending: ToolCall[] = []; // 模型最新一轮发起、还没交回结果的工具调用
  const finish = (status: AgentStatus, paused?: PausedRun): AgentResult => {
    // 停下时如果还有没执行的工具调用（比如被截断了、在原地打转），给它们补上结果。
    // 每个工具调用后面都要有结果，历史才是完整的，第 10 天的多轮对话才能接着往下聊。
    // 暂停时不补：这些调用等用户回来以后还要接着执行
    if (!paused) for (const call of pending) messages.push({ role: 'tool', tool_call_id: call.id, content: '没有执行：Agent 已经停止' });
    return { status, answer, finishReason, steps: state.steps, usage: state.usage, messages, ...(paused ? { paused } : {}) };
  };

  /** 一轮工具调用都有了结果以后：放进历史，再看要不要停下 */
  const settle = (calls: ToolCall[], results: ToolResult[]): AgentStatus | undefined => {
    calls.forEach((call, i) => {
      onToolCall?.(call, results[i]);
      messages.push({ role: 'tool', tool_call_id: call.id, content: results[i].content });
    });
    pending = [];
    // 交接这类工具执行成功了，这个 Agent 的工作就结束了，由调用方决定接下来交给谁（第 26 天）
    if (calls.some((call, i) => options.stopOn?.includes(call.function.name) && !results[i].isError)) return 'stopped';
    // 护栏三：出错的结果已经交回模型，让它有机会改正；但连续出错太多次，就别再浪费了
    for (const toolResult of results) state.toolErrors = toolResult.isError ? state.toolErrors + 1 : 0;
    if (state.toolErrors >= maxToolErrors) return 'tool_errors';
    return undefined;
  };

  if (resumed) {
    const status = settle(resumed.calls, resumed.results);
    if (status) return finish(status);
  }

  // 护栏一（上）：最多调用 maxSteps 次模型
  while (state.steps < maxSteps) {
    state.steps++;
    // 每一步都重新生成工具定义：search_tools 可能刚往 tools 里加了新工具（第 28 天）
    const result = await model.chat({ messages, tools: tools.map(toToolDefinition) }, { onText, onReasoning, signal });
    state.usage = addUsage(state.usage, result.usage);
    onUsage?.(result.usage);
    const reply = result.message;
    messages.push(reply);
    answer = reply.content ?? '';
    finishReason = result.finishReason;
    const calls = reply.tool_calls ?? [];
    pending = calls;

    // 护栏二：先看模型为什么停下，不正常就不再往下走。截断时工具参数可能也不完整，不能执行
    if (TRUNCATED.has(finishReason)) return finish('truncated');
    if (BLOCKED.has(finishReason)) return finish('blocked');
    if (!NORMAL.has(finishReason)) return finish('unexpected');
    if (calls.length === 0) return finish(answer.trim() ? 'completed' : 'unexpected');

    // 护栏一（下）：同样的调用已经执行过 maxRepeats 次，再执行结果也不会变，说明模型在原地打转
    for (const call of calls) {
      const key = callKey(call);
      const count = (seen.get(key) ?? 0) + 1;
      if (count > maxRepeats) return finish('repeated_calls');
      seen.set(key, count);
    }

    const results = await runToolCalls(tools, calls, toolContext(options));

    // TODO 3：有结果带着 interrupt（在等用户）时暂停：return finish('paused', 现场)。现场（PausedRun）里有：
    // - messages：现在的历史，最后一条是发起工具调用的 assistant 消息。工具的结果先不放进去
    // - calls：这一轮的每个调用，按顺序。在等用户的写 { call, interrupt }，已经执行完的写 { call, result }
    // - steps、usage、toolErrors，以及 seen（Map 存不进 JSON，转成 [键, 次数] 的数组）

    const status = settle(calls, results);
    if (status) return finish(status);
  }
  return finish('max_steps');
}

const denied = (content: string): ToolResult => ({ content, isError: true });

/**
 * 从暂停的地方接着跑（第 29 天）。resolutions 按工具调用的 id 给出用户的答复：
 * - 等批准的：批准了就执行（不再检查权限），always 还会把这个工具加进 grants；拒绝了，结果是一条错误
 * - 等回答的：用户的回答就是工具的结果
 * 每个中断都要有答复，少了就抛出错误。options 要和暂停之前一样（同样的模型、工具和设置）
 */
export async function resumeAgent(paused: PausedRun, resolutions: Record<string, Resolution>, options: AgentOptions): Promise<AgentResult> {
  // TODO 4：
  // 1. 有中断没有答复：抛出错误「还有 N 个工具调用在等答复：id1、id2」
  // 2. 按顺序得出每个调用的结果：
  //    - 已经有 result 的：直接用
  //    - 在等回答（input）：答复要有 answer（否则抛出「<id> 在等用户回答问题，答复要写成 { answer }」），结果是「用户回答：<answer>」
  //    - 在等批准（approval）：答复要有 approved（否则抛出「<id> 在等用户批准，答复要写成 { approved }」）。
  //      拒绝：结果是 denied('用户没有同意执行这个操作。不要换个参数再试同样的操作，可以换个办法，或者问问用户')；
  //      批准：always 为真就把工具名加进 options.grants；用 executeTool(工具, interrupt 里的参数, toolContext(options)) 执行，
  //      不再检查权限。工具找不到了，结果是 denied(`工具 <名字> 已经不在了`)
  // 3. 用现场恢复 LoopState（messages 复制一份，seen 变回 Map），调用 loop(state, options, { calls, results })：
  //    loop 会先把这些结果放进历史，再接着调用模型
  void denied;
  void executeTool;
  void toolContext;
  void loop;
  throw new Error(`TODO 4：还没有实现 resumeAgent()（${paused.calls.length} 个调用，${Object.keys(resolutions).length} 个答复，${options.tools.length} 个工具）`);
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
    case 'stopped':
      return '按约定停下，交给了别的环节';
    case 'paused':
      return '暂停了，在等用户批准或者回答问题';
  }
}
