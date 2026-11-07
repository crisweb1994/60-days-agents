import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const r = await loadTarget<typeof import('../solution/eval/regression.ts')>(import.meta.url, 'eval/regression.ts');
const { datasetVersion, compareRecords, gate, formatComparison, percentile, bakeoff, formatBakeoff, saveRecord, loadRecord } = r;
const { evaluate, check, mustPassIds } = await loadTarget<typeof import('../solution/eval/ci.ts')>(import.meta.url, 'eval/ci.ts');
const { parseDataset, selectCases } = await loadTarget<typeof import('../solution/eval/dataset.ts')>(import.meta.url, 'eval/dataset.ts');
const { factsGrader, trajectoryGrader } = await loadTarget<typeof import('../solution/eval/graders.ts')>(import.meta.url, 'eval/graders.ts');
const { researchTarget } = await loadTarget<typeof import('../solution/eval/run.ts')>(import.meta.url, 'eval/run.ts');
const { createModel, createAltModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

type EvalRecord = import('../solution/eval/regression.ts').EvalRecord;

const DATASET_TEXT = await readFile(new URL('../data/eval/research.jsonl', import.meta.url), 'utf8');
const usage = (input: number, output = 0) => ({ inputTokens: input, cachedTokens: 0, outputTokens: output, reasoningTokens: 0 });

/** 造一条记录：passes 是每条用例在 facts 上过没过；quality 可选 */
function record(name: string, passes: Record<string, boolean>, extra: { version?: string; model?: string; tokens?: number; ms?: number[]; quality?: Record<string, boolean> } = {}): EvalRecord {
  const ids = Object.keys(passes);
  return {
    name,
    startedAt: '2026-11-07T00:00:00.000Z',
    model: extra.model ?? 'openai:a',
    datasetVersion: extra.version ?? 'v1',
    results: ids.map((id, i) => ({ id, question: id, tags: [], output: { answer: '', usage: usage(extra.tokens ?? 1000, 100), toolCalls: [], cited: [], citationProblems: [], status: 'completed' }, ms: extra.ms?.[i] ?? 1000 })),
    scores: ids.map((id) => ({
      id,
      tags: [],
      scores: [
        { grader: 'facts', value: passes[id] ? 1 : 0, pass: passes[id], reason: '' },
        ...(extra.quality ? [{ grader: 'quality', value: extra.quality[id] ? 1 : 0, pass: extra.quality[id], reason: '' }] : []),
      ],
    })),
  };
}

describe('第 33 天：评估集的版本（TODO 1）', () => {
  test('改注释、调空行不换版本；改了一个字就换', () => {
    const v = datasetVersion(DATASET_TEXT);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(datasetVersion(`// 新加的注释\n\n${DATASET_TEXT}\n\n`)).toBe(v);
    expect(datasetVersion(DATASET_TEXT.replace('平均延迟分别是多少', '平均延迟各是多少'))).not.toBe(v);
  });
});

describe('第 33 天：回归对比（TODO 2）', () => {
  test('每个评分器的通过率、回归和修好的用例', () => {
    const base = record('main', { a: true, b: true, c: false, d: true }, { quality: { a: true, b: true, c: true, d: false } });
    const cand = record('pr-12', { a: true, b: false, c: true, d: false }, { quality: { a: true, b: true, c: true, d: true } });
    const c = compareRecords(base, cand);
    expect(c.shared).toBe(4);
    expect(c.datasetChanged).toBe(false);
    expect(c.graders).toEqual([
      { grader: 'facts', baseline: 0.75, candidate: 0.5, delta: -0.25, regressions: ['b', 'd'], fixes: ['c'] },
      { grader: 'quality', baseline: 0.75, candidate: 1, delta: 0.25, regressions: [], fixes: ['d'] },
    ]);
  });

  test('评估集变了：只比两边都有的用例，列出新加的和删掉的', () => {
    const base = record('main', { a: true, b: true, old: true }, { version: 'v1' });
    const cand = record('pr', { a: true, b: false, fresh: false }, { version: 'v2' });
    const c = compareRecords(base, cand);
    expect(c).toMatchObject({ datasetChanged: true, shared: 2, added: ['fresh'], removed: ['old'] });
    expect(c.graders[0]).toMatchObject({ baseline: 1, candidate: 0.5, regressions: ['b'] });
  });

  test('成本和耗时：只算共同的用例，按各自的单价', () => {
    const base = record('main', { a: true, b: true }, { tokens: 1000, ms: [1000, 3000] });
    const cand = record('pr', { a: true, b: true }, { tokens: 500, ms: [500, 700] });
    const c = compareRecords(base, cand, { baseline: { input: 2, output: 8 }, candidate: { input: 1, output: 4 } });
    // 每条 1000 输入 + 100 输出：(1000×2 + 100×8) / 1e6 = 0.0028 元
    expect(c.cost.baseline.costPerCase).toBeCloseTo(0.0028);
    expect(c.cost.candidate.costPerCase).toBeCloseTo((500 * 1 + 100 * 4) / 1e6);
    expect(c.cost.baseline.medianMs).toBe(2000);
    expect(c.cost.candidate.medianMs).toBe(600);
    expect(c.cost.baseline.usage.inputTokens).toBe(2000);
  });
});

describe('第 33 天：门禁（TODO 3）', () => {
  const base = record('main', { a: true, b: true, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: true });

  test('通过率掉得不多、没有必须通过的回归：通过', () => {
    const cand = record('pr', { a: true, b: true, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: false });
    expect(gate(compareRecords(base, cand), { maxDrop: { default: 0.1 } })).toEqual({ ok: true, reasons: [] });
  });

  test('把所有不满足的都列出来', () => {
    const cand = record('pr', { a: false, b: false, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: true }, { tokens: 2000 });
    const comparison = compareRecords(base, cand, { baseline: { input: 1, output: 1 }, candidate: { input: 1, output: 1 } });
    const result = gate(comparison, { maxDrop: { default: 0.05 }, maxRegressions: 1, mustPass: ['b', 'c'], maxCostIncrease: 0.2 });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      'facts 的通过率下降了 20 个百分点（允许 5）',
      'facts 有 2 条回归（允许 1）：a、b',
      '必须通过的 b 回归了（facts）',
      // 每条从 1100 tokens 变成 2100 tokens
      '平均每条的花费上涨了 91%（允许 20%）',
    ]);
  });

  test('默认允许掉 5 个百分点；可以按评分器单独放宽', () => {
    const cand = record('pr', { a: false, b: true, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: true });
    expect(gate(compareRecords(base, cand)).reasons).toEqual(['facts 的通过率下降了 10 个百分点（允许 5）']);
    expect(gate(compareRecords(base, cand), { maxDrop: { facts: 0.1 } }).ok, '正好掉 10 个百分点、允许 10，算通过').toBe(true);
  });
});

describe('第 33 天：报告和横评', () => {
  test('formatComparison：门禁结果、对比表、回归的用例', () => {
    const base = record('main', { a: true, b: true }, { model: 'openai:a' });
    const cand = record('pr-12', { a: true, b: false, fresh: true }, { model: 'openai:b', version: 'v2' });
    const comparison = compareRecords(base, cand);
    const text = formatComparison(comparison, gate(comparison));
    expect(text).toContain('❌ 门禁没有通过');
    expect(text).toContain('基线 **main**（openai:a） → 本次 **pr-12**（openai:b），共同的用例 2 条');
    expect(text).toContain('⚠️ 评估集变了');
    expect(text).toContain('新加的用例：fresh');
    expect(text).toContain('| facts | 100% | 50% | -50 个百分点 | 1 | 0 |');
    expect(text).toContain('### 回归\n- facts：b');
  });

  test('percentile：最近秩法', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 90)).toBe(0);
  });

  test('bakeoff：每个模型一行，花费按各自的单价', () => {
    const rows = bakeoff([record('x', { a: true, b: false }, { model: 'openai:a', ms: [1000, 9000] }), record('y', { a: true, b: true }, { model: 'openai:b' })], {
      'openai:a': { input: 2, output: 8 },
    });
    expect(rows[0]).toMatchObject({ model: 'openai:a', passRates: { facts: 0.5 }, medianMs: 5000, p90Ms: 9000, errors: 0 });
    expect(rows[0].costPerCase).toBeCloseTo(0.0028);
    expect(rows[1].costPerCase).toBeUndefined();
    expect(formatBakeoff(rows)).toContain('| openai:b | 100% | — | 1.0 秒 | 1.0 秒 | 0 |');
  });

  test('mustPassIds：带 must-pass 标签的用例', () => {
    const cases = parseDataset('{"id": "a", "question": "q", "tags": ["must-pass"], "expected": {"facts": ["1"]}}\n{"id": "b", "question": "q", "expected": {"facts": ["1"]}}');
    expect(mustPassIds(cases)).toEqual(['a']);
  });

  test('saveRecord 和 loadRecord', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'day33-'));
    const file = join(dir, 'evals', 'baseline.json');
    const rec = record('main', { a: true });
    await saveRecord(file, rec);
    expect(await loadRecord(file)).toEqual(rec);
  });
});

describeMock('第 33 天：跑一遍、打分、和基线比较', () => {
  test('evaluate 生成带版本的记录；check 和基线比较，必须通过的用例回归了就不通过', async () => {
    const cases = selectCases(parseDataset(DATASET_TEXT), { ids: ['docs-retries-default'] });
    const model = createModel('openai');
    const target = researchTarget(() => makeSetup(import.meta.url, fixture), model);
    llm.reply({ toolCalls: [{ name: 'grep_docs', arguments: { pattern: 'handshake.retries' } }] }).reply({ content: '默认重试 3 次 [1]。' });
    const baseline = await evaluate(cases, target, { name: 'main', model, datasetText: DATASET_TEXT, graders: [factsGrader, trajectoryGrader] });
    expect(baseline).toMatchObject({ name: 'main', model: 'openai:mock-model', datasetVersion: datasetVersion(DATASET_TEXT) });
    expect(baseline.scores[0].scores.map((s) => s.pass)).toEqual([true, true]);

    llm.reply({ content: '默认重试 5 次。' });
    const candidate = await evaluate(cases, target, { name: 'pr', model, datasetText: DATASET_TEXT, graders: [factsGrader, trajectoryGrader] });
    const { result, markdown } = check(baseline, candidate, { policy: { maxDrop: { default: 1 } }, mustPass: ['docs-retries-default'] });
    expect(result.reasons).toEqual(['必须通过的 docs-retries-default 回归了（facts）']);
    expect(markdown).toContain('### 回归\n- facts：docs-retries-default');
  });
});

describeE2E('第 33 天：横评两个模型', () => {
  test('同一组用例，主模型和第二家模型（或者便宜的模型）', { timeout: 1_800_000 }, async () => {
    const cases = selectCases(parseDataset(DATASET_TEXT), { tags: ['docs'], limit: 4 });
    const { createCheapModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
    const models = [createModel('openai'), createAltModel() ?? createCheapModel()];
    const records = [];
    for (const model of models) {
      records.push(await evaluate(cases, researchTarget(() => makeSetup(import.meta.url, fixture), model), { name: model.name, model, datasetText: DATASET_TEXT, graders: [factsGrader, trajectoryGrader] }));
    }
    console.log(`\n${formatBakeoff(bakeoff(records))}`);
    if (records[0].model !== records[1].model) console.log(`\n${formatComparison(compareRecords(records[0], records[1]))}`);
    for (const rec of records) expect(rec.results.filter((x) => x.error), `${rec.model} 不应该有用例跑出错`).toEqual([]);
  });
});
