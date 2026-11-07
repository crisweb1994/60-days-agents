import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const ds = await loadTarget<typeof import('../solution/eval/dataset.ts')>(import.meta.url, 'eval/dataset.ts');
const run = await loadTarget<typeof import('../solution/eval/run.ts')>(import.meta.url, 'eval/run.ts');
const { parseDataset, validateDataset, selectCases, countByTag, DatasetError } = ds;
const { runEval, checkExpectations, summarizeRun, formatRunSummary, researchTarget, toolCallsOf } = run;
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

type EvalCase = import('../solution/eval/dataset.ts').EvalCase;
type TargetOutput = import('../solution/eval/run.ts').TargetOutput;

const DATASET = new URL('../data/eval/research.jsonl', import.meta.url);
const zero = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
const output = (answer: string, extra: Partial<TargetOutput> = {}): TargetOutput => ({ answer, usage: zero, toolCalls: [], cited: [], citationProblems: [], status: 'completed', ...extra });
const makeCase = (id: string, expected: Partial<EvalCase['expected']>, tags: string[] = []): EvalCase =>
  ({ id, question: `问题 ${id}`, tags, expected: { facts: [], forbidden: [], sources: [], tools: [], unanswerable: false, ...expected } }) as EvalCase;

describe('第 31 天：读评估集（TODO 1、2）', () => {
  test('parseDataset：跳过空行和注释，补上默认值', () => {
    const cases = parseDataset('// 注释\n\n{"id": "a-1", "question": "问题", "expected": {"facts": ["18"]}}\n');
    expect(cases).toEqual([{ id: 'a-1', question: '问题', tags: [], expected: { facts: ['18'], forbidden: [], sources: [], tools: [], unanswerable: false } }]);
  });

  test('parseDataset：把所有问题都找出来，带着行号一起报', () => {
    const text = ['{"id": "ok", "question": "问题", "expected": {"facts": ["1"]}}', '{不是 json', '', '{"id": "Bad Id", "question": ""}'].join('\n');
    let error: unknown;
    try {
      parseDataset(text);
    } catch (e) {
      error = e;
    }
    expect(error, '有问题要抛出 DatasetError').toBeInstanceOf(DatasetError);
    const problems = (error as InstanceType<typeof DatasetError>).problems;
    expect(problems, '两行有问题，两条都要报，不能遇到第一个就停').toHaveLength(2);
    expect(problems[0]).toContain('第 2 行');
    expect(problems[1]).toContain('第 4 行');
    expect(problems[1]).toContain('id');
  });

  test('validateDataset：id 重复、没有期望、unanswerable 又写了 facts', () => {
    const cases = [makeCase('a', { facts: ['1'] }), makeCase('a', { facts: ['2'] }), makeCase('b', {}), makeCase('c', { unanswerable: true, facts: ['3'] })];
    expect(validateDataset(cases)).toEqual(['id 重复：a', 'b：没有任何可以检查的期望', 'c：标了 unanswerable，就不该有 facts']);
    expect(validateDataset([makeCase('d', { maxToolCalls: 0 })]), 'maxToolCalls: 0 也是一种期望').toEqual([]);
  });

  test('selectCases 和 countByTag', () => {
    const cases = [makeCase('a', { facts: ['1'] }, ['web']), makeCase('b', { facts: ['1'] }, ['docs']), makeCase('c', { facts: ['1'] }, ['web', 'calc'])];
    expect(selectCases(cases, { tags: ['web'] }).map((c) => c.id)).toEqual(['a', 'c']);
    expect(selectCases(cases, { ids: ['b', 'c'], limit: 1 }).map((c) => c.id)).toEqual(['b']);
    expect(countByTag(cases)).toEqual([['web', 2], ['calc', 1], ['docs', 1]]);
  });

  test('课程自带的评估集：至少 20 条，格式和期望都没有问题，覆盖几类问题', async () => {
    const cases = parseDataset(await readFile(DATASET, 'utf8'));
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(validateDataset(cases)).toEqual([]);
    const tags = new Map(countByTag(cases));
    for (const tag of ['web', 'docs', 'multi-hop', 'unanswerable']) expect(tags.get(tag), `应该有 ${tag} 类的用例`).toBeGreaterThan(0);
  });
});

describe('第 31 天：检查期望（TODO 3）', () => {
  test('事实、禁止内容、来源都对上才通过', () => {
    const c = makeCase('a', { facts: ['18', ['42', '四十二']], forbidden: ['15'], sources: ['/benchmark.html'] });
    const good = output('3.0 是 18 毫秒，2.x 是 42 毫秒 [1]。', { cited: ['http://x/benchmark.html'] });
    expect(checkExpectations(c, good)).toEqual({ pass: true, missing: [], forbidden: [], missingSources: [], admitsUnknown: true });
    const bad = output('3.0 是 15 毫秒，比 18 快。', { cited: ['http://x/article.html'] });
    expect(checkExpectations(c, bad)).toMatchObject({ pass: false, missing: ['42/四十二'], forbidden: ['15'], missingSources: ['/benchmark.html'] });
  });

  test('资料里没有答案的用例：说了没查到才通过', () => {
    const c = makeCase('v4', { unanswerable: true });
    expect(checkExpectations(c, output('没有查到 4.0 的发布时间。')).pass).toBe(true);
    expect(checkExpectations(c, output('4.0 预计在 2027 年发布。'))).toMatchObject({ pass: false, admitsUnknown: false });
  });

  test('出错了（没有 output）：不通过，事实全部算缺少', () => {
    expect(checkExpectations(makeCase('a', { facts: ['18', '42'] }), undefined)).toMatchObject({ pass: false, missing: ['18', '42'] });
  });
});

describe('第 31 天：跑评估和汇总（TODO 4、5）', () => {
  test('runEval：在并发上限内同时跑；出错记下来，不中断；结果按用例的顺序', async () => {
    const cases = ['a', 'b', 'c', 'd'].map((id) => makeCase(id, { facts: ['好'] }));
    let running = 0;
    let peak = 0;
    const progress: string[] = [];
    const result = await runEval(
      cases,
      async (c) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, c.id === 'a' ? 30 : 5));
        running--;
        if (c.id === 'c') throw new Error('模型超时');
        return output('好');
      },
      { name: 'baseline', concurrency: 2, now: () => new Date('2026-11-07T08:00:00Z'), onResult: (r, done, total) => progress.push(`${done}/${total} ${r.id}`) },
    );
    expect(peak, '同时最多 concurrency 条').toBe(2);
    expect(result.name).toBe('baseline');
    expect(result.startedAt).toBe('2026-11-07T08:00:00.000Z');
    expect(result.results.map((r) => r.id), '按用例的顺序，不按完成的先后').toEqual(['a', 'b', 'c', 'd']);
    expect(result.results[2]).toMatchObject({ id: 'c', error: '模型超时' });
    expect(result.results[2].output).toBeUndefined();
    expect(progress).toHaveLength(4);
    expect(progress.at(-1)).toMatch(/^4\/4 /);
  });

  test('runEval：ms 是这条用例开始和结束时 clock() 之差', async () => {
    let t = 0;
    const result = await runEval([makeCase('a', { facts: ['好'] }), makeCase('b', { facts: ['好'] })], async () => output('好'), { concurrency: 1, clock: () => (t += 100) });
    expect(result.results.map((r) => r.ms)).toEqual([100, 100]);
  });

  test('summarizeRun：整体和每个标签的通过率，没通过的原因，用量合计', () => {
    const cases = [makeCase('a', { facts: ['18'] }, ['web']), makeCase('b', { facts: ['3'] }, ['docs']), makeCase('c', { unanswerable: true }, ['web', 'unanswerable'])];
    const usage = { inputTokens: 100, cachedTokens: 0, outputTokens: 10, reasoningTokens: 0 };
    const summary = summarizeRun(
      {
        name: 'x',
        startedAt: '',
        results: [
          { id: 'a', question: '', tags: ['web'], output: output('18 毫秒', { usage }), ms: 1000 },
          { id: 'b', question: '', tags: ['docs'], error: '429', ms: 3000 },
          { id: 'c', question: '', tags: ['web', 'unanswerable'], output: output('4.0 在 2027 年发布', { usage }), ms: 2000 },
        ],
      },
      cases,
    );
    expect(summary.overall).toEqual({ group: 'all', total: 3, passed: 1, errors: 1, passRate: 1 / 3 });
    expect(summary.byTag.map((g) => [g.group, g.total, g.passed])).toEqual([['web', 2, 1], ['docs', 1, 0], ['unanswerable', 1, 0]]);
    expect(summary.failures).toEqual([
      { id: 'b', reasons: ['出错：429'] },
      { id: 'c', reasons: ['资料里没有答案，但回答没有说没查到'] },
    ]);
    expect(summary.usage.inputTokens).toBe(200);
    expect(summary.medianMs).toBe(2000);
    expect(formatRunSummary(summary)).toContain('| all | 3 | 1 | 33% | 1 |');
  });

  test('toolCallsOf：按顺序找出工具调用，参数解析成对象', () => {
    const calls = toolCallsOf([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'web_search', arguments: '{"query":"潮汐"}' } }] },
      { role: 'tool', tool_call_id: '1', content: '结果' },
      { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'read_doc', arguments: '不是 json' } }] },
    ]);
    expect(calls).toEqual([
      { name: 'web_search', arguments: { query: '潮汐' } },
      { name: 'read_doc', arguments: '不是 json' },
    ]);
  });
});

describeMock('第 31 天：用研究助手跑评估', () => {
  test('researchTarget：每条用例一套新的配置，交回回答、工具调用和引用的网址', async () => {
    const cases = parseDataset(await readFile(DATASET, 'utf8'));
    const latency = selectCases(cases, { ids: ['web-latency'] });
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 延迟' } }] })
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/benchmark.html` } }] })
      .reply({ content: '3.0 的平均延迟是 18 毫秒，2.x 是 42 毫秒 [1]。', usage: { prompt_tokens: 500, completion_tokens: 30 } })
      .reply({ content: '不该用到这一轮' });
    const result = await runEval(latency, researchTarget(() => makeSetup(import.meta.url, fixture), createModel('openai')));
    const out = result.results[0].output!;
    expect(result.results[0].error).toBeUndefined();
    expect(out.toolCalls.map((c) => c.name)).toEqual(['web_search', 'fetch_page']);
    expect(out.cited).toEqual([`${fixture.base}/benchmark.html`]);
    expect(out.usage.inputTokens).toBeGreaterThanOrEqual(500);
    expect(summarizeRun(result, cases).overall.passRate).toBe(1);
  });
});

describeE2E('第 31 天：用真实模型跑一部分评估集', () => {
  test('每类挑几条跑一遍，打印汇总', { timeout: 900_000 }, async () => {
    const cases = parseDataset(await readFile(DATASET, 'utf8'));
    const picked = ['web', 'docs', 'multi-hop', 'unanswerable'].flatMap((tag) => selectCases(cases, { tags: [tag], limit: 2 }));
    const unique = [...new Map(picked.map((c) => [c.id, c])).values()];
    const result = await runEval(unique, researchTarget(() => makeSetup(import.meta.url, fixture), createModel('openai')), {
      onResult: (r, done, total) => console.log(`[${done}/${total}] ${r.id}`),
    });
    const summary = summarizeRun(result, cases);
    console.log(`\n${formatRunSummary(summary)}`);
    expect(summary.overall.errors, '不应该有用例跑出错').toBe(0);
    expect(summary.overall.passRate, '一半以上应该通过；不到一半，先看看没通过的原因').toBeGreaterThanOrEqual(0.5);
  });
});
