// 第 31 天：评估集。一条用例 = 一个用户会问的问题 + 能用代码检查的期望。
// 存成 JSONL：一行一条，方便逐行追加、在代码评审里看出改了哪几条；// 开头的行是注释。
// 运行：node days/day31/exercise/eval/dataset.ts days/day31/data/eval/research.jsonl
// 第 31 天的练习：TODO 1、2 在这里，TODO 3–5 在 run.ts。检查：npm run check 31
import { z } from 'zod';

/** 一个期望的事实：一个词，或者几种等价的写法（出现一种就行）。比较时忽略空白 */
const Fact = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const EvalCaseSchema = z.object({
  /** 唯一的编号，只用小写字母、数字和连字符。定下来就不要改：对比两次评估的结果靠它对上号 */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能用小写字母、数字和连字符'),
  /** 用户会怎么问。尽量用真实用户的原话，不要替他们问得更清楚 */
  question: z.string().trim().min(1),
  /** 分组统计用，比如 web、docs、unanswerable */
  tags: z.array(z.string()).default([]),
  expected: z
    .object({
      /** 正确的回答里一定有的事实，全部出现才算对 */
      facts: z.array(Fact).default([]),
      /** 回答里不能出现的内容：常见的错误答案、编出来的数字 */
      forbidden: z.array(z.string().min(1)).default([]),
      /** 回答应该引用的来源：网址里的一段（比如 /pricing.html）或者本地文档（doc:guide/config.md） */
      sources: z.array(z.string().min(1)).default([]),
      /** 应该调用的工具（第 32 天的轨迹评分用） */
      tools: z.array(z.string().min(1)).default([]),
      /** 最多调用几次工具。闲聊的问题写 0（第 32 天的轨迹评分用） */
      maxToolCalls: z.int().min(0).optional(),
      /** 资料里没有答案：应该说没有查到，而不是编一个 */
      unanswerable: z.boolean().default(false),
    })
    .default({ facts: [], forbidden: [], sources: [], tools: [], unanswerable: false }),
  /** 写给人看的说明：为什么有这条、答案是怎么来的 */
  notes: z.string().optional(),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type Expected = EvalCase['expected'];

/** 评估集的格式有问题。problems 里每条都带着行号 */
export class DatasetError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`评估集有 ${problems.length} 处问题：\n${problems.join('\n')}`);
    this.name = 'DatasetError';
    this.problems = problems;
  }
}

/**
 * 解析 JSONL 格式的评估集。跳过空行和 // 开头的注释行；
 * 每一行先 JSON.parse，再用 EvalCaseSchema 校验（会补上默认值）。
 * 有问题不要遇到第一个就停：把所有问题都收集起来，带上行号（从 1 开始），一起抛出 DatasetError
 */
export function parseDataset(text: string): EvalCase[] {
  // TODO 1：按行解析（行号从 1 开始）。
  // - 去掉首尾空白以后是空行、或者以 // 开头的，跳过
  // - JSON.parse 失败：记一条「第 N 行：不是合法的 JSON」
  // - EvalCaseSchema.safeParse 不通过：记一条「第 N 行：」加上每个 issue 的 path（用 . 连起来）和 message
  // - 通过的放进 cases（用 parsed.data，它补上了默认值）
  // 所有行都看完以后，有问题就 throw new DatasetError(problems)
  void DatasetError;
  return text.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line) as EvalCase);
}

/** 这条用例有没有任何能检查的期望。一条什么都不检查的用例，永远通过，没有意义 */
export function hasExpectations(expected: Expected): boolean {
  return (
    expected.facts.length > 0 ||
    expected.forbidden.length > 0 ||
    expected.sources.length > 0 ||
    expected.tools.length > 0 ||
    expected.maxToolCalls !== undefined ||
    expected.unanswerable
  );
}

/**
 * 检查整个评估集，返回发现的问题（给人看的句子），没有问题返回空数组：
 * - id 重复：「id 重复：xxx」
 * - 没有任何能检查的期望：「xxx：没有任何可以检查的期望」
 * - unanswerable 的用例又写了 facts：「xxx：标了 unanswerable，就不该有 facts」
 */
export function validateDataset(cases: EvalCase[]): string[] {
  // TODO 2：按注释里的三种问题检查，问题的写法要和注释一样。没有期望的判断用 hasExpectations
  void hasExpectations;
  void cases;
  return [];
}

export interface SelectOptions {
  /** 只要带着这些标签之一的用例 */
  tags?: string[];
  /** 只要这些 id */
  ids?: string[];
  /** 最多几条（在按标签和 id 筛选之后） */
  limit?: number;
}

/** 按标签、id 挑出一部分用例，保持原来的顺序。改了一个地方，先跑相关的几条，比每次跑全部快得多 */
export function selectCases(cases: EvalCase[], { tags, ids, limit }: SelectOptions = {}): EvalCase[] {
  const picked = cases.filter((c) => (!tags?.length || c.tags.some((t) => tags.includes(t))) && (!ids?.length || ids.includes(c.id)));
  return limit === undefined ? picked : picked.slice(0, limit);
}

/** 每个标签有几条用例，按条数从多到少。一条用例可以有几个标签 */
export function countByTag(cases: EvalCase[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const c of cases) for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

if (import.meta.main) {
  const { readFile } = await import('node:fs/promises');
  const file = process.argv[2];
  if (!file) {
    console.error('用法：dataset.ts <评估集.jsonl>');
    process.exit(1);
  }
  const cases = parseDataset(await readFile(file, 'utf8'));
  const problems = validateDataset(cases);
  console.log(`${cases.length} 条用例：${countByTag(cases).map(([tag, n]) => `${tag} ${n}`).join('，')}`);
  if (problems.length) {
    console.log(problems.map((p) => `- ${p}`).join('\n'));
    process.exit(1);
  }
}
