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
      // TODO 2：按脚本回复一次。
      // - signal 已经取消就直接抛出：options.signal?.throwIfAborted()
      // - 把请求的副本（structuredClone）记进 requests。Agent 之后还会往 messages 里追加内容，
      //   存原对象的话，记下的请求会跟着变
      // - 从 script 里取出下一步（shift）：
      //   - 没有了：抛出错误，信息里写明「脚本已用完」，以及准备了几步、这是第几次调用
      //   - 是一个 Error：直接抛出它
      // - 把这一步转成 ChatResult：
      //   - toolCalls 转成 ToolCall：没写 id 就生成一个（比如 call_1、call_2），arguments 是对象就转成 JSON 字符串
      //   - content：有 text 用 text；没有 text 时，有工具调用是 null，否则是空字符串
      //   - 有思考内容就放进 reasoning_content，有工具调用就放进 tool_calls
      //   - finishReason：没写时，有工具调用是 tool_calls，否则是 stop
      //   - usage：在 emptyUsage() 的基础上，用这一步写了的字段覆盖
      // - 有思考内容时回调 options.onReasoning，有文字时回调 options.onText
      throw new Error('TODO 2：还没有实现脚本化的假模型');
    },
  };
}
