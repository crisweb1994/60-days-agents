// 第 53 天：review-bot 的五个工具（第 52 天的设计文档里那张表）。
//   list_changed_files、read_diff、read_file、search_code：只读
//   add_comment：只是加进草稿（ReviewDraft），不会马上发出去。真正发到 PR 上的是流程代码（第 54、56 天）
// 工具的错误信息写给模型看：说清楚错在哪、该怎么改（第 11 天）。比如评论的行不在 diff 里，就告诉它哪些行可以评论。
import { z } from 'zod';
import type { PermissionPolicy } from './core/permissions.ts';
import { defineTool, paginate, type Tool } from './core/tool.ts';
import { commentableLines, describeFile, formatRanges, renderFileDiff, type FileDiff } from './diff.ts';
import type { Repo } from './repo.ts';

export const SEVERITIES = ['high', 'medium', 'low'] as const;
export const KINDS = ['security', 'bug', 'performance', 'privacy', 'maintainability'] as const;

/**
 * review-bot 的权限策略（第 29 天）：只读的直接执行；可写的只有 add_comment（只是进草稿）；其余一律禁止。
 * 不写策略的话，可写的工具没人确认就不会执行。审查机器人在后台跑，没人可问，所以要把允许的范围写死
 */
export const REVIEW_POLICY: PermissionPolicy = { read: 'allow', write: 'deny', irreversible: 'deny', tools: { add_comment: 'allow' } };

export interface ReviewComment {
  file: string;
  /** 新文件里的行号，要在 diff 里 */
  line: number;
  severity: (typeof SEVERITIES)[number];
  kind: (typeof KINDS)[number];
  body: string;
}

export interface ReviewDraft {
  readonly comments: ReviewComment[];
  /** 加一条评论，返回它是第几条；不合规就抛错，错误信息写给模型看 */
  add(comment: ReviewComment): number;
}

/**
 * 评论的草稿（TODO 4）。add 依次检查：
 * 1. 文件要在这次的 diff 里，否则「x 不在这次的改动里。改动的文件：a、b」
 * 2. 行号要在 commentableLines 里，否则「第 n 行不在 x 的 diff 里，能评论的行：1–3、5」
 * 3. 同一个文件、同一行、同一类已经有一条了，就「x 第 n 行已经有一条 kind 的评论了，不要重复」
 * 通过了就存一份副本（body 去掉首尾空白），返回它是第几条（从 1 开始）
 */
export function createDraft(files: FileDiff[]): ReviewDraft {
  const comments: ReviewComment[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    comments,
    add(comment) {
      const file = byPath.get(comment.file);
      if (!file) throw new Error(`${comment.file} 不在这次的改动里。改动的文件：${[...byPath.keys()].join('、')}`);
      const lines = commentableLines(file);
      if (!lines.has(comment.line)) throw new Error(`第 ${comment.line} 行不在 ${comment.file} 的 diff 里，能评论的行：${formatRanges(lines)}`);
      if (comments.some((c) => c.file === comment.file && c.line === comment.line && c.kind === comment.kind)) {
        throw new Error(`${comment.file} 第 ${comment.line} 行已经有一条 ${comment.kind} 的评论了，不要重复`);
      }
      comments.push({ ...comment, body: comment.body.trim() });
      return comments.length;
    },
  };
}

export interface ReviewToolsOptions {
  files: FileDiff[];
  repo: Repo;
  draft: ReviewDraft;
  /** read_diff 每页多少个字符，默认 12000 */
  diffPageSize?: number;
  /** 不审的文件（生成的、删掉的），list_changed_files 会提到 */
  skipped?: FileDiff[];
}

export function createReviewTools(options: ReviewToolsOptions): Tool[] {
  const { files, repo, draft, diffPageSize = 12_000, skipped = [] } = options;
  const find = (path: string) => {
    const file = files.find((f) => f.path === path);
    if (!file) throw new Error(`${path} 不在这次的改动里。改动的文件：${files.map((f) => f.path).join('、')}`);
    return file;
  };
  return [
    defineTool({
      name: 'list_changed_files',
      description: '列出这个 PR 改了哪些文件，每个文件加了几行、删了几行。不审的文件（生成的、删掉的）也会列出来',
      schema: z.object({}),
      execute: () => {
        const lines = files.map((f) => `- ${describeFile(f)}`);
        if (skipped.length) lines.push(`不审：${skipped.map((f) => f.path).join('、')}（生成的或者删掉的文件）`);
        return lines.join('\n') || '这个 PR 没有改任何文件';
      },
    }),
    defineTool({
      name: 'read_diff',
      description: '读一个文件的 diff。每行前面是新文件的行号（删掉的行没有行号）；add_comment 用这个行号。diff 太长会分页',
      schema: z.object({
        path: z.string().describe('文件路径，来自 list_changed_files'),
        page: z.int().min(1).default(1).describe('第几页，默认 1'),
      }),
      execute: ({ path, page }) => paginate(renderFileDiff(find(path)), page, diffPageSize).content,
    }),
    defineTool({
      name: 'read_file',
      description: '读仓库里改动以后的文件，可以只读一段行（一次最多 200 行）。用来看函数的定义、调用方、上下文',
      schema: z.object({
        path: z.string().describe('相对于仓库根目录的路径，比如 src/db.ts'),
        start: z.int().min(1).optional().describe('从第几行开始，默认 1'),
        end: z.int().min(1).optional().describe('读到第几行（含），默认读 200 行'),
      }),
      execute: async ({ path, start, end }) => {
        const slice = await repo.readLines(path, start, end);
        const more = slice.end < slice.total ? `\n（共 ${slice.total} 行，还没读完，用 start=${slice.end + 1} 接着读）` : '';
        return `${slice.path} 第 ${slice.start}–${slice.end} 行：\n${slice.text}${more}`;
      },
    }),
    defineTool({
      name: 'search_code',
      description: '在仓库里按文字搜索（不分大小写），返回文件、行号和那一行。用来找函数的定义和用法、看别处是怎么写的',
      schema: z.object({ query: z.string().min(1).describe('要找的文字，比如函数名 requireAdmin') }),
      execute: async ({ query }) => {
        const hits = await repo.search(query);
        return hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : `仓库里没有找到「${query}」`;
      },
    }),
    defineTool({
      name: 'add_comment',
      description: '在某个文件的某一行加一条审查评论（加进草稿）。只评论真正的问题：安全、bug、性能、隐私；不评风格。说明为什么是问题、怎么改',
      schema: z.object({
        file: z.string().describe('文件路径'),
        line: z.int().min(1).describe('新文件里的行号，要是 read_diff 里带行号的行'),
        severity: z.enum(SEVERITIES).describe('high：会出事故；medium：应该改；low：可以更好'),
        kind: z.enum(KINDS),
        body: z.string().trim().min(10, '评论太短了：说清楚为什么是问题、怎么改').max(1000),
      }),
      risk: 'write',
      execute: (comment) => `已加入草稿（第 ${draft.add(comment)} 条）`,
    }),
  ];
}
