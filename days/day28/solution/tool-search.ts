// 第 28 天：工具太多时，按需检索工具。接了几个 MCP 服务器以后，工具可能有上百个：
// 每个工具的定义几十到几百个 token，全放进请求里又贵又容易选错。
// 做法和 skill 一样是渐进式披露：一开始只给常用的工具，加上一个 search_tools；
// 模型需要别的能力时，先搜索，搜到的工具加进工具列表，下一步就能直接调用。
import { z } from 'zod';
import { tokenize } from './rag/bm25.ts';
import { defineTool, type Tool } from './tool.ts';

/** 工具的名字拆成词：web_search → web search。名字里的词比描述里的更能说明它是干什么的 */
const nameTokens = (name: string) => tokenize(name.replaceAll(/[_-]/g, ' '));

/** 一个工具和查询词的相关程度：查询里的每个词，在工具名字里出现算 2 分，在描述里出现算 1 分 */
export function scoreTool(tool: Tool, query: string): number {
  const name = new Set(nameTokens(tool.name));
  const description = new Set(tokenize(tool.description));
  let score = 0;
  for (const token of new Set(tokenize(query))) {
    if (name.has(token)) score += 2;
    else if (description.has(token)) score += 1;
  }
  return score;
}

export interface ToolSearchOptions {
  /** 一开始就给模型的工具名字 */
  core: string[];
  /** 一次最多加载几个，默认 3 */
  maxResults?: number;
}

export interface ToolSearch {
  /**
   * 当前给模型的工具：常用的、search_tools，加上搜索加载进来的。这是同一个数组，加载新工具时往后面追加，
   * 交给 runAgent 以后，它每一步都按这个数组重新生成工具定义
   */
  readonly tools: Tool[];
  /** 还没加载的工具的名字 */
  deferred(): string[];
}

/**
 * 创建按需检索：tools 一开始只有 core 里的工具和 search_tools。
 * 新工具追加在末尾：工具定义排在请求的前面，前面的部分不变，提示缓存（第 15 天）才不会全部失效
 */
export function createToolSearch(all: Tool[], options: ToolSearchOptions): ToolSearch {
  const { core, maxResults = 3 } = options;
  const loaded = new Set(core);
  const tools: Tool[] = all.filter((t) => loaded.has(t.name));
  const deferred = () => all.filter((t) => !loaded.has(t.name));

  const searchTools = defineTool({
    name: 'search_tools',
    description:
      `还有 ${deferred().length} 个工具没有加载。现有的工具做不到时，用关键词搜索需要的工具，比如「浏览器 点击」「计划」；` +
      '搜到的工具会加载进来，下一步就能直接调用',
    schema: z.object({ query: z.string().min(1).describe('要找的能力，用几个关键词描述') }),
    execute({ query }) {
      const ranked = deferred()
        .map((tool) => ({ tool, score: scoreTool(tool, query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
      if (ranked.length === 0) {
        const names = deferred().map((t) => t.name);
        return `没有找到和「${query}」相关的工具。换个说法再搜；还没加载的工具有：${names.join('、') || '（没有了）'}`;
      }
      for (const { tool } of ranked) {
        loaded.add(tool.name);
        tools.push(tool);
      }
      return `已加载 ${ranked.length} 个工具，下一步可以直接调用：\n${ranked.map(({ tool }) => `- ${tool.name}：${tool.description}`).join('\n')}`;
    },
  });
  tools.push(searchTools);
  return { tools, deferred: () => deferred().map((t) => t.name) };
}
