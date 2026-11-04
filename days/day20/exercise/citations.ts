// 第 20 天：引用。来源有两种：网页（https://…）和本地文档（doc:路径），回答里统一用 [编号] 引用。
// 回答生成以后检查引用的格式：编号都是查到过的来源，带具体数字的句子都标了来源，没有自己编来源列表……
// 这些检查只看格式，不判断「这句话是不是真的出自那个来源」，那要到第 25 天做引用核查。
// 第 20 天的练习：TODO 1、2 在这里，TODO 3、4 在 research.ts。检查：npm run check 20
import type { Message } from './types.ts';
import type { Source, SourceRegistry } from './web.ts';

/** 查资料的工具。这一轮用过它们，回答就应该带引用 */
export const RESEARCH_TOOLS = new Set(['web_search', 'fetch_page', 'search_docs', 'grep_docs', 'read_doc']);

/** 来源列表里的一行：网页写标题和网址，本地文档写「本地文档」和路径 */
export function formatSourceLine(source: Source): string {
  // TODO 1（一）：网址以 doc: 开头的是本地文档，写成「[编号] 本地文档 路径」（路径是 doc: 后面的部分）；
  // 其他的是网页，写成「[编号] 标题 网址」，没有标题就写「（无标题）」
  return `[${source.id}] ${source.url}`;
}

/** 找出文字里的 [编号]。[1]、[2][3]、[1, 2] 都算；后面紧跟 ( 的是 Markdown 链接，不算 */
export function citedIds(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(/\[(\d+(?:\s*[,，]\s*\d+)*)\](?!\()/g)) {
    for (const id of match[1].split(/\s*[,，]\s*/).map(Number)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 按句号、问号、叹号和换行分句，去掉列表的序号和空白。代码块里的内容不算句子 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .split(/(?<=[。！？!?])|\n/)
    .map((s) => s.replace(/^\s*(?:[-*]|\d+[.、)])\s+/, '').trim())
    .filter(Boolean);
}

/** 这一轮有没有用过查资料的工具 */
export function usedResearchTools(messages: Message[]): boolean {
  return messages.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((call) => RESEARCH_TOOLS.has(call.function.name)));
}

export interface CitationReport {
  /** 一个问题都没有 */
  ok: boolean;
  /** 引用到的、登记过的来源，按第一次出现的顺序 */
  cited: Source[];
  /** 发现的问题，每条是一句给人看的说明 */
  problems: string[];
}

export interface CheckOptions {
  /** 这一轮查过资料吗。查过资料，回答就应该有引用，带具体数字的句子都要标来源 */
  researched: boolean;
}

/**
 * 检查回答的引用格式：
 * 1. 引用的编号都要是登记过的来源
 * 2. 查过资料的回答，至少要有一个引用
 * 3. 查过资料的回答里，带数字的句子（数据、日期、版本）要标明来源
 * 4. 引用写在句子的末尾，不要写在开头
 * 5. 不要自己写来源列表：程序会附上，模型写的网址可能是编的
 */
export function checkCitations(answer: string, sources: SourceRegistry, { researched }: CheckOptions): CitationReport {
  // TODO 2：按上面注释里的五条规则检查，每发现一个问题，就往 problems 里放一句说明。说明的写法和测试里的一样：
  // 1. 用 citedIds 找出所有编号，登记过的放进 cited，没登记过的：「[编号] 不是查到过的来源」
  // 2. researched 而且 cited 是空的：「查过资料，但回答里没有任何引用」
  // 3. researched 时，用 splitSentences 分句，有数字、又没有任何 [编号] 的句子：
  //    「这句话有具体的数字，但没有标明来源：「句子」」，句子超过 40 个字符就截短加「…」
  // 4. 回答开头、或者句号问号叹号换行之后紧跟着 [编号]：「引用要写在句子的末尾，不要写在开头」
  // 5. 有一行以「来源：」「参考资料：」「参考文献：」「References:」开头：「回答里自己写了来源列表。来源列表由程序附上，不要自己写」
  void splitSentences;
  void researched;
  const cited = citedIds(answer).map((id) => sources.get(id)).filter((s): s is Source => s !== undefined);
  return { ok: true, cited, problems: [] };
}

/** 在回答后面附上被引用的来源 */
export function appendReferences(answer: string, cited: Source[]): string {
  // TODO 1（二）：没有引用就原样返回；有引用就在回答后面空一行，加上「来源：」，下面每个来源一行（formatSourceLine）
  void cited;
  return answer;
}
