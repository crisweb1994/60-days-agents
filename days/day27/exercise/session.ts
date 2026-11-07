// 一次多轮对话：记住对话历史和累计的用量，可以中途换模型。命令行界面在 cli.ts。
// 第 15 天：给了预算，每一轮都按预算组装上下文（context.ts），放不下的旧对话会被删掉。
// 第 16 天：历史超过阈值时，先清理旧的工具输出，还不够就把旧的对话压缩成摘要（compact.ts）。
// 第 19 天：可以从保存的会话恢复（restore）。
import { runAgent, SYSTEM_PROMPT, type AgentOptions, type AgentResult } from './agent.ts';
import { compactHistory, historyTokens, pruneToolOutputs } from './compact.ts';
import { buildContext, type ContextBudget, type ContextReport, type DynamicSection } from './context.ts';
import { toToolDefinition, type Tool } from './tool.ts';
import type { Message, Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';

/** 每一轮可以单独传的选项：显示用的回调、确认和取消 */
export type TurnOptions = Pick<AgentOptions, 'onText' | 'onReasoning' | 'onToolCall' | 'onUsage' | 'confirm' | 'signal'> & {
  /** 这一轮的动态信息，比如今天的日期、检索结果。有预算时才会用到（第 15 天） */
  dynamic?: DynamicSection[];
  /** 这一轮开始前压缩了历史，回调一次（第 16 天） */
  onCompact?: (info: CompactInfo) => void;
};

/** 一次压缩做了什么 */
export interface CompactInfo {
  /** prune：只清理了旧的工具输出；summary：还把旧的对话压缩成了摘要 */
  kind: 'prune' | 'summary';
  /** 压缩前后，历史大约有多少 token */
  before: number;
  after: number;
  /** 清理了几个工具输出 */
  pruned: number;
  /** 压缩成摘要的轮数 */
  compactedTurns: number;
}

export interface CompactConfig {
  /** 历史（加上工具定义）超过这么多 token 就压缩 */
  thresholdTokens: number;
  /** 最近几轮原样保留，默认 2 */
  keepRecentTurns?: number;
  /** 用来写摘要的模型，默认用会话当前的模型。可以换成一个便宜的模型 */
  model?: Model;
}

export interface SessionOptions {
  model: Model;
  tools: Tool[];
  /** 每一轮最多调用几次模型 */
  maxSteps?: number;
  /** system prompt，不传就用 agent.ts 的默认值（第 12 天） */
  system?: string;
  /** 上下文的预算。给了就每一轮按预算组装上下文；不给就像以前一样，把全部历史发过去（第 15 天） */
  budget?: ContextBudget;
  /** 自动压缩历史。不给就不压缩（第 16 天） */
  compact?: CompactConfig;
  /** 从保存的会话接着聊：之前的历史、用量和轮数（第 19 天） */
  restore?: { messages: Message[]; usage: Usage; turns: number };
}

export interface Session {
  /** 当前用的模型，可以随时换，对话历史保留 */
  model: Model;
  /** 到目前为止的对话历史 */
  readonly messages: Message[];
  /** 所有调用加起来的用量，包括出错的那几轮里已经完成的调用 */
  readonly usage: Usage;
  /** 已经完成了几轮 */
  readonly turns: number;
  /** 最近一轮组装上下文的情况：每部分占多少、丢掉了什么。没有预算时是 undefined（第 15 天） */
  readonly lastContext: ContextReport | undefined;
  /** 说一句话，跑完一轮。成功时才更新历史；出错（包括被取消）时历史保持原样，可以直接再试一次 */
  send(input: string, options?: TurnOptions): Promise<AgentResult>;
  /** 清空历史，开始新的对话。累计的用量保留 */
  clear(): void;
  /**
   * 压缩历史（第 16 天）。先清理旧的工具输出；还超过阈值（force 时不看阈值）就把旧的对话压缩成摘要。
   * 什么都没做时返回 undefined
   */
  compact(options?: { force?: boolean; signal?: AbortSignal }): Promise<CompactInfo | undefined>;
  /** 压缩过几次 */
  readonly compactions: number;
}

export function createSession(options: SessionOptions): Session {
  let messages: Message[] = options.restore ? [...options.restore.messages] : [];
  let usage = options.restore?.usage ?? emptyUsage();
  let turns = options.restore?.turns ?? 0;
  let lastContext: ContextReport | undefined;
  let compactions = 0;

  const session: Session = {
    model: options.model,
    get messages() {
      return messages;
    },
    get usage() {
      return usage;
    },
    get turns() {
      return turns;
    },
    get lastContext() {
      return lastContext;
    },
    get compactions() {
      return compactions;
    },
    async compact({ force = false, signal } = {}) {
      const config = options.compact;
      const threshold = config?.thresholdTokens ?? 0;
      const keepRecentTurns = config?.keepRecentTurns ?? 2;
      const before = historyTokens(messages, options.tools);
      if (!force && before <= threshold) return undefined;
      // 先做便宜的：清理旧的工具输出，不用调用模型
      const pruned = pruneToolOutputs(messages, { keepRecentTurns });
      let next = pruned.messages;
      let kind: CompactInfo['kind'] = 'prune';
      let compactedTurns = 0;
      if (force || historyTokens(next, options.tools) > threshold) {
        // 还不够，再让模型写摘要。摘要失败（比如网络错误）时抛出错误，历史保持原样
        const result = await compactHistory(next, config?.model ?? session.model, { keepRecentTurns, signal });
        if (result.usage) usage = addUsage(usage, result.usage);
        if (result.compactedTurns > 0) {
          next = result.messages;
          kind = 'summary';
          compactedTurns = result.compactedTurns;
        }
      }
      if (pruned.pruned === 0 && compactedTurns === 0) return undefined;
      messages = next;
      compactions++;
      return { kind, before, after: historyTokens(next, options.tools), pruned: pruned.pruned, compactedTurns };
    },
    async send(input, { dynamic, onCompact, ...turn } = {}) {
      // 这一轮开始之前，历史太长就先压缩。压缩改写了历史，提示缓存会失效一次，所以只在超过阈值时才做
      if (options.compact) {
        const info = await session.compact({ signal: turn.signal });
        if (info) onCompact?.(info);
      }
      let question = input;
      let history = messages;
      let report: ContextReport | undefined;
      if (options.budget) {
        const built = buildContext(
          {
            system: options.system ?? SYSTEM_PROMPT,
            tools: options.tools.map(toToolDefinition),
            history: messages,
            dynamic,
            question: input,
          },
          options.budget,
        );
        question = built.question;
        history = built.history;
        report = built.report;
      }
      const result = await runAgent(question, {
        ...turn,
        model: session.model,
        tools: options.tools,
        maxSteps: options.maxSteps,
        system: options.system,
        history,
        // 每次调用完就累加：就算这一轮后来出错了，已经花掉的也算进去
        onUsage: (callUsage) => {
          usage = addUsage(usage, callUsage);
          turn.onUsage?.(callUsage);
        },
      });
      // 没有正常完成（比如步数用完）的一轮也记进历史：第 6 天保证了它是完整的，用户可以说「继续」
      messages = result.messages;
      turns++;
      lastContext = report;
      return result;
    },
    clear() {
      messages = [];
    },
  };
  return session;
}
