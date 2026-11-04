// 一次多轮对话：记住对话历史和累计的用量，可以中途换模型。命令行界面在 cli.ts。
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts';
import type { Tool } from './tool.ts';
import type { Message, Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';

/** 每一轮可以单独传的选项：显示用的回调、确认和取消 */
export type TurnOptions = Pick<AgentOptions, 'onText' | 'onReasoning' | 'onToolCall' | 'onUsage' | 'confirm' | 'signal'>;

export interface SessionOptions {
  model: Model;
  tools: Tool[];
  /** 每一轮最多调用几次模型 */
  maxSteps?: number;
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
  /** 说一句话，跑完一轮。成功时才更新历史；出错（包括被取消）时历史保持原样，可以直接再试一次 */
  send(input: string, options?: TurnOptions): Promise<AgentResult>;
  /** 清空历史，开始新的对话。累计的用量保留 */
  clear(): void;
}

export function createSession(options: SessionOptions): Session {
  let messages: Message[] = [];
  let usage = emptyUsage();
  let turns = 0;

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
    async send(input, turn = {}) {
      const result = await runAgent(input, {
        ...turn,
        model: session.model,
        tools: options.tools,
        maxSteps: options.maxSteps,
        history: messages,
        // 每次调用完就累加：就算这一轮后来出错了，已经花掉的也算进去
        onUsage: (callUsage) => {
          usage = addUsage(usage, callUsage);
          turn.onUsage?.(callUsage);
        },
      });
      // 没有正常完成（比如步数用完）的一轮也记进历史：第 6 天保证了它是完整的，用户可以说「继续」
      messages = result.messages;
      turns++;
      return result;
    },
    clear() {
      messages = [];
    },
  };
  return session;
}
