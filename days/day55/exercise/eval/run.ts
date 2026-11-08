// 第 54 天：在评估集上跑 review-bot，逐条判断过没过。今天的目标是「核心用例跑通」：每条用例要么过、要么说清楚差在哪。
// 第 55 天再加上精确率、召回率这些汇总的分数，按分数迭代。
import { z } from 'zod';
import { mapLimit } from '../core/parallel.ts';
import type { Model } from '../core/types.ts';
import { addUsage, emptyUsage, type Usage } from '../core/usage.ts';
import { parseDiff, reviewableFiles } from '../diff.ts';
import type { Repo } from '../repo.ts';
import { review, summarize, type ReviewOptions, type ReviewResult } from '../review.ts';
import type { ReviewComment } from '../tools.ts';

export const ExpectedIssueSchema = z.object({
  file: z.string(),
  line: z.int().min(1),
  kind: z.string(),
  /** 评论里至少出现一个，才算说对了问题 */
  keywords: z.array(z.string()).min(1),
});

export const ReviewCaseSchema = z.object({
  id: z.string(),
  task: z.enum(['review', 'summary']),
  input: z.object({ title: z.string(), diff: z.string() }),
  expected: z.object({
    issues: z.array(ExpectedIssueSchema).default([]),
    skipped: z.array(z.string()).default([]),
    mentions: z.array(z.string()).default([]),
    forbidden: z.array(z.string()).default([]),
  }),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export type ExpectedIssue = z.infer<typeof ExpectedIssueSchema>;
export type ReviewCase = z.infer<typeof ReviewCaseSchema>;

/** 读评估集（第 51 天的 JSONL，// 开头的是注释），按 review-bot 的格式校验 */
export function parseReviewCases(text: string): ReviewCase[] {
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .map((l, i) => {
      const parsed = ReviewCaseSchema.safeParse(JSON.parse(l));
      if (!parsed.success) throw new Error(`第 ${i + 1} 条用例：${parsed.error.issues[0].path.join('.')}：${parsed.error.issues[0].message}`);
      return parsed.data;
    });
}

/** 行号最多差几行还算对上：删掉的行没有新行号，评论只能落在附近（第 53 天） */
export const LINE_TOLERANCE = 2;

/** 一条评论能不能对上一个应该发现的问题：同一个文件、行号差不超过 LINE_TOLERANCE、评论里有至少一个关键词（不分大小写） */
export function matchesIssue(comment: ReviewComment, issue: ExpectedIssue): boolean {
  const body = comment.body.toLowerCase();
  return comment.file === issue.file && Math.abs(comment.line - issue.line) <= LINE_TOLERANCE && issue.keywords.some((k) => body.includes(k.toLowerCase()));
}

export interface CaseCheck {
  pass: boolean;
  problems: string[];
}

/**
 * 判断一条用例过没过（TODO 4），problems 按下面的顺序：
 * - review 任务：
 *   每个应该发现的问题，没有评论对得上（matchesIssue）：「漏了 file:line 的问题（kind）」
 *   每条对不上任何问题的评论：「多余的评论 file:line：评论的前 30 个字」
 *   expected.skipped 里的文件没有跳过：「应该跳过 x」
 * - summary 任务：expected.mentions 里每一个，总结里没有（不分大小写）：「总结没有提到「x」」
 * - 两种任务都查 forbidden：总结或者任何一条评论里出现了（不分大小写）：「出现了不该有的「x」」
 * pass 是「没有 problem」
 */
export function checkCase(c: ReviewCase, output: Pick<ReviewResult, 'comments' | 'summary' | 'skipped'>): CaseCheck {
  const problems: string[] = [];
  if (c.task === 'review') {
    for (const issue of c.expected.issues) {
      if (!output.comments.some((cm) => matchesIssue(cm, issue))) problems.push(`漏了 ${issue.file}:${issue.line} 的问题（${issue.kind}）`);
    }
    for (const cm of output.comments) {
      if (!c.expected.issues.some((issue) => matchesIssue(cm, issue))) problems.push(`多余的评论 ${cm.file}:${cm.line}：${[...cm.body].slice(0, 30).join('')}`);
    }
    for (const path of c.expected.skipped) if (!output.skipped.includes(path)) problems.push(`应该跳过 ${path}`);
  } else {
    const summary = output.summary.toLowerCase();
    for (const m of c.expected.mentions) if (!summary.includes(m.toLowerCase())) problems.push(`总结没有提到「${m}」`);
  }
  const texts = [output.summary, ...output.comments.map((cm) => cm.body)].map((t) => t.toLowerCase());
  for (const f of c.expected.forbidden) if (texts.some((t) => t.includes(f.toLowerCase()))) problems.push(`出现了不该有的「${f}」`);
  return { pass: problems.length === 0, problems };
}

export interface CaseResult extends CaseCheck {
  id: string;
  task: ReviewCase['task'];
  tags: string[];
  output: Pick<ReviewResult, 'comments' | 'summary' | 'skipped' | 'status'> & { files?: ReviewResult['files'] };
  usage: Usage;
  ms: number;
  /** 跑的时候出错了 */
  error?: string;
}

export interface EvalSetup extends Omit<ReviewOptions, 'model' | 'repo'> {
  model: Model;
  repo: Repo;
}

/** 跑一条用例：review 任务走完整的 review()；summary 任务只调用 summarize，省钱 */
export async function runCase(c: ReviewCase, setup: EvalSetup): Promise<CaseResult> {
  const started = performance.now();
  const base = { id: c.id, task: c.task, tags: c.tags };
  try {
    let output: CaseResult['output'];
    let usage: Usage;
    if (c.task === 'review') {
      const result = await review(c.input, setup);
      output = { comments: result.comments, summary: result.summary, skipped: result.skipped, status: result.status, files: result.files };
      usage = result.usage;
    } else {
      const { review: files } = reviewableFiles(parseDiff(c.input.diff));
      const s = await summarize(c.input.title, files, setup.model, setup.signal);
      output = { comments: [], summary: s.text, skipped: [], status: 'completed' };
      usage = s.usage;
    }
    return { ...base, ...checkCase(c, output), output, usage, ms: Math.round(performance.now() - started) };
  } catch (error) {
    const message = (error as Error).message;
    return { ...base, pass: false, problems: [`运行出错：${message}`], output: { comments: [], summary: '', skipped: [], status: 'partial' }, usage: emptyUsage(), ms: Math.round(performance.now() - started), error: message };
  }
}

/** 跑一组用例，同时最多 concurrency 条（默认 2），结果的顺序和用例一样 */
export async function runEval(cases: ReviewCase[], setup: EvalSetup, concurrency = 2): Promise<{ results: CaseResult[]; passed: number; usage: Usage }> {
  const settled = await mapLimit(cases, concurrency, (c) => runCase(c, setup), setup.signal);
  const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : { id: cases[i].id, task: cases[i].task, tags: cases[i].tags, pass: false, problems: [String(s.reason)], output: { comments: [], summary: '', skipped: [], status: 'partial' as const }, usage: emptyUsage(), ms: 0 }));
  return { results, passed: results.filter((r) => r.pass).length, usage: results.map((r) => r.usage).reduce(addUsage, emptyUsage()) };
}

/** 一行一条：✅/❌、编号、用时、问题 */
export function renderResults(results: CaseResult[]): string {
  const lines = results.map((r) => `${r.pass ? '✅' : '❌'} ${r.id.padEnd(22)} ${String(r.ms).padStart(6)}ms  ${r.problems.join('；')}`);
  const passed = results.filter((r) => r.pass).length;
  lines.push('', `通过 ${passed}/${results.length}`);
  return lines.join('\n');
}
