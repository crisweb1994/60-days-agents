// 第 49 天：用户反馈回流到评估集。用户点了「踩」的回答，是最真实、最有价值的评估用例：它们来自真实的问题，而且已经知道答错了。
//   记下：哪次运行、谁、好评还是差评、评论，以及当时的问题、回答、引用的来源、用的哪一版 prompt
//   回流：差评自动变成一条评估用例（第 31 天的格式），放进「待审核」的文件。人看过、补上期望（正确答案里该有什么事实、不该出现什么），
//        再挪进正式的评估集。不审核直接用，期望是空的，评估什么都检查不出来
//   隐私：问题和回答进评估集之前先脱敏（第 39 天）；评估集会进代码仓库、会被很多人看到
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EvalCaseSchema, parseDataset, type EvalCase } from './eval/dataset.ts';
import { maskPII } from './guardrails.ts';

export interface Feedback {
  runId: string;
  userId: string;
  rating: 'up' | 'down';
  comment?: string;
  question: string;
  answer: string;
  /** 回答引用的来源网址 */
  sources: string[];
  /** 生成这个回答的 prompt 版本 */
  promptVersion: string;
  /** A/B 测试的变体 */
  variant?: string;
  createdAt: string;
}

/** 用例的编号：fb- 加上问题的 sha256 前 10 位。同一个问题被踩多次，只是同一条用例 */
export function feedbackCaseId(question: string): string {
  return `fb-${createHash('sha256').update(question.trim()).digest('hex').slice(0, 10)}`;
}

/**
 * 一条差评变成一条待审核的评估用例：
 * - id 是 feedbackCaseId，question 是脱敏以后的问题
 * - tags：feedback，加上 prompt 版本（「prompt:版本号」），有变体再加「variant:变体名」
 * - expected 先空着，但把当时引用的来源放进 notes：审核的人要判断这些来源对不对
 * - notes：「用户反馈：评论」、「当时的回答：前 300 字（脱敏）」、「当时的来源：…」、「待审核：补上 expected 以后挪进正式的评估集」，用换行连起来
 * 用 EvalCaseSchema.parse 校验一遍再返回：格式不对，在这里就发现，而不是等到跑评估时
 */
export function feedbackToCase(feedback: Feedback): EvalCase {
  const tags = ['feedback', `prompt:${feedback.promptVersion}`, ...(feedback.variant ? [`variant:${feedback.variant}`] : [])];
  const answer = maskPII(feedback.answer).text;
  const notes = [
    `用户反馈：${feedback.comment ? maskPII(feedback.comment).text : '（没有写评论）'}`,
    `当时的回答：${answer.length > 300 ? `${answer.slice(0, 300)}…` : answer}`,
    `当时的来源：${feedback.sources.join('、') || '（没有）'}`,
    '待审核：补上 expected 以后挪进正式的评估集',
  ].join('\n');
  return EvalCaseSchema.parse({ id: feedbackCaseId(feedback.question), question: maskPII(feedback.question).text, tags, notes });
}

/**
 * 把用例追加到 JSONL 文件里（第 31 天的格式，一行一条）。文件里已经有同样编号的就跳过。返回实际追加了几条。
 * 先用 parseDataset 读出已有的（文件不存在就是空的），追加以后整个文件仍然要能被 parseDataset 读出来
 */
export async function appendCases(file: string, cases: EvalCase[]): Promise<number> {
  let existing: EvalCase[] = [];
  try {
    existing = parseDataset(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const seen = new Set(existing.map((c) => c.id));
  const fresh = cases.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  if (!fresh.length) return 0;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, fresh.map((c) => `${JSON.stringify(c)}\n`).join(''));
  return fresh.length;
}

export interface FeedbackStore {
  add(feedback: Feedback): Promise<void>;
  list(filter?: { promptVersion?: string; variant?: string }): Promise<Feedback[]>;
}

/** 内存里的反馈存储。线上放进数据库（记得开 RLS，第 46 天） */
export function createMemoryFeedbackStore(): FeedbackStore {
  const items: Feedback[] = [];
  return {
    async add(feedback) {
      items.push(feedback);
    },
    async list(filter = {}) {
      return items.filter((f) => (!filter.promptVersion || f.promptVersion === filter.promptVersion) && (!filter.variant || f.variant === filter.variant));
    },
  };
}

/**
 * 处理一条反馈：存下来；是差评就转成用例，追加到待审核的文件。返回这条差评有没有产生新的用例
 */
export async function handleFeedback(store: FeedbackStore, feedback: Feedback, pendingFile: string): Promise<boolean> {
  await store.add(feedback);
  if (feedback.rating !== 'down') return false;
  return (await appendCases(pendingFile, [feedbackToCase(feedback)])) > 0;
}

/** 按变体统计好评：给 rollout.ts 的 compareRates 用 */
export async function ratingStats(store: FeedbackStore, variant: string): Promise<{ successes: number; total: number }> {
  const items = await store.list({ variant });
  return { successes: items.filter((f) => f.rating === 'up').length, total: items.length };
}
