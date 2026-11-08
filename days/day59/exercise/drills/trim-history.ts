// 第 59 天手写题五：按 token 预算裁剪对话历史。留住 system，从最新的往前留；不能把一条工具结果和发起它的工具调用拆开。
// 第 59 天的练习：TODO 5 在这里，15 分钟。不要看前面任何一天的代码，计时写。检查：npm run check 59
import type { Msg } from './agent-loop.ts';

/**
 * 裁剪历史：
 * - 开头的 system 消息都留着（它们的 token 也算在 budget 里）
 * - 其余的从最新的往前加，加到超过 budget 就停（最新的一条超了也不留）
 * - 留下的部分如果以 tool 消息开头（发起它的 assistant 被裁掉了），把开头这些 tool 消息也去掉：模型接口不接受没有对应调用的工具结果
 * - count(消息) 返回一条消息的 token 数
 */
export function trimHistory(messages: Msg[], budget: number, count: (m: Msg) => number): Msg[] {
  // TODO 5
  void messages; void budget; void count;
  return messages;
}
