// 第 54 天：把工具接成 review-bot。第 52 天设计文档里的流程：
//   解析 diff → 跳过生成的文件、限制文件数 → 每个文件派一个审查 Agent（并行，有上限）→ 汇总（代码检查：行号、去重、限量）
//   → 同时写总结（一次模型调用，没有工具）→ 结果
// 一个文件的 Agent 出错，不影响别的文件：这个 PR 的结果是 partial，出错的文件写明原因（第 35 天的优雅降级）。
// 第 54 天的练习：TODO 1–3 在这里，TODO 4 在 eval/run.ts。检查：npm run check 54
import { runAgent, type AgentStatus } from './core/agent.ts';
import { mapLimit } from './core/parallel.ts';
import type { Model } from './core/types.ts';
import { addUsage, emptyUsage, type Usage } from './core/usage.ts';
import { commentableLines, parseDiff, reviewableFiles, type FileDiff } from './diff.ts';
import { fileTask, reviewSystem, SUMMARY_PROMPT, summaryTask } from './prompts.ts';
import type { Repo } from './repo.ts';
import { createDraft, createReviewTools, REVIEW_POLICY, SEVERITIES, type ReviewComment } from './tools.ts';

export interface ReviewOptions {
  model: Model;
  repo: Repo;
  /** 同时审几个文件，默认 3 */
  concurrency?: number;
  /** 一个 PR 最多审几个文件，默认 20。多出来的跳过 */
  maxFiles?: number;
  /** 每个文件最多留几条评论，默认 5 */
  maxCommentsPerFile?: number;
  /** 每个文件的 Agent 最多调用几次模型，默认 8 */
  maxSteps?: number;
  /** 仓库的约定（REVIEW.md 的内容） */
  conventions?: string;
  signal?: AbortSignal;
}

export interface FileReview {
  path: string;
  /** Agent 怎么结束的；出错了是 error */
  status: AgentStatus | 'error';
  /** 这个 Agent 加的评论（汇总之前） */
  comments: ReviewComment[];
  usage: Usage;
  steps: number;
  /** 出错的原因 */
  error?: string;
}

export interface Dropped {
  comment: ReviewComment;
  reason: '不在 diff 里' | '重复' | '超过每个文件的上限';
}

export interface ReviewResult {
  /** completed：每个文件都正常审完；partial：有文件出错或者没有正常结束 */
  status: 'completed' | 'partial';
  comments: ReviewComment[];
  summary: string;
  files: FileReview[];
  /** 没审的文件：生成的、删掉的、二进制的、超过文件数上限的 */
  skipped: string[];
  dropped: Dropped[];
  usage: Usage;
}

export interface ReviewInput {
  title: string;
  diff: string;
}

/**
 * 审一个文件（TODO 1）：
 * - 草稿用这次所有要审的文件建（createDraft(files)）：Agent 发现别的文件里的问题也能评论，汇总时再去重
 * - 工具用 createReviewTools({ files, skipped, repo, draft })
 * - runAgent(fileTask(title, file), { model, tools, system: reviewSystem(conventions), maxSteps, policy: REVIEW_POLICY, signal })
 * - 返回 path、status、草稿里的评论、usage、steps
 * - runAgent 抛错（模型服务挂了之类的）：不要抛出去，返回 status 是 error、error 是错误信息、没有评论、空的用量、0 步
 */
export async function reviewFile(
  title: string,
  file: FileDiff,
  ctx: { files: FileDiff[]; skipped: FileDiff[]; options: ReviewOptions },
): Promise<FileReview> {
  // TODO 1：按上面注释建草稿和工具、跑 runAgent，用 try/catch 把出错变成 status 是 error 的结果。
  // 注意 comments 要交出草稿里评论的副本（[...draft.comments]）
  void runAgent; void createDraft; void createReviewTools; void REVIEW_POLICY; void fileTask; void reviewSystem; void title; void ctx;
  return { path: file.path, status: 'error', comments: [], usage: emptyUsage(), steps: 0, error: 'TODO 1：还没有实现 reviewFile' };
}

const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<ReviewComment['severity'], number>;

/**
 * 汇总评论（TODO 2）。能用代码检查的，不交给模型：
 * 1. 文件不在 files 里、或者行号不在这个文件的 commentableLines 里：丢掉，原因「不在 diff 里」
 * 2. 同一个文件、同一类（kind）、行号相差不超过 1 的算重复：留严重程度高的（一样高留先出现的），另一条丢掉，原因「重复」
 * 3. 每个文件最多留 maxPerFile 条：按严重程度从高到低留（一样的保持原来的顺序），其余丢掉，原因「超过每个文件的上限」
 * 留下的按文件在 files 里的顺序、再按行号排好。dropped 按丢掉的先后顺序
 */
export function aggregate(comments: ReviewComment[], files: FileDiff[], maxPerFile = 5): { comments: ReviewComment[]; dropped: Dropped[] } {
  // TODO 2：分三步：
  // 1. 用 commentableLines 建一个「文件 → 能评论的行」的 Map，过滤掉对不上的
  // 2. 一条条放进 kept：找有没有重复的（同文件、同 kind、行号差 ≤ 1）；有就比严重程度（RANK 越小越严重），留严重的
  // 3. 按 files 的顺序处理每个文件：按严重程度排序（sort 是稳定的）取前 maxPerFile 条，其余丢掉；留下的按行号排好
  void RANK; void commentableLines; void files; void maxPerFile;
  return { comments, dropped: [] };
}

/** 写总结：一次模型调用，没有工具 */
export async function summarize(title: string, files: FileDiff[], model: Model, signal?: AbortSignal): Promise<{ text: string; usage: Usage }> {
  const result = await model.chat({ messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: summaryTask(title, files) }] }, { signal });
  return { text: (result.message.content ?? '').trim(), usage: result.usage };
}

/**
 * 审一个 PR（TODO 3）：
 * 1. parseDiff、reviewableFiles；要审的超过 maxFiles（默认 20）的，多出来的也算跳过。skipped 是这些文件的路径
 * 2. 没有要审的文件：不调用模型。summary 是「这个 PR 没有改动」（diff 是空的）或者「只改了不需要审查的文件：a、b」
 * 3. 否则同时做两件事：mapLimit(要审的文件, concurrency 默认 3, reviewFile) 和 summarize（总结出错时 summary 是空字符串）
 * 4. 所有文件的评论按文件的顺序拼起来，交给 aggregate(…, 要审的文件, maxCommentsPerFile 默认 5)
 * 5. usage 是所有文件和总结的用量加起来；有文件不是 completed，status 就是 partial
 */
export async function review(input: ReviewInput, options: ReviewOptions): Promise<ReviewResult> {
  // TODO 3：按上面注释的五步做。两件同时做的事用 Promise.all；mapLimit 返回的是 PromiseSettledResult，
  // rejected 的（理论上 reviewFile 不会抛错，但还是要防着）也变成一个 status 是 error 的 FileReview
  void parseDiff; void reviewableFiles; void mapLimit; void summarize; void aggregate; void addUsage; void input; void options;
  throw new Error('TODO 3：还没有实现 review');
}

const SEVERITY_LABEL = { high: '🔴 严重', medium: '🟠 应该改', low: '🟡 可以更好' } as const;

/** 发到 PR 上的总评：总结、评论的数量、没审的文件、出错的文件。行内评论另外发（第 56 天） */
export function renderReview(result: ReviewResult): string {
  const lines = ['## review-bot', '', result.summary || '（没有写出总结）', ''];
  if (result.comments.length) {
    lines.push(`发现 ${result.comments.length} 个问题：`, '');
    for (const c of result.comments) lines.push(`- ${SEVERITY_LABEL[c.severity]} \`${c.file}:${c.line}\` ${c.body.split('\n')[0]}`);
  } else lines.push('没有发现问题。');
  if (result.skipped.length) lines.push('', `没有审查：${result.skipped.join('、')}`);
  const failed = result.files.filter((f) => f.status !== 'completed');
  if (failed.length) lines.push('', `⚠️ 这几个文件没有审完：${failed.map((f) => f.path).join('、')}`);
  return lines.join('\n');
}
