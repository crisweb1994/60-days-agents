// 一次多轮对话：记住对话历史和累计的用量，可以中途换模型。命令行界面在 cli.ts。
// 第 15 天：给了预算，每一轮都按预算组装上下文（context.ts），放不下的旧对话会被删掉。
import { runAgent, SYSTEM_PROMPT, type AgentOptions, type AgentResult } from './agent.ts';
import { buildContext, type ContextBudget, type ContextReport, type DynamicSection } from './context.ts';
import { toToolDefinition, type Tool } from './tool.ts';
import type { Message, Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';

/** 每一轮可以单独传的选项：显示用的回调、确认和取消 */
export type TurnOptions = Pick<AgentOptions, 'onText' | 'onReasoning' | 'onToolCall' | 'onUsage' | 'confirm' | 'signal'> & {
  /** 这一轮的动态信息，比如今天的日期、检索结果。有预算时才会用到（第 15 天） */
  dynamic?: DynamicSection[];
};

export interface SessionOptions {
  model: Model;
  tools: Tool[];
  /** 每一轮最多调用几次模型 */
  maxSteps?: number;
  /** system prompt，不传就用 agent.ts 的默认值（第 12 天） */
  system?: string;
  /** 上下文的预算。给了就每一轮按预算组装上下文；不给就像以前一样，把全部历史发过去（第 15 天） */
  budget?: ContextBudget;
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
}

export function createSession(options: SessionOptions): Session {
  let messages: Message[] = [];
  let usage = emptyUsage();
  let turns = 0;
  let lastContext: ContextReport | undefined;

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
    async send(input, { dynamic, ...turn } = {}) {
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
