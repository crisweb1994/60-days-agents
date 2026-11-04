// 第 18 天：把文档检索做成工具，让 Agent 自己决定查不查、查什么、用哪种方式查、要不要换个说法再查。
// 三个工具各有分工：search_docs 按意思和关键词找段落，grep_docs 找精确的字符串，read_doc 读整篇文档。
// 第 18 天的练习：TODO 4 在这里。检查：npm run check 18
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { grepDocs } from '../rag/grep.ts';
import { SEARCH_MODES, type Retriever, type SearchMode } from '../rag/hybrid.ts';
import type { Reranker } from '../rag/rerank.ts';
import type { SearchHit } from '../rag/vector-store.ts';
import { defineTool, paginate, type Tool } from '../tool.ts';
import type { SourceRegistry } from '../web.ts';
import { resolveInside } from './files.ts';

export interface DocsToolsOptions {
  /** 文档目录 */
  root: string;
  retriever: Retriever;
  /** 有它就先多取一些候选，再重排 */
  reranker?: Reranker;
  /** 有它就把文档也登记成来源，回答时可以用 [编号] 引用（第 20 天） */
  sources?: SourceRegistry;
  /** 固定一种检索方式，search_docs 就没有 mode 参数。比较检索方式时用 */
  mode?: SearchMode;
  /** read_doc 每页多少个字符，默认 3000 */
  pageSize?: number;
}

/** 每段在结果里最多显示多少个字符 */
const SNIPPET_CHARS = 500;

/** 文档在来源里的「网址」：doc: 加上路径 */
export const docUrl = (path: string) => `doc:${path}`;

export function createDocsTools(options: DocsToolsOptions): Tool[] {
  const { root, retriever, reranker, sources, pageSize = 3000 } = options;
  /** 给一段结果编号：有来源登记就用来源的编号，否则按顺序编 */
  const label = (hit: SearchHit, i: number) => (sources ? sources.add(docUrl(hit.chunk.path), hit.chunk.path).id : i + 1);

  const modeSchema = z
    .enum(SEARCH_MODES as [SearchMode, ...SearchMode[]])
    .default('hybrid')
    .describe('hybrid（默认）同时按意思和关键词找；vector 只按意思找，适合换了说法的问题；keyword 只按词找，适合名字和术语');
  const searchDocs = defineTool({
    name: 'search_docs',
    description:
      '在本地文档里检索和问题相关的段落，返回编号、出处和内容。问题和文档的用词不一样也能找到。' +
      '找精确的错误码、配置项、命令，用 grep_docs 更准；要看一段的上下文，用 read_doc 读整篇',
    schema: z.object({
      query: z.string().min(1).describe('要找的内容，用文档里可能出现的说法，比如「回滚 应急流程」'),
      ...(options.mode ? {} : { mode: modeSchema }),
      k: z.int().min(1).max(10).default(5).describe('最多返回几段，默认 5'),
    }),
    async execute(input: { query: string; mode?: SearchMode; k: number }, { signal }) {
      const mode = options.mode ?? input.mode ?? 'hybrid';
      // TODO 4：检索并写成给模型看的结果。
      // - 用 retriever.search(query, { mode, k, signal })。有 reranker 时，先取 k 的 4 倍作为候选，再用 reranker.rerank 留下 k 个
      // - 一段都没有：说明没有找到和「query」相关的内容，建议换个说法，或者用 grep_docs 找精确的词
      // - 有结果：第一行「找到 N 段：」，空一行，每段是「[编号] 路径 · 标题」，下一行是内容（超过 SNIPPET_CHARS 截短加「…」），
      //   段与段之间空一行；没有标题的段落不写「 · 标题」。编号用 label(hit, i)。最后空一行，提示要看整篇文档用 read_doc
      void reranker;
      void label;
      void SNIPPET_CHARS;
      const hits = await retriever.search(input.query, { mode, k: input.k, signal });
      return JSON.stringify(hits);
    },
  });

  const grep = defineTool({
    name: 'grep_docs',
    description: '在本地文档里逐行查找一个精确的字符串（不区分大小写），返回「路径:行号: 这一行」。适合找错误码、配置项、命令、人名',
    schema: z.object({
      pattern: z.string().min(1).describe('要找的字符串，比如 TIDE_E2077、handshake.retries'),
      regex: z.boolean().default(false).describe('把 pattern 当作正则表达式，默认 false'),
      path_prefix: z.string().default('').describe('只在这个目录里找，比如 ops/；默认全部'),
    }),
    async execute({ pattern, regex, path_prefix }) {
      const matches = await grepDocs(root, pattern, { regex, pathPrefix: path_prefix });
      if (matches.length === 0) return `没有找到「${pattern}」。字符串要和文档里的一模一样；不确定怎么写，用 search_docs`;
      return `${matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')}\n\n要看上下文，用 read_doc 读对应的文档`;
    },
  });

  const readDoc = defineTool({
    name: 'read_doc',
    description: `读一篇本地文档的全文。路径来自 search_docs 或 grep_docs 的结果。长文档会分页，每页约 ${pageSize} 字`,
    schema: z.object({
      path: z.string().describe('文档的路径，比如 ops/oncall.md'),
      page: z.int().min(1).default(1).describe('读第几页，默认第 1 页'),
    }),
    async execute({ path, page }) {
      const text = await readFile(resolveInside(root, path), 'utf8').catch((error: Error) => {
        if (error.message.includes('工作目录之外')) throw error;
        throw new Error(`没有这篇文档：${path}。先用 search_docs 或 grep_docs 找到它的路径`);
      });
      const id = sources?.add(docUrl(path), path).id;
      return `${id ? `来源 [${id}]：` : ''}${path}\n\n${paginate(text, page, pageSize).content}`;
    },
  });

  return [searchDocs, grep, readDoc];
}
