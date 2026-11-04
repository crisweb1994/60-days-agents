// 第 14 天：一个 MCP 服务器，把本地的 Markdown 笔记目录提供给任何 MCP host。
// - tools：search_notes 搜索笔记，read_note 分页读一篇笔记
// - resources：每篇笔记是一个 note://路径 的资源，host 可以让用户挑选，直接放进上下文
// - prompts：summarize_note，一个「总结这篇笔记」的提示词模板
// 服务器是无状态的：每次调用需要的信息都在参数里，跨调用的进度放在游标里（cursor.ts）。
// 第 14 天的练习：TODO 2–4 在这里。检查：npm run check 14
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { resolveInside } from '../tools/files.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';

export const SERVER_INFO = { name: 'notes-server', version: '0.14.0' };
/** read_note 每次最多返回多少个字符 */
export const READ_CHUNK = 2000;

export interface Note {
  /** 相对于笔记目录的路径，用 / 分隔，比如 work/release.md */
  path: string;
  /** 第一个 # 标题，没有就用文件名 */
  title: string;
  text: string;
}

/** 日志只能写到 stderr：stdio 模式下，stdout 是协议的通道，写进去一行日志，client 就会解析出错 */
export function log(message: string): void {
  process.stderr.write(`[notes-server] ${message}\n`);
}

/** 读出目录里所有的 .md 文件，按路径排序。每次调用都重新读：服务器不缓存状态，笔记改了马上能看到 */
export async function loadNotes(root: string): Promise<Note[]> {
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(root, file), 'utf8');
      const title = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? file.split(sep).at(-1)!.replace(/\.md$/, '');
      return { path: file.split(sep).join('/'), title, text };
    }),
  );
}

/** 找到关键词的位置，前后各取一点作为摘要 */
function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ');
  const at = Math.max(0, flat.toLowerCase().indexOf(query.toLowerCase()));
  const start = Math.max(0, at - 30);
  return `${start > 0 ? '…' : ''}${flat.slice(start, at + query.length + 50)}${at + query.length + 50 < flat.length ? '…' : ''}`;
}

const searchOutput = z.object({
  results: z.array(z.object({ path: z.string(), title: z.string(), snippet: z.string() })),
  total: z.number(),
  nextCursor: z.string().optional().describe('还有更多结果时才有，原样传给下一次调用'),
});

const readOutput = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
  nextCursor: z.string().optional().describe('笔记还没读完时才有，原样传给下一次调用'),
});

/** 搜索笔记：标题或正文里包含关键词（不区分大小写）。cursor 有值时从上次停下的地方接着返回 */
export async function searchNotes(root: string, args: { query: string; limit: number; cursor?: string }) {
  // TODO 2：搜索并分页。
  // - 有 cursor 时用 decodeCursor(cursor, 'search') 解出 offset；游标里的 query 和这次的不一样，抛出错误，说明要去掉 cursor
  // - loadNotes(root) 读出所有笔记，标题或正文里包含 query（不区分大小写）的算匹配
  // - 返回第 offset 条开始的 limit 条：{ path, title, snippet: snippetOf(正文, query) }，再加上 total（一共匹配了几条）
  // - 后面还有结果时，加上 nextCursor：encodeCursor({ kind: 'search', query, offset: offset + limit })；没有就不要这个字段
  void encodeCursor;
  void snippetOf;
  return { results: [] as { path: string; title: string; snippet: string }[], total: 0, nextCursor: args.cursor };
}

/** 读一篇笔记。太长就分段，每次最多 READ_CHUNK 个字符，没读完时给出下一段的游标 */
export async function readNote(root: string, args: { path: string; cursor?: string }) {
  // TODO 3：分段读一篇笔记。
  // - 路径用 resolveInside(root, path) 限制在笔记目录里；不是 .md 结尾的，抛出错误说只能读 .md 笔记
  // - 有 cursor 时用 decodeCursor(cursor, 'read') 解出 offset；游标里的 path 和这次的不一样，抛出错误
  // - 文件读不了（不存在）：抛出错误，建议先用 search_notes 搜索
  // - 标题取第一个 # 标题，没有就用 path；content 是从 offset 开始的 READ_CHUNK 个字符
  // - 后面还有内容时，加上 nextCursor：encodeCursor({ kind: 'read', path, offset: offset + READ_CHUNK })
  void resolveInside;
  void decodeCursor;
  const text = await readFile(join(root, args.path), 'utf8');
  return { path: args.path, title: args.path, content: text, nextCursor: undefined as string | undefined };
}

/** 结构化结果同时放一份文字版：老的 client 只认 content 里的文字 */
function reply<T extends object>(text: string, structured: T) {
  return { content: [{ type: 'text' as const, text }], structuredContent: structured };
}

/** 工具执行出错：返回 isError 的结果，让模型看到原因，而不是让整个请求失败 */
function failure(error: unknown) {
  return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
}

/**
 * 创建服务器。stdio 和 HTTP 两种部署方式共用这一个工厂，工具、资源、提示词的定义只有一份。
 * 注册的顺序就是 tools/list 返回的顺序：顺序固定，工具定义在每次请求里一模一样，才能命中模型的提示缓存
 */
export function createNotesServer(root: string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: '个人笔记库。先用 search_notes 找到笔记，再用 read_note 读全文。',
  });

  server.registerTool(
    'search_notes',
    {
      title: '搜索笔记',
      description: '按关键词搜索笔记的标题和正文，返回路径、标题和一段摘要。要看全文，用 read_note。结果多时会给出 nextCursor，原样传回可以看下一页',
      inputSchema: z.object({
        query: z.string().min(1).describe('关键词'),
        limit: z.int().min(1).max(20).default(5).describe('每页最多几条，默认 5'),
        cursor: z.string().optional().describe('上一次结果里的 nextCursor，看下一页时才传'),
      }),
      outputSchema: searchOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await searchNotes(root, args);
        log(`search_notes「${args.query}」：${result.total} 条`);
        const lines = result.results.map((r) => `- ${r.path}｜${r.title}｜${r.snippet}`);
        const more = result.nextCursor ? `\n还有更多结果，传 cursor=${result.nextCursor} 看下一页` : '';
        const text = result.total ? `共 ${result.total} 条：\n${lines.join('\n')}${more}` : `没有找到包含「${args.query}」的笔记`;
        return reply(text, result);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'read_note',
    {
      title: '读笔记',
      description: `读一篇笔记的内容。每次最多返回 ${READ_CHUNK} 个字符；没读完时会给出 nextCursor，原样传回可以接着读`,
      inputSchema: z.object({
        path: z.string().describe('笔记的路径，来自 search_notes 的结果，比如 work/release.md'),
        cursor: z.string().optional().describe('上一次结果里的 nextCursor，接着读时才传'),
      }),
      outputSchema: readOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await readNote(root, args);
        const more = result.nextCursor ? `\n\n（还没读完，传 cursor=${result.nextCursor} 接着读）` : '';
        return reply(`# ${result.title}（${result.path}）\n\n${result.content}${more}`, result);
      } catch (error) {
        return failure(error);
      }
    },
  );

  // TODO 4：把每篇笔记注册成资源，URI 是 note://路径（比如 note://work/release.md）。
  // - server.registerResource('note', new ResourceTemplate('note://{+path}', { list }), { description, mimeType: 'text/markdown' }, read)
  //   {+path} 里的 + 表示变量里可以有 /
  // - list：返回 { resources: 每篇笔记 { uri, name: 路径, title: 标题, mimeType: 'text/markdown' } }
  // - read(uri, variables)：用 resolveInside(root, String(variables.path)) 读出全文，
  //   返回 { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }
  void ResourceTemplate;

  server.registerPrompt(
    'summarize_note',
    {
      title: '总结笔记',
      description: '让模型总结一篇笔记的要点',
      argsSchema: z.object({ path: z.string().describe('笔记的路径') }),
    },
    async ({ path }) => {
      const text = await readFile(resolveInside(root, path), 'utf8');
      return {
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `用三条要点总结下面这篇笔记：\n\n${text}` } }],
      };
    },
  );

  return server;
}

/** 笔记目录：环境变量 NOTES_DIR，默认当前目录 */
export function notesRootFromEnv(): string {
  return process.env.NOTES_DIR ?? '.';
}
