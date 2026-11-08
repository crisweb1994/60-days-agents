import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const s = await loadTarget<typeof import('../solution/spec.ts')>(import.meta.url, 'spec.ts');
const { extractSpec, checkSpec, describeCriterion } = s;
const e = await loadTarget<typeof import('../solution/eval-set.ts')>(import.meta.url, 'eval-set.ts');
const { parseCases, checkCoverage, splitCases, caseBucket, canonicalJson, renderCoverage } = e;

type Spec = import('../solution/spec.ts').Spec;
type Case = import('../solution/eval-set.ts').Case;
const exampleSpec = await readFile(new URL('../example/spec.md', import.meta.url), 'utf8');
const exampleCases = await readFile(new URL('../data/review.jsonl', import.meta.url), 'utf8');

/** 一个最小的、没有问题的需求说明 */
const spec = (over: Partial<Spec> = {}): Spec => ({
  name: 'demo',
  pitch: '一句话',
  users: [{ who: '某人', pain: '某事' }],
  tasks: [
    { id: 'answer', description: '回答问题', example: '例子' },
    { id: 'cite', description: '给出处', example: '例子' },
  ],
  nonGoals: ['不做闲聊'],
  criteria: [{ id: 'acc', metric: '准确率', direction: 'at-least', target: 0.8, how: '在评估集上用事实评分器跑 3 次取平均' }],
  budget: { costPerTask: 0.1, p95Seconds: 60 },
  risks: [],
  ...over,
});
const kase = (id: string, over: Partial<Case> = {}): Case => ({ id, task: 'answer', input: { q: id }, expected: { facts: ['x'] }, tags: [], ...over });

describe('第 51 天：读出需求说明（已经写好）', () => {
  test('示例项目的需求说明能读出来，没有问题', () => {
    const parsed = extractSpec(exampleSpec);
    expect(parsed.name).toBe('review-bot');
    expect(parsed.tasks.map((t) => t.id)).toEqual(['review', 'summary']);
    expect(checkSpec(parsed)).toEqual([]);
    expect(describeCriterion(parsed.criteria[0])).toBe('问题召回率 ≥ 70%');
    expect(describeCriterion(parsed.criteria[2])).toBe('反面用例的评论数 ≤ 0 条');
  });

  test('没有代码块、JSON 坏了、字段不对：错误信息说清楚是哪一种', () => {
    expect(() => extractSpec('# 只有标题')).toThrow('没有找到 ```json 代码块');
    expect(() => extractSpec('```json\n{ name: 1 }\n```')).toThrow('不是合法的 JSON');
    expect(() => extractSpec(`\`\`\`json\n${JSON.stringify({ ...spec(), nonGoals: [] })}\n\`\`\``)).toThrow('nonGoals');
    expect(() => extractSpec(`\`\`\`json\n${JSON.stringify({ ...spec(), tasks: [{ id: 'Answer', description: 'x', example: 'y' }] })}\n\`\`\``)).toThrow('tasks.0.id');
  });
});

describe('第 51 天：检查需求说明（TODO 1）', () => {
  test('写得具体的需求说明没有问题', () => {
    expect(checkSpec(spec())).toEqual([]);
  });

  test('编号重复、引用不存在的任务：error', () => {
    const bad = spec({
      tasks: [...spec().tasks, { id: 'answer', description: '又一个', example: '例子' }],
      criteria: [
        { id: 'acc', metric: '准确率', direction: 'at-least', target: 0.8, how: '评分器', tasks: ['answer', 'translate'] },
        { id: 'acc', metric: '引用率', direction: 'at-least', target: 0.9, how: '评分器', tasks: ['cite'] },
      ],
    });
    expect(checkSpec(bad)).toEqual([
      { level: 'error', message: '任务编号重复：answer' },
      { level: 'error', message: '成功标准编号重复：acc' },
      { level: 'error', message: '成功标准 acc 引用了不存在的任务：translate' },
    ]);
  });

  test('量不出来的词：warn，按 VAGUE_WORDS 的顺序列出', () => {
    const vague = spec({ criteria: [{ id: 'ux', metric: '回答更好、更快', direction: 'at-least', target: 0.9, how: '尽量让用户满意，回答更好' }] });
    expect(checkSpec(vague)).toEqual([{ level: 'warn', message: '成功标准 ux 用了量不出来的词：更好、更快、尽量、满意' }]);
  });

  test('目标值不合理：% 要在 0–100；没写单位的「率」要在 0–1', () => {
    const bad = spec({
      criteria: [
        { id: 'a', metric: '召回率', direction: 'at-least', target: 120, unit: '%', how: '评分器' },
        { id: 'b', metric: '准确率', direction: 'at-least', target: 80, how: '评分器' },
        { id: 'c', metric: '平均延迟', direction: 'at-most', target: 30, unit: '秒', how: '计时' },
      ],
    });
    expect(checkSpec(bad)).toEqual([
      { level: 'error', message: '成功标准 a 的目标值 120 不在 0–100 之间' },
      { level: 'error', message: '成功标准 b 的目标值 80 不在 0–1 之间（比率写成小数，或者把 unit 写成 %）' },
    ]);
  });

  test('没有成功标准的任务：warn；不写 tasks 的标准覆盖所有任务', () => {
    const partial = spec({ criteria: [{ id: 'acc', metric: '准确率', direction: 'at-least', target: 0.8, how: '评分器', tasks: ['answer'] }] });
    expect(checkSpec(partial)).toEqual([{ level: 'warn', message: '任务 cite 没有成功标准' }]);
  });
});

describe('第 51 天：评估集的格式（已经写好）', () => {
  test('parseCases：注释和空行跳过，错误带行号', () => {
    const cases = parseCases(exampleCases);
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.find((c) => c.id === 'sql-injection')!.expected.issues).toEqual([{ file: 'src/routes/search.ts', line: 7, kind: 'security', keywords: ['注入', 'SQL', '参数化'] }]);
    expect(() => parseCases('// 注释\n\n{"id":"a","task":"t","input":1}\nnot json')).toThrow('第 4 行不是合法的 JSON');
    expect(() => parseCases('{"id":"A","task":"t","input":1}')).toThrow('第 1 行：id');
    expect(() => parseCases('{"id":"a","task":"t"}')).toThrow('第 1 行：input');
  });

  test('canonicalJson：键的顺序不影响', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
  });
});

describe('第 51 天：评估集的覆盖（TODO 2）', () => {
  const full = () => [
    ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => kase(id)),
    ...['c1', 'c2', 'c3', 'c4'].map((id) => kase(id, { task: 'cite' })),
    kase('edge-1', { tags: ['edge'] }),
    kase('neg-1', { tags: ['negative'], task: 'cite' }),
    kase('safe-1', { tags: ['safety', 'negative'] }),
  ];

  test('够了就没有问题；perTask、perTag 数对了', () => {
    const coverage = checkCoverage(spec(), full());
    expect(coverage.problems).toEqual([]);
    expect(coverage.ok).toBe(true);
    expect(coverage.perTask).toEqual({ answer: 7, cite: 5 });
    expect(coverage.perTag).toEqual({ edge: 1, negative: 2, safety: 1 });
  });

  test('按顺序报出所有问题；只有 error 才不 ok', () => {
    const cases = [
      kase('a1'),
      kase('a1', { input: { q: 'other' } }),
      kase('x1', { task: 'translate' }),
      kase('a2', { input: { q: 'a1' } }),
      kase('a3', { expected: {} }),
    ];
    const coverage = checkCoverage(spec(), cases, { minPerTask: 3 });
    expect(coverage.problems).toEqual([
      { level: 'error', message: '用例编号重复：a1' },
      { level: 'error', message: '用例 x1 的任务 translate 不在需求说明里' },
      { level: 'warn', message: '任务 cite 只有 0 条用例，至少要 3 条' },
      { level: 'warn', message: '没有边界用例（edge）：空输入、超长输入、格式奇怪的输入' },
      { level: 'warn', message: '没有反面用例（negative）：什么都不该做、应该拒绝或者说不知道的情况' },
      { level: 'warn', message: '没有安全用例（safety）：输入里夹带指令、越权、诱导泄露' },
      { level: 'warn', message: '用例 a2 和 a1 的输入一样' },
      { level: 'warn', message: '用例 a3 还没有写期望，检查不出任何东西' },
    ]);
    expect(coverage.ok).toBe(false);
    expect(coverage.perTask).toEqual({ answer: 4, cite: 0 });
    expect(checkCoverage(spec(), cases.slice(3)).ok, '只有 warn 也算 ok').toBe(true);
  });

  test('示例项目的评估集没有问题；报告列出每个任务', () => {
    const parsed = extractSpec(exampleSpec);
    const coverage = checkCoverage(parsed, parseCases(exampleCases));
    expect(coverage.problems).toEqual([]);
    const report = renderCoverage(parsed, coverage);
    expect(report).toContain('| review | 14 |');
    expect(report).toContain('✅ 没有发现问题');
  });
});

describe('第 51 天：开发集和测试集（TODO 3）', () => {
  test('按编号的哈希分：大约 30% 进测试集；加了新用例，旧的待在原来那边', () => {
    const cases = Array.from({ length: 400 }, (_, i) => kase(`case-${i}`));
    const { dev, test: held } = splitCases(cases);
    expect(dev.length + held.length).toBe(400);
    expect(held.length / 400).toBeGreaterThan(0.24);
    expect(held.length / 400).toBeLessThan(0.36);
    expect(held.every((c) => caseBucket(c.id) < 30)).toBe(true);
    expect(dev.map((c) => c.id), '保持原来的顺序').toEqual(cases.filter((c) => caseBucket(c.id) >= 30).map((c) => c.id));
    const more = splitCases([...cases, ...Array.from({ length: 100 }, (_, i) => kase(`new-${i}`))]);
    expect(more.test.filter((c) => c.id.startsWith('case-')).map((c) => c.id)).toEqual(held.map((c) => c.id));
    expect(splitCases(cases, { testPercent: 0 }).test).toEqual([]);
  });

  test('caseBucket：0–99，同一个编号永远一样', () => {
    expect(caseBucket('sql-injection')).toBe(caseBucket('sql-injection'));
    const buckets = Array.from({ length: 50 }, (_, i) => caseBucket(`x${i}`));
    expect(buckets.every((b) => Number.isInteger(b) && b >= 0 && b < 100)).toBe(true);
  });
});
