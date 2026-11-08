// 第 51 天：需求说明。一页给人看的 Markdown，里面放一段给程序检查的 JSON（```json 代码块）：
//   用户和他们的痛点、要完成的任务、明确不做的事、可衡量的成功标准、单次任务的预算
// 程序检查的是「写得够不够具体」：成功标准有没有数字、有没有覆盖每个任务、有没有用「更好」「尽量」这种量不出来的词。
// 写得具体，第 55 天才知道什么时候算达标、可以停下来。
import { z } from 'zod';

const Id = z.string().regex(/^[a-z][a-z0-9-]*$/, '编号只能用小写字母、数字和连字符，字母开头');

export const SpecSchema = z.strictObject({
  /** 项目名 */
  name: z.string().min(1),
  /** 一句话：给谁、解决什么问题 */
  pitch: z.string().min(1),
  users: z.array(z.strictObject({ who: z.string().min(1), pain: z.string().min(1) })).min(1, '至少写一类用户'),
  tasks: z
    .array(
      z.strictObject({
        id: Id,
        description: z.string().min(1),
        /** 一个真实的例子：用户会怎么说、给什么输入 */
        example: z.string().min(1),
      }),
    )
    .min(1, '至少写一个任务'),
  /** 明确不做的事。写下来，范围才不会一点点变大 */
  nonGoals: z.array(z.string().min(1)).min(1, '至少写一件不做的事'),
  criteria: z
    .array(
      z.strictObject({
        id: Id,
        /** 衡量什么，比如「问题召回率」「误报率」 */
        metric: z.string().min(1),
        /** at-least：不低于 target；at-most：不高于 target */
        direction: z.enum(['at-least', 'at-most']),
        target: z.number(),
        /** 单位：% 表示 target 写成 0–100；不写单位的比率写成 0–1 */
        unit: z.string().optional(),
        /** 怎么量：在哪个评估集上、用什么评分器、跑几次 */
        how: z.string().min(1),
        /** 针对哪些任务；不写表示所有任务 */
        tasks: z.array(z.string()).optional(),
      }),
    )
    .min(1, '至少写一条成功标准'),
  budget: z.strictObject({
    /** 单次任务最多花多少钱（元） */
    costPerTask: z.number().positive(),
    /** 95% 的任务在多少秒内完成 */
    p95Seconds: z.number().positive(),
  }),
  risks: z.array(z.string()).default([]),
});

export type Spec = z.infer<typeof SpecSchema>;

export interface Problem {
  level: 'error' | 'warn';
  message: string;
}

/**
 * 从 Markdown 里取出第一个 ```json 代码块，解析并用 SpecSchema 校验。
 * 没有代码块、不是合法的 JSON、字段不对，都抛出错误，信息里说清楚是哪一种；字段不对时带上字段的路径
 */
export function extractSpec(markdown: string): Spec {
  const match = /```json[^\n]*\n([\s\S]*?)```/.exec(markdown);
  if (!match) throw new Error('没有找到 ```json 代码块：需求说明里要有一段给程序检查的 JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`json 代码块不是合法的 JSON：${(error as Error).message}`);
  }
  const parsed = SpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`需求说明的字段不对：${issue.path.join('.') || '（整个对象）'}：${issue.message}`);
  }
  return parsed.data;
}

/** 量不出来的词。成功标准里出现它们，多半是还没想清楚怎么量 */
export const VAGUE_WORDS = ['更好', '更快', '尽量', '尽可能', '友好', '智能', '满意', '高质量', '好用', '合理', '大部分', '基本'];

/**
 * 检查需求说明写得够不够具体（TODO 1），返回发现的问题（没有问题是空数组），按下面的顺序：
 * 1. 任务编号、成功标准编号重复：error「任务编号重复：x」「成功标准编号重复：x」
 * 2. 成功标准引用了不存在的任务：error「成功标准 c 引用了不存在的任务：x」
 * 3. 成功标准的 metric 或 how 里有 VAGUE_WORDS：warn「成功标准 c 用了量不出来的词：更好、尽量」（按 VAGUE_WORDS 的顺序，去重）
 * 4. 目标值不合理：unit 是 % 的要在 0–100；没有 unit 而 metric 以「率」结尾的要在 0–1。
 *    不合理就 error「成功标准 c 的目标值 x 不在 0–100 之间」或「…不在 0–1 之间（比率写成小数，或者把 unit 写成 %）」
 * 5. 没有任何成功标准覆盖的任务（tasks 不写表示覆盖所有任务）：warn「任务 x 没有成功标准」
 */
export function checkSpec(spec: Spec): Problem[] {
  const problems: Problem[] = [];
  const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  for (const id of dupes(spec.tasks.map((t) => t.id))) problems.push({ level: 'error', message: `任务编号重复：${id}` });
  for (const id of dupes(spec.criteria.map((c) => c.id))) problems.push({ level: 'error', message: `成功标准编号重复：${id}` });
  const taskIds = new Set(spec.tasks.map((t) => t.id));
  for (const c of spec.criteria) {
    for (const t of c.tasks ?? []) if (!taskIds.has(t)) problems.push({ level: 'error', message: `成功标准 ${c.id} 引用了不存在的任务：${t}` });
  }
  for (const c of spec.criteria) {
    const text = `${c.metric} ${c.how}`;
    const found = VAGUE_WORDS.filter((w) => text.includes(w));
    if (found.length) problems.push({ level: 'warn', message: `成功标准 ${c.id} 用了量不出来的词：${found.join('、')}` });
  }
  for (const c of spec.criteria) {
    if (c.unit === '%' && (c.target < 0 || c.target > 100)) problems.push({ level: 'error', message: `成功标准 ${c.id} 的目标值 ${c.target} 不在 0–100 之间` });
    if (!c.unit && c.metric.endsWith('率') && (c.target < 0 || c.target > 1)) problems.push({ level: 'error', message: `成功标准 ${c.id} 的目标值 ${c.target} 不在 0–1 之间（比率写成小数，或者把 unit 写成 %）` });
  }
  for (const t of spec.tasks) {
    if (!spec.criteria.some((c) => !c.tasks || c.tasks.includes(t.id))) problems.push({ level: 'warn', message: `任务 ${t.id} 没有成功标准` });
  }
  return problems;
}

/** 把成功标准写成一句给人看的话，比如「问题召回率 ≥ 70%」「误报 ≤ 0 条」 */
export function describeCriterion(c: Spec['criteria'][number]): string {
  const unit = c.unit === '%' ? '%' : c.unit ? ` ${c.unit}` : '';
  return `${c.metric} ${c.direction === 'at-least' ? '≥' : '≤'} ${c.target}${unit}`;
}
