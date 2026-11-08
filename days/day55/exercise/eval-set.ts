// 第 51 天：毕业项目的评估集。格式和第 31 天的研究助手评估集是同一个思路，但更通用：
//   input 和 expected 由你的项目自己定（代码审查是 diff 和应该发现的问题，客服是用户的话和应该给出的答案……）
//   task 对上需求说明里的任务编号，tags 标出用例的类型：edge（边界）、negative（不该做什么）、safety（攻击、越权）
// 先写评估集、后写代码：它就是「做完了」的定义。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Problem, Spec } from './spec.ts';

export const CaseSchema = z.strictObject({
  /** 唯一的编号，定下来就不要改：对比两次评估的结果靠它对上号 */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能用小写字母、数字和连字符'),
  /** 需求说明里的任务编号 */
  task: z.string().min(1),
  /** 交给 Agent 的输入，格式由项目定 */
  input: z.unknown().refine((v) => v !== undefined && v !== null, '要有 input'),
  /** 期望，格式由项目定。空对象表示还没写期望 */
  expected: z.record(z.string(), z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
  /** 写给人看的说明：为什么有这条、答案是怎么来的 */
  notes: z.string().optional(),
});

export type Case = z.infer<typeof CaseSchema>;

/**
 * 读 JSONL：一行一条，空行和 // 开头的注释跳过。哪一行不对，错误信息里带上行号（从 1 开始）：
 * 「第 3 行不是合法的 JSON」「第 5 行：id：id 只能用小写字母……」
 */
export function parseCases(text: string): Case[] {
  const cases: Case[] = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error(`第 ${index + 1} 行不是合法的 JSON`);
    }
    const parsed = CaseSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`第 ${index + 1} 行：${issue.path.join('.') || '（整条）'}：${issue.message}`);
    }
    cases.push(parsed.data);
  });
  return cases;
}

/** 按键排好序的 JSON：两个对象内容一样、键的顺序不同，也得到同一个字符串 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface Coverage {
  /** 每个任务有几条用例（需求说明里的每个任务都要有，没有的是 0） */
  perTask: Record<string, number>;
  /** 每个 tag 有几条 */
  perTag: Record<string, number>;
  problems: Problem[];
  /** 没有 error */
  ok: boolean;
}

/** 评估集至少要有的几类用例 */
export const REQUIRED_TAGS: Record<string, string> = {
  edge: '没有边界用例（edge）：空输入、超长输入、格式奇怪的输入',
  negative: '没有反面用例（negative）：什么都不该做、应该拒绝或者说不知道的情况',
  safety: '没有安全用例（safety）：输入里夹带指令、越权、诱导泄露',
};

/**
 * 检查评估集对需求说明的覆盖（TODO 2）。problems 按下面的顺序：
 * 1. 编号重复：error「用例编号重复：x」
 * 2. task 不在需求说明里：error「用例 x 的任务 t 不在需求说明里」
 * 3. 每个任务的用例少于 minPerTask（默认 5）：warn「任务 t 只有 n 条用例，至少要 m 条」
 * 4. REQUIRED_TAGS 里每个 tag：一条都没有就 warn，信息是 REQUIRED_TAGS 里的那句
 * 5. 输入完全一样（用 canonicalJson 比较）的用例：warn「用例 b 和 a 的输入一样」（a 是先出现的那条）
 * 6. expected 是空对象：warn「用例 x 还没有写期望，检查不出任何东西」
 * ok 是「没有 error」
 */
export function checkCoverage(spec: Spec, cases: Case[], { minPerTask = 5 } = {}): Coverage {
  const problems: Problem[] = [];
  const perTask: Record<string, number> = Object.fromEntries(spec.tasks.map((t) => [t.id, 0]));
  const perTag: Record<string, number> = {};
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) problems.push({ level: 'error', message: `用例编号重复：${c.id}` });
    ids.add(c.id);
  }
  for (const c of cases) {
    if (c.task in perTask) perTask[c.task]++;
    else problems.push({ level: 'error', message: `用例 ${c.id} 的任务 ${c.task} 不在需求说明里` });
    for (const tag of c.tags) perTag[tag] = (perTag[tag] ?? 0) + 1;
  }
  for (const [task, n] of Object.entries(perTask)) {
    if (n < minPerTask) problems.push({ level: 'warn', message: `任务 ${task} 只有 ${n} 条用例，至少要 ${minPerTask} 条` });
  }
  for (const [tag, message] of Object.entries(REQUIRED_TAGS)) if (!perTag[tag]) problems.push({ level: 'warn', message });
  const inputs = new Map<string, string>();
  for (const c of cases) {
    const key = canonicalJson(c.input);
    const first = inputs.get(key);
    if (first) problems.push({ level: 'warn', message: `用例 ${c.id} 和 ${first} 的输入一样` });
    else inputs.set(key, c.id);
  }
  for (const c of cases) if (Object.keys(c.expected).length === 0) problems.push({ level: 'warn', message: `用例 ${c.id} 还没有写期望，检查不出任何东西` });
  return { perTask, perTag, problems, ok: !problems.some((p) => p.level === 'error') };
}

/** 用例落在 0–99 的哪个桶：编号的 sha256 前 8 位换成整数再对 100 取余 */
export function caseBucket(id: string): number {
  return parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) % 100;
}

/**
 * 分成开发集和测试集（TODO 3）：桶号小于 testPercent（默认 30）的进测试集，其余进开发集，各自保持原来的顺序。
 * 按编号的哈希分，而不是随机：加了新用例，旧用例待在原来的那一边；任何时候、任何机器分出来都一样。
 * 第 55 天迭代时只看开发集，测试集留到最后确认有没有「对着评估集调 prompt」
 */
export function splitCases(cases: Case[], { testPercent = 30 } = {}): { dev: Case[]; test: Case[] } {
  const dev: Case[] = [];
  const test: Case[] = [];
  for (const c of cases) (caseBucket(c.id) < testPercent ? test : dev).push(c);
  return { dev, test };
}

/** 一页报告：每个任务几条、每个 tag 几条、问题列表 */
export function renderCoverage(spec: Spec, coverage: Coverage): string {
  const lines = [`# ${spec.name} 的评估集`, '', '| 任务 | 用例 |', '|---|---|'];
  for (const t of spec.tasks) lines.push(`| ${t.id} | ${coverage.perTask[t.id] ?? 0} |`);
  const tags = Object.entries(coverage.perTag).sort((a, b) => b[1] - a[1]);
  lines.push('', `tags：${tags.map(([t, n]) => `${t} ${n}`).join('，') || '（没有）'}`, '');
  if (coverage.problems.length) lines.push(...coverage.problems.map((p) => `- ${p.level === 'error' ? '❌' : '⚠️'} ${p.message}`));
  else lines.push('- ✅ 没有发现问题');
  return `${lines.join('\n')}\n`;
}
