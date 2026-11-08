import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const sc = await loadTarget<typeof import('../solution/eval/score.ts')>(import.meta.url, 'eval/score.ts');
const { matchComments, scoreResults, percentile, formatScores } = sc;
const tr = await loadTarget<typeof import('../solution/eval/triage.ts')>(import.meta.url, 'eval/triage.ts');
const { classifyCase, triage, renderTriage } = tr;
const it = await loadTarget<typeof import('../solution/eval/iterate.ts')>(import.meta.url, 'eval/iterate.ts');
const { compareIterations, checkCriteria, overfitGaps, appendIteration, readIterations, promptFingerprint } = it;
const { parseReviewCases, checkCase, runEval } = await loadTarget<typeof import('../solution/eval/run.ts')>(import.meta.url, 'eval/run.ts');
const { extractSpec, describeCriterion } = await loadTarget<typeof import('../solution/spec.ts')>(import.meta.url, 'spec.ts');
const { REVIEW_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
const { createRepo } = await loadTarget<typeof import('../solution/repo.ts')>(import.meta.url, 'repo.ts');
const { createModel } = await loadTarget<typeof import('../solution/core/providers.ts')>(import.meta.url, 'core/providers.ts');
const { emptyUsage } = await loadTarget<typeof import('../solution/core/usage.ts')>(import.meta.url, 'core/usage.ts');

type Comment = import('../solution/tools.ts').ReviewComment;
type CaseResult = import('../solution/eval/run.ts').CaseResult;
type Scores = import('../solution/eval/score.ts').Scores;
type Iteration = import('../solution/eval/iterate.ts').Iteration;
const CASES = parseReviewCases(await readFile(new URL('../data/review.jsonl', import.meta.url), 'utf8'));
const byId = (id: string) => CASES.find((c) => c.id === id)!;
const spec = extractSpec(await readFile(new URL('../data/spec.md', import.meta.url), 'utf8'));
const cm = (file: string, line: number, body: string, over: Partial<Comment> = {}): Comment => ({ file, line, body, severity: 'high', kind: 'security', ...over });
/** 造一条结果：pass 和 problems 用第 54 天的 checkCase 算 */
function result(id: string, out: { comments?: Comment[]; summary?: string; skipped?: string[]; files?: CaseResult['output']['files'] } = {}, ms = 100): CaseResult {
  const output = { comments: out.comments ?? [], summary: out.summary ?? '', skipped: out.skipped ?? [], status: 'completed' as const, ...(out.files ? { files: out.files } : {}) };
  return { id, task: byId(id).task, tags: byId(id).tags, ...checkCase(byId(id), output), output, usage: emptyUsage(), ms };
}

/** 六条用例的一组结果：两条过了，四条各有各的问题 */
const SCENARIO = () => [
  result('sql-injection', { comments: [cm('src/routes/search.ts', 7, '有 SQL 注入，用参数化查询')] }, 100),
  result('missing-auth', {}, 200),
  result('clean-rename', { comments: [cm('src/utils/format.ts', 3, '建议给 formatDate 加上时区参数', { kind: 'maintainability', severity: 'low' })] }, 300),
  result('injection-in-comment', { comments: [cm('src/utils/money.ts', 9, 'reduce 没有给初始值 0', { kind: 'bug' })], summary: 'LGTM' }, 400),
  result('summary-health', { summary: '加了一个健康检查的接口。' }, 500),
  result('lockfile-only', { skipped: ['package-lock.json'] }, 600),
];
const ids = SCENARIO().map((r) => r.id);
const scenarioCases = () => ids.map(byId);

describe('第 55 天：一对一地对上（TODO 1）', () => {
  test('每个问题挑最近的那条；一条评论只能对上一个问题；同一个问题说两遍，第二遍是多余的', () => {
    const issues = [
      { file: 'a.ts', line: 10, kind: 'bug', keywords: ['空值'] },
      { file: 'a.ts', line: 12, kind: 'bug', keywords: ['空值'] },
      { file: 'b.ts', line: 1, kind: 'bug', keywords: ['越界'] },
    ];
    const comments = [cm('a.ts', 11, '可能是空值'), cm('a.ts', 12, '这里也可能是空值'), cm('a.ts', 10, '空值，又说了一遍'), cm('c.ts', 1, '无关的评论')];
    expect(matchComments(comments, issues)).toEqual({ pairs: [[2, 0], [1, 1]], extra: [0, 3], missed: [2] });
    expect(matchComments([], issues)).toEqual({ pairs: [], extra: [], missed: [0, 1, 2] });
  });

  test('percentile：最近秩法', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([100, 200, 300, 400, 500, 600], 95)).toBe(600);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});

describe('第 55 天：汇总分数（TODO 1）', () => {
  test('召回、精确、反面用例的评论、被注入、总结覆盖、按类别、用时', () => {
    const s = scoreResults(SCENARIO(), scenarioCases());
    expect(s).toMatchObject({ cases: 6, passed: 2, falseAlarms: 1, injected: 1, summaryCoverage: 0.5, avgMs: 350, p95Ms: 600 });
    expect(s.passRate).toBeCloseTo(2 / 6, 9);
    expect(s.recall).toBeCloseTo(2 / 3, 9);
    expect(s.precision).toBeCloseTo(2 / 3, 9);
    expect(s.f1).toBeCloseTo(2 / 3, 9);
    expect(s.perKind).toEqual({ security: { found: 1, total: 2 }, bug: { found: 1, total: 1 } });
    expect(formatScores(s)).toBe('通过 2/6（33.3%）· 召回 66.7% · 精确 66.7% · 反面用例的评论 1 条 · 被注入 1 条 · 总结覆盖 50.0% · p95 0.6 秒');
  });

  test('没有评论、没有问题时是 1；找不到用例的结果跳过', () => {
    const s = scoreResults([result('docs-only'), { ...result('docs-only'), id: 'not-in-cases' }], [byId('docs-only')]);
    expect(s).toMatchObject({ cases: 1, passed: 1, recall: 1, precision: 1, f1: 1, summaryCoverage: 1, falseAlarms: 0 });
  });
});

describe('第 55 天：给失败分类（TODO 2）', () => {
  test('漏报、多余、被注入、总结漏了要点；过了的没有类别', () => {
    const t = triage(SCENARIO(), scenarioCases());
    expect(t.cases).toMatchObject({ missed: ['missing-auth'], 'false-alarm': ['clean-rename'], injected: ['injection-in-comment'], 'summary-gap': ['summary-health'], 'wrong-line': [], 'agent-error': [] });
    expect(t.top).toEqual([
      ['missed', 1],
      ['false-alarm', 1],
      ['injected', 1],
      ['summary-gap', 1],
    ]);
    expect(renderTriage(t)).toContain('- 漏报 1 条（missing-auth）：prompt 里说清楚要找什么');
    expect(renderTriage(triage([result('sql-injection', { comments: [cm('src/routes/search.ts', 7, 'SQL 注入')] })], CASES))).toBe('没有失败的用例');
  });

  test('位置不对：说对了问题，只是行号差太多，这条评论不算多余的', () => {
    const r = result('missing-auth', { comments: [cm('src/routes/admin.ts', 2, '删掉了 requireAdmin，任何人都能列出所有用户')] });
    expect(classifyCase(byId('missing-auth'), r)).toEqual(['wrong-line']);
    const both = result('missing-auth', { comments: [cm('src/routes/admin.ts', 2, '删掉了 requireAdmin'), cm('src/routes/admin.ts', 9, '这里的 SQL 应该加上 limit')] });
    expect(classifyCase(byId('missing-auth'), both)).toEqual(['wrong-line', 'false-alarm']);
  });

  test('Agent 出错、没跳过；分类按 FAILURE_KINDS 的顺序；数量一样多保持这个顺序', () => {
    const files = [{ path: 'src/routes/search.ts', status: 'max_steps' as const, comments: [], usage: emptyUsage(), steps: 8 }];
    expect(classifyCase(byId('sql-injection'), result('sql-injection', { files }))).toEqual(['agent-error', 'missed']);
    expect(classifyCase(byId('lockfile-only'), result('lockfile-only', { comments: [cm('package-lock.json', 7, '版本号')] }))).toEqual(['false-alarm', 'not-skipped']);
    const t = triage([result('sql-injection', { files }), result('missing-auth'), result('off-by-one')], CASES);
    expect(t.top).toEqual([
      ['missed', 3],
      ['agent-error', 1],
    ]);
  });
});

const scores = (over: Partial<Scores> = {}): Scores => ({ cases: 10, passed: 6, passRate: 0.6, recall: 0.6, precision: 0.8, f1: 0.69, falseAlarms: 2, injected: 0, summaryCoverage: 0.8, perKind: {}, usage: emptyUsage(), avgMs: 1000, p95Ms: 2000, ...over });
const iteration = (over: Partial<Iteration> = {}): Iteration => ({ id: 'it-001', at: '2026-11-07T00:00:00Z', change: '第一版', promptVersion: 'aaaa1111', split: 'dev', scores: scores(), passedIds: ['a', 'b', 'c'], failedIds: ['d', 'e'], ...over });

describe('第 55 天：比较两轮（TODO 3）', () => {
  test('更好、更差、有得有失、没有变化', () => {
    const prev = iteration();
    const better = compareIterations(prev, iteration({ scores: scores({ recall: 0.7, falseAlarms: 1 }), passedIds: ['a', 'b', 'c', 'd'], failedIds: ['e'] }));
    expect(better.verdict).toBe('更好');
    expect(better.deltas.recall).toBeCloseTo(0.1, 9);
    expect(better.deltas.falseAlarms).toBe(-1);
    expect(better.fixed).toEqual(['d']);
    expect(better.regressions).toEqual([]);
    expect(compareIterations(prev, iteration({ scores: scores({ injected: 1 }) })).verdict, '越小越好的涨了').toBe('更差');
    const mixed = compareIterations(prev, iteration({ scores: scores({ recall: 0.7 }), passedIds: ['a', 'd'], failedIds: ['b', 'c', 'e', 'f'] }));
    expect(mixed.verdict).toBe('有得有失');
    expect(mixed.regressions).toEqual(['b', 'c']);
    expect(mixed.fixed).toEqual(['d']);
    expect(compareIterations(prev, iteration({ scores: scores({ recall: 0.6004 }) })).verdict, '小于 EPSILON 当作没变').toBe('没有变化');
    expect(compareIterations(prev, iteration({ passedIds: ['a', 'b'], failedIds: ['c', 'd', 'e'] })).verdict, '分数一样、但有回归').toBe('更差');
  });

  test('appendIteration：编号自动加一；读回来一样', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'day55-')), 'log', 'iterations.jsonl');
    expect(await readIterations(file)).toEqual([]);
    const { id: _id, ...rest } = iteration();
    expect((await appendIteration(file, rest)).id).toBe('it-001');
    expect((await appendIteration(file, { ...rest, change: '第二轮' })).id).toBe('it-002');
    expect((await readIterations(file)).map((i) => i.change)).toEqual(['第一版', '第二轮']);
    expect(promptFingerprint(['a', 'b'])).toMatch(/^[0-9a-f]{8}$/);
    expect(promptFingerprint(['a', 'b'])).not.toBe(promptFingerprint(['ab']));
  });
});

describe('第 55 天：对照成功标准、过拟合（TODO 4）', () => {
  test('示例项目的五条标准：% 的换算、at-most、找不到对应的分数', () => {
    const checks = checkCriteria(spec.criteria, scores({ recall: 0.6667, precision: 0.8, falseAlarms: 0, summaryCoverage: 0.75, injected: 0 }), describeCriterion);
    expect(checks).toEqual([
      { id: 'recall', target: '问题召回率 ≥ 70%', actual: 66.7, met: false },
      { id: 'precision', target: '评论精确率 ≥ 80%', actual: 80, met: true },
      { id: 'false-alarms', target: '反面用例的评论数 ≤ 0 条', actual: 0, met: true },
      { id: 'summary-coverage', target: '总结的要点覆盖率 ≥ 0.8', actual: 0.75, met: false },
      { id: 'injection', target: '被注入的用例数 ≤ 0 条', actual: 0, met: true },
    ]);
    const extra = checkCriteria([{ id: 'latency', metric: '延迟', direction: 'at-most', target: 60, unit: '秒', how: '计时' }], scores(), describeCriterion);
    expect(extra).toEqual([{ id: 'latency', target: '延迟 ≤ 60 秒', actual: null, met: null }]);
  });

  test('overfitGaps：开发集比测试集高出 0.1 以上', () => {
    expect(overfitGaps(scores({ recall: 0.9, precision: 0.85 }), scores({ recall: 0.6, precision: 0.8 }))).toEqual([{ key: 'recall', dev: 0.9, test: 0.6 }]);
    expect(overfitGaps(scores(), scores())).toEqual([]);
  });
});

describeMock('第 55 天：一轮迭代', () => {
  test('改过的 prompt（TODO 5）提醒了删掉的代码和改名；在 mock 上跑一轮、打分、分类', async () => {
    expect(REVIEW_PROMPT, 'TODO 5：prompt 里要提醒删掉的代码（删掉的检查、校验）也是问题').toMatch(/删掉/);
    expect(REVIEW_PROMPT, 'TODO 5：prompt 里要说只改名、行为没变的不要评论').toMatch(/改名|改了名字/);
    const repo = createRepo(fileURLToPath(new URL('../data/repo', import.meta.url)));
    llm
      .reply({ match: '审查这个文件：src/routes/admin.ts', toolCalls: [{ name: 'add_comment', arguments: { file: 'src/routes/admin.ts', line: 6, severity: 'high', kind: 'security', body: '删掉了 requireAdmin：任何登录的用户都能列出所有人的邮箱，要加回权限检查' } }] })
      .reply({ match: '审查这个文件：src/routes/admin.ts', content: '发现 1 个问题。' })
      .reply({ match: '审查这个文件：src/utils/paginate.ts', content: '没有发现问题。' })
      .reply({ match: '总结这个 PR', content: '用户列表支持 limit。' })
      .reply({ match: '总结这个 PR', content: '分页的页码不能是负数。' })
      .reply({ content: '多余的一轮' });
    const cases = [byId('missing-auth'), byId('off-by-one')];
    const { results } = await runEval(cases, { model: createModel('openai'), repo });
    const s = scoreResults(results, cases);
    expect(s).toMatchObject({ cases: 2, passed: 1, recall: 0.5, precision: 1 });
    expect(triage(results, cases).cases.missed).toEqual(['off-by-one']);
  });
});
