// 第 16 天：长任务不失忆。上下文快满的时候，不是简单地删掉最旧的对话，而是按代价从小到大依次尝试：
// 1. 清理旧的工具输出：读过的网页、搜索结果，留一行说明就够了，要用可以重新调用工具
// 2. 大结果写入文件：太长的工具结果一开始就不放进上下文，只放开头和文件的位置
// 3. 摘要压缩：让模型把旧的几轮对话写成一份摘要，替换掉原来的对话
// 压缩一定会丢东西，所以要测：压缩以前的关键事实，压缩以后还在不在。
// 第 16 天的练习：TODO 1–4 在这里，TODO 5 在 session.ts。检查：npm run check 16
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { messageTokens, splitTurns, toolTokens } from './context.ts';
import { toToolDefinition, type Tool } from './tool.ts';
import type { Message, Model } from './types.ts';
import type { Usage } from './usage.ts';

// ---------- 清理旧的工具输出 ----------

export interface PruneOptions {
  /** 最近几轮的工具输出不动，默认 2。模型刚读过的东西，很可能马上还要用 */
  keepRecentTurns?: number;
  /** 不超过这么多字符的工具输出不清理，默认 500。很短的结果清理了也省不了多少 */
  minChars?: number;
}

export interface PruneResult {
  messages: Message[];
  /** 清理了几个工具输出 */
  pruned: number;
}

/**
 * 把较早几轮里的长工具输出换成一行说明。工具调用本身（调了什么、参数是什么）留着，模型还知道自己做过什么。
 * 不修改传进来的数组，返回新的
 */
export function pruneToolOutputs(messages: Message[], options: PruneOptions = {}): PruneResult {
  const { keepRecentTurns = 2, minChars = 500 } = options;
  // TODO 1：清理较早几轮的长工具输出。
  // - system 消息原样放在最前面；其余的用 splitTurns 分成轮
  // - 最后 keepRecentTurns 轮不动。更早的轮里，role 是 tool、内容超过 minChars 个字符的消息，
  //   换成一条新消息（不要改原来的对象）：tool_call_id 不变，内容是一行说明，写明原来有多少个字符、需要的话重新调用工具
  // - 返回新的消息数组和清理的个数
  void keepRecentTurns;
  void minChars;
  return { messages, pruned: 0 };
}

// ---------- 大结果写入文件 ----------

export interface OffloadOptions {
  /** 工作目录。结果写到它下面的 .context/results/ 里，模型可以用 read_file 读 */
  workspace: string;
  /** 超过这么多字符的结果写入文件，默认 4000 */
  maxChars?: number;
  /** 上下文里保留开头的多少个字符，默认 800 */
  previewChars?: number;
}

let offloaded = 0;

/**
 * 包装一组工具：结果太长时，完整的结果写进文件，交给模型的只有开头一段和文件的位置。
 * 被包装的工具其他方面都不变：名字、描述、参数、确认
 */
export function offloadLargeResults(tools: Tool[], options: OffloadOptions): Tool[] {
  const { workspace, maxChars = 4000, previewChars = 800 } = options;
  return tools.map(
    (tool): Tool => ({
      ...tool,
      async execute(input, context) {
        const output = await tool.execute(input, context);
        // TODO 2：结果太长时写进文件。
        // - 结果不是字符串就转成 JSON（undefined 原样返回）；不超过 maxChars 个字符就原样返回
        // - 超过时：路径用 `.context/results/${tool.name}-${Date.now()}-${++offloaded}.md`（相对于 workspace），
        //   目录不存在要先建（mkdir 加 recursive）；把完整的结果写进去
        // - 返回开头的 previewChars 个字符，再加一段说明：一共多少个字符、完整内容保存在哪个路径、需要时用 read_file 读
        void workspace;
        void maxChars;
        void previewChars;
        void mkdir;
        void writeFile;
        void dirname;
        void join;
        return output;
      },
    }),
  );
}

// ---------- 摘要压缩 ----------

export const SUMMARY_PROMPT = `你负责把一段 Agent 和用户的对话压缩成摘要。压缩以后，原来的对话会被删掉，之后的工作只能依靠这份摘要，所以不能丢掉以后可能用到的信息。

按下面的格式写，没有的部分写「无」：

## 用户的目标
用户最终想要什么，有哪些要求和偏好。

## 已经确认的事实
查到的、用户告诉你的具体信息。数字、日期、名字、网址、文件路径要原样保留，不要概括成「一些数据」。注明来源编号，比如 [2]。

## 做过的事和决定
用过哪些工具、得出了什么结论、为什么这么决定。失败过的尝试也要写，免得重复。

## 还没完成的事
接下来要做什么，还有哪些问题没有答案。

只输出摘要本身，不要寒暄。`;

/** 工具结果在对话记录里最多保留多少个字符。摘要不需要逐字的原文 */
const TRANSCRIPT_TOOL_CHARS = 1500;

/** 把几轮对话写成一份给模型读的记录。工具调用写成「调用了什么、参数是什么」，太长的工具结果截短 */
export function formatTranscript(turns: Message[][]): string {
  // TODO 3：把每条消息写成一行，用换行连起来：
  // - user：「用户：内容」
  // - assistant：有内容就写「助手：内容」；每个工具调用写「助手调用了工具 名字，参数 参数」
  // - tool：「工具结果：内容」，内容超过 TRANSCRIPT_TOOL_CHARS 个字符就截短，后面加「……（后面省略）」
  void TRANSCRIPT_TOOL_CHARS;
  return turns.flat().map((m) => m.content).join('\n');
}

export interface CompactOptions {
  /** 最近几轮原样保留，不压缩，默认 2 */
  keepRecentTurns?: number;
  signal?: AbortSignal;
}

export interface CompactResult {
  messages: Message[];
  /** 生成的摘要。没有可以压缩的内容时是空字符串 */
  summary: string;
  /** 压缩了几轮 */
  compactedTurns: number;
  /** 生成摘要花掉的用量 */
  usage?: Usage;
}

/** 摘要放进一条 user 消息，后面跟一条 assistant 消息，保持一问一答的顺序 */
export const SUMMARY_ACK = '好的，我已经了解之前的进展，接着往下做。';

/**
 * 把较早的几轮对话压缩成摘要。结果是：[system, 摘要（user）, 确认（assistant）, 最近几轮原样保留]。
 * 之前已经压缩过的摘要也算在「较早的对话」里，会和新的内容一起重新压缩
 */
export async function compactHistory(messages: Message[], model: Model, options: CompactOptions = {}): Promise<CompactResult> {
  const { keepRecentTurns = 2, signal } = options;
  // TODO 4：压缩较早的对话。
  // - 用 splitTurns 分成轮。最后 keepRecentTurns 轮原样保留；更早的没有（轮数不够）就原样返回
  //   { messages, summary: '', compactedTurns: 0 }，不调用模型
  // - 调用 model.chat：system 是 SUMMARY_PROMPT，user 是「下面是要压缩的对话：」空一行，再加上 formatTranscript(更早的轮)
  // - 摘要是回复的内容去掉首尾空白。是空的就抛出错误（说明生成摘要失败），绝不能用空摘要替换掉对话
  // - 返回的 messages：system 消息、一条 user 消息（<summary> 标签里写「这是之前对话的摘要，原来的对话已经删掉了：」和摘要）、
  //   一条内容是 SUMMARY_ACK 的 assistant 消息、最近几轮原样保留。再带上 summary、compactedTurns 和这次调用的 usage
  void model;
  void signal;
  void SUMMARY_ACK;
  void splitTurns;
  void formatTranscript;
  throw new Error(`TODO 4：还没有实现 compactHistory（${messages.length} 条消息，保留 ${keepRecentTurns} 轮）`);
}

/** 历史加上工具定义，大约有多少 token */
export function historyTokens(messages: Message[], tools: Tool[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0) + toolTokens(tools.map(toToolDefinition));
}

// ---------- 测出压缩丢了什么 ----------

export interface Retention {
  /** 保留下来的比例，0 到 1 */
  ratio: number;
  kept: string[];
  lost: string[];
}

/**
 * 检查一组关键事实在文字里还在不在。事实写成必须原样出现的片段，比如数字、名字、网址；
 * 比较时去掉空白、不区分大小写，免得因为模型多加了一个空格就算丢了
 */
export function factRetention(text: string, facts: string[]): Retention {
  const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const haystack = normalize(text);
  const kept = facts.filter((fact) => haystack.includes(normalize(fact)));
  const lost = facts.filter((fact) => !kept.includes(fact));
  return { ratio: facts.length ? kept.length / facts.length : 1, kept, lost };
}
