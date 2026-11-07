// 第 15 天：按预算组装上下文。每次请求的上下文由几部分组成：system prompt、工具定义、对话历史、
// 这一轮才有的动态信息（日期、检索结果……）和用户的问题。窗口是有限的，要先算清楚每部分占多少，再决定留什么。
// 顺序也有讲究：不变的放前面，会变的放后面，前缀不变才能命中提示缓存。
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
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
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
  const turns: Message[][] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    if (message.role === 'user' || turns.length === 0) turns.push([message]);
    else turns.at(-1)!.push(message);
  }
  return turns;
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

  // 动态信息：重要的先放。排序要稳定，同样重要的保持原来的顺序
  const ranked = (parts.dynamic ?? []).map((section, index) => ({ section, index }));
  ranked.sort((a, b) => (b.section.priority ?? 0) - (a.section.priority ?? 0) || a.index - b.index);
  const kept = new Set<DynamicSection>();
  const droppedSections: string[] = [];
  let dynamic = 0;
  for (const { section } of ranked) {
    const cost = estimateTokens(`<${section.label}>\n${section.content}\n</${section.label}>\n`);
    if (dynamic + cost <= maxDynamic && fixed + dynamic + cost <= limit) {
      kept.add(section);
      dynamic += cost;
    } else {
      droppedSections.push(section.label);
    }
  }
  // 放进去的动态信息保持调用方给的顺序
  const sections = (parts.dynamic ?? []).filter((s) => kept.has(s));
  const question = formatQuestion(sections, parts.question);

  // 历史：从最新的一轮往前放
  const turns = splitTurns(parts.history);
  let remaining = limit - fixed - dynamic;
  let history = 0;
  let start = turns.length;
  while (start > 0) {
    const cost = turns[start - 1].reduce((sum, m) => sum + messageTokens(m), 0);
    if (cost > remaining) break;
    remaining -= cost;
    history += cost;
    start--;
  }

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
  const inputTokens = usages.reduce((sum, u) => sum + u.inputTokens, 0);
  const cachedTokens = usages.reduce((sum, u) => sum + u.cachedTokens, 0);
  return { inputTokens, cachedTokens, hitRate: inputTokens ? cachedTokens / inputTokens : 0 };
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
  if (JSON.stringify(previous.tools ?? []) !== JSON.stringify(next.tools ?? [])) return 'tools';
  for (let i = 0; i < previous.messages.length; i++) {
    if (JSON.stringify(previous.messages[i]) !== JSON.stringify(next.messages[i])) return i;
  }
  return -1;
}
