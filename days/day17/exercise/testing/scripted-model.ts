// 脚本化的假模型：按事先写好的脚本一步步回复，并记下收到的每个请求。
// 它实现了和真模型一样的 Model 接口，Agent 分不出区别；但它不联网、不花钱，每次的输出都一样。
import type { ChatOptions, ChatRequest, ChatResult, Model, ToolCall } from '../types.ts';
import { emptyUsage, type Usage } from '../usage.ts';

/** 脚本里的一步：模型这一次怎么回复。也可以是一个 Error，模拟这一次调用失败 */
export type ScriptStep =
  | {
      text?: string;
      reasoning?: string;
      toolCalls?: { id?: string; name: string; arguments: object | string }[];
      /** 不写时，有工具调用就是 tool_calls，否则是 stop */
      finishReason?: string;
      usage?: Partial<Usage>;
    }
  | Error;

export interface ScriptedModel extends Model {
  /** 收到的每个请求。存的是调用当时的副本，不受之后修改的影响 */
  readonly requests: ChatRequest[];
  /** 还有几步没用 */
  readonly remaining: number;
}

export function createScriptedModel(steps: ScriptStep[]): ScriptedModel {
  const script = [...steps];
  const requests: ChatRequest[] = [];
  let nextId = 1;

  return {
    name: 'scripted',
    requests,
    get remaining() {
      return script.length;
    },
    async chat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
      options.signal?.throwIfAborted();
      // Agent 会接着往 messages 里追加内容。不复制一份的话，记下的请求会跟着变，测试就看不出当时发了什么
      requests.push(structuredClone(request));
      const step = script.shift();
      if (!step) {
        throw new Error(`脚本已用完：只准备了 ${requests.length - 1} 步，这是第 ${requests.length} 次调用模型。Agent 是不是多调用了一次，或者陷入了循环？`);
      }
      if (step instanceof Error) throw step;

      const toolCalls = (step.toolCalls ?? []).map(
        (call): ToolCall => ({
          id: call.id ?? `call_${nextId++}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
          },
        }),
      );
      if (step.reasoning) options.onReasoning?.(step.reasoning);
      if (step.text) options.onText?.(step.text);
      return {
        message: {
          role: 'assistant',
          content: step.text ?? (toolCalls.length ? null : ''),
          ...(step.reasoning ? { reasoning_content: step.reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finishReason: step.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
        usage: { ...emptyUsage(), ...step.usage },
      };
    },
  };
}
