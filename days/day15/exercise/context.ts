// 第 15 天：按预算组装上下文。每次请求的上下文由几部分组成：system prompt、工具定义、对话历史、
// 这一轮才有的动态信息（日期、检索结果……）和用户的问题。窗口是有限的，要先算清楚每部分占多少，再决定留什么。
// 顺序也有讲究：不变的放前面，会变的放后面，前缀不变才能命中提示缓存。
// 第 15 天的练习：TODO 1–4 在这里，TODO 5 在 session.ts。检查：npm run check 15
import type { Message, ToolDefinition } from './types.ts';
import type { Usage } from './usage.ts';

// ---------- 估算 token ----------

/** 中日韩文字（汉字、假名、谚文）和全角标点 */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

/**
 * 粗略估算一段文字有多少 token。各家的分词器不一样，精确值只有接口返回的 usage 才知道；
 * 组装上下文时只需要一个大概的数，宁可估多一点，留出余量：
 * - 中日韩的字符，每个算 1 个 token（多数中文分词器在 0.6 到 1.5 之间）
 * - 其他字符（英文、数字、空格、标点），每 4 个算 1 个 token，向上取整
 */
export function estimateTokens(text: string): number {
  // TODO 1：按上面的规则估算。CJK 这个正则已经写好了，text.match(CJK) 找出所有中日韩字符
  void CJK;
  return Math.ceil(text.length / 4);
}

/** 每条消息除了内容，还有角色、分隔符之类的固定开销，大约几个 token */
const MESSAGE_OVERHEAD = 4;

/** 一条消息大约占多少 token：内容、思考内容、工具调用的名字和参数 */
export function messageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD + estimateTokens(message.content ?? '');
  if (message.role === 'assistant') {
    total += estimateTokens(message.reasoning_content ?? '');
    for (const call of message.tool_calls ?? []) total += estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
  }
  return total;
}

/** 工具定义大约占多少 token。它们会被转成文字放进上下文，按 JSON 的长度估算 */
export function toolTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + estimateTokens(JSON.stringify(tool)), 0);
}

// ---------- 按轮分组 ----------

/**
 * 把历史按轮分组：每一轮从一条 user 消息开始，包括它后面的 assistant 和 tool 消息，直到下一条 user 消息。
 * 删历史时一次删一整轮：只删一半，可能留下一个没有结果的工具调用，或者一个找不到调用的工具结果，接口会直接报错。
 * system 消息不属于任何一轮，不在结果里
 */
export function splitTurns(history: Message[]): Message[][] {
  // TODO 2：按轮分组。跳过 system 消息；遇到 user 消息就开始新的一轮，其他消息放进当前这一轮。
  // 历史开头万一不是 user 消息（比如被别的代码删过），也要有地方放：没有当前这一轮时，就新开一轮
  return history.filter((m) => m.role !== 'system').map((m) => [m]);
}

// ---------- 组装 ----------

/** 这一轮才有的信息，放在用户问题的前面。比如今天的日期、检索到的资料、用户的偏好 */
export interface DynamicSection {
  /** 显示成 <标签>…</标签>，比如 date、memory、retrieved */
  label: string;
  content: string;
  /** 越大越重要，放不下时先丢掉不重要的。默认 0 */
  priority?: number;
}

export interface ContextBudget {
  /** 模型的上下文窗口，单位 token */
  contextWindow: number;
  /** 给输出留多少，默认 4000。输入把窗口塞满了，模型就没有地方写回答 */
  reserveOutput?: number;
  /** 动态信息最多占多少，默认 contextWindow 的 20% */
  maxDynamic?: number;
}

export interface ContextParts {
  /** 固定不变的 system prompt。不要放日期、用户名这类会变的东西，那些放进 dynamic */
  system: string;
  tools: ToolDefinition[];
  /** 之前的对话，可以带着 system 消息，会被忽略 */
  history: Message[];
  dynamic?: DynamicSection[];
  question: string;
}

/** 每部分用了多少 token，以及丢掉了什么 */
export interface ContextReport {
  system: number;
  tools: number;
  history: number;
  dynamic: number;
  question: number;
  total: number;
  /** 输入最多能用多少：窗口减去给输出留的 */
  limit: number;
  /** 丢掉了几轮最旧的对话 */
  droppedTurns: number;
  /** 放不下而丢掉的动态信息 */
  droppedSections: string[];
}

export interface BuiltContext {
  /** 交给 runAgent 的 history：system 消息加上保留下来的历史 */
  history: Message[];
  /** 交给 runAgent 的问题：动态信息加上用户的问题 */
  question: string;
  report: ContextReport;
}

export class ContextOverflowError extends Error {
  override name = 'ContextOverflowError';
}

/** 把动态信息和问题拼成这一轮的 user 消息 */
export function formatQuestion(sections: DynamicSection[], question: string): string {
  if (sections.length === 0) return question;
  return `${sections.map((s) => `<${s.label}>\n${s.content}\n</${s.label}>`).join('\n')}\n\n${question}`;
}

/**
 * 按预算组装上下文。分配的顺序：
 * 1. 固定的部分：system prompt、工具定义、用户的问题。放不下就没法继续了，抛出 ContextOverflowError
 * 2. 动态信息：按 priority 从高到低，在 maxDynamic 以内能放就放，放不下的跳过
 * 3. 对话历史：用剩下的预算，从最新的一轮往前放，放不下就停，更旧的都丢掉
 *
 * 排列的顺序：[system, 历史……, 这一轮的 user 消息（动态信息 + 问题）]。
 * 历史不改写、只从最旧的一头删，动态信息只出现在最后：这样上一轮请求的大部分内容，正好是这一轮请求的前缀
 */
export function buildContext(parts: ContextParts, budget: ContextBudget): BuiltContext {
  const reserveOutput = budget.reserveOutput ?? 4000;
  const limit = budget.contextWindow - reserveOutput;
  const maxDynamic = budget.maxDynamic ?? Math.floor(budget.contextWindow * 0.2);

  const system = messageTokens({ role: 'system', content: parts.system });
  const tools = toolTokens(parts.tools);
  const fixed = system + tools + MESSAGE_OVERHEAD + estimateTokens(parts.question);
  if (fixed > limit) {
    throw new ContextOverflowError(`system prompt、工具定义和问题一共约 ${fixed} tokens，超过了输入的上限 ${limit}`);
  }

  // TODO 3（一）：放动态信息。
  // - 按 priority 从高到低排（没写就是 0），一样高的保持原来的顺序
  // - 每一段的开销按 estimateTokens(`<标签>\n内容\n</标签>\n`) 算。加上它以后，动态信息的总和不超过 maxDynamic、
  //   而且 fixed + 动态信息不超过 limit，才放进去；否则把它的 label 记进 droppedSections
  // - 放进去的那些，按调用方原来给的顺序，用 formatQuestion 和问题拼起来
  const droppedSections: string[] = [];
  const dynamic = 0;
  const question = parts.question;
  void maxDynamic;

  // TODO 3（二）：放历史。用 splitTurns 分成轮，剩下的预算是 limit - fixed - dynamic。
  // 从最新的一轮往前，一轮一轮地放（每轮的开销是它所有消息的 messageTokens 之和），放不下就停：更旧的都丢掉。
  // start 是保留下来的第一轮的下标，也就是丢掉了几轮
  const turns = splitTurns(parts.history);
  const history = 0;
  const start = 0;

  const questionTokens = MESSAGE_OVERHEAD + estimateTokens(question) - dynamic;
  return {
    history: [{ role: 'system', content: parts.system }, ...turns.slice(start).flat()],
    question,
    report: {
      system,
      tools,
      history,
      dynamic,
      question: questionTokens,
      total: system + tools + history + dynamic + questionTokens,
      limit,
      droppedTurns: start,
      droppedSections,
    },
  };
}

// ---------- 缓存 ----------

export interface CacheStats {
  inputTokens: number;
  cachedTokens: number;
  /** 命中缓存的输入占全部输入的比例，0 到 1。没有输入时是 0 */
  hitRate: number;
}

/** 统计一组调用的缓存命中率 */
export function cacheStats(usages: Usage[]): CacheStats {
  // TODO 4（一）：把所有的 inputTokens、cachedTokens 加起来，算出命中率。没有输入时命中率是 0
  void usages;
  return { inputTokens: 0, cachedTokens: 0, hitRate: 0 };
}

/**
 * 两次请求从哪里开始不一样。用来排查缓存为什么没命中：
 * - 工具定义不一样：返回 'tools'
 * - 某条消息不一样：返回它的下标
 * - 后一次的消息以前一次的全部消息开头：返回 -1，前缀完全保留
 */
export function firstDifference(
  previous: { messages: Message[]; tools?: ToolDefinition[] },
  next: { messages: Message[]; tools?: ToolDefinition[] },
): number | 'tools' {
  // TODO 4（二）：先比较工具定义（都转成 JSON 字符串比，没有就当作空数组），不一样就返回 'tools'；
  // 再逐条比较 previous 的每条消息和 next 同一位置的消息，第一条不一样的返回它的下标；都一样返回 -1
  void next;
  return -1;
}
