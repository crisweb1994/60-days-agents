import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const g = await loadTarget<typeof import('../solution/eval/graders.ts')>(import.meta.url, 'eval/graders.ts');
const { factsGrader, citationGrader, trajectoryGrader, isSubsequence, parseRubricVerdict, rubricGrader, QUALITY_RUBRIC, RUBRIC_PROMPT, comparePair, parseWinner, agreementWith, gradeRun, summarizeScores, repeatability, parseLabels, calibrate } = g;
const { parseDataset } = await loadTarget<typeof import('../solution/eval/dataset.ts')>(import.meta.url, 'eval/dataset.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

type EvalCase = import('../solution/eval/dataset.ts').EvalCase;
type TargetOutput = import('../solution/eval/run.ts').TargetOutput;
type ScoredRun = import('../solution/eval/graders.ts').ScoredRun;

const zero = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
const output = (answer: string, extra: Partial<TargetOutput> = {}): TargetOutput => ({ answer, usage: zero, toolCalls: [], cited: [], citationProblems: [], status: 'completed', ...extra });
const makeCase = (id: string, expected: Partial<EvalCase['expected']>, tags: string[] = []): EvalCase =>
  ({ id, question: `问题 ${id}`, tags, expected: { facts: [], forbidden: [], sources: [], tools: [], unanswerable: false, ...expected } }) as EvalCase;
const call = (name: string, args: unknown = {}) => ({ name, arguments: args });
const rubricReply = (scores: number[], reason = '理由') => JSON.stringify({ scores: Object.fromEntries(QUALITY_RUBRIC.map((c, i) => [c.name, scores[i]])), reason });

const cases = parseDataset(await readFile(new URL('../data/eval/research.jsonl', import.meta.url), 'utf8'));
const labels = parseLabels(await readFile(new URL('../data/eval/judge-labels.jsonl', import.meta.url), 'utf8'));

describe('第 32 天：代码评分器（TODO 1、2）', () => {
  test('facts：分数是通过的比例', () => {
    const c = makeCase('a', { facts: ['18', '42'], forbidden: ['15'] });
    expect(factsGrader.grade(c, output('18 和 42'))).toEqual({ grader: 'facts', value: 1, pass: true, reason: '全部通过' });
    expect(factsGrader.grade(c, output('18 和 15'))).toEqual({ grader: 'facts', value: 1 / 3, pass: false, reason: '缺少 42；出现了 15' });
  });

  test('isSubsequence：按顺序出现，中间可以夹着别的', () => {
    expect(isSubsequence(['web_search', 'fetch_page'], ['web_search', 'calculator', 'fetch_page'])).toBe(true);
    expect(isSubsequence(['web_search', 'fetch_page'], ['fetch_page', 'web_search'])).toBe(false);
    expect(isSubsequence([], ['web_search'])).toBe(true);
  });

  test('trajectory：该调用的调用了、顺序对、没超次数、没有一模一样的重复', () => {
    const c = makeCase('a', { tools: ['web_search', 'fetch_page'], maxToolCalls: 3 });
    const good = output('', { toolCalls: [call('web_search', { query: '延迟' }), call('fetch_page', { url: 'u' })] });
    expect(trajectoryGrader.grade(c, good)).toMatchObject({ value: 1, pass: true });
    const bad = output('', { toolCalls: [call('fetch_page', { url: 'u' }), call('web_search', { query: '延迟' }), call('web_search', { query: '延迟' }), call('calculator')] });
    const score = trajectoryGrader.grade(c, bad) as import('../solution/eval/graders.ts').Score;
    expect(score.pass).toBe(false);
    expect(score.reason).toBe('调用的顺序不对：应该是 web_search → fetch_page；调用了 4 次工具，最多 3 次；重复调用：web_search');
    expect(score.value).toBeCloseTo(2 / 5);
  });

  test('trajectory：闲聊不该调用工具；没有轨迹上的期望就算通过', () => {
    expect(trajectoryGrader.grade(makeCase('chat', { maxToolCalls: 0 }), output('你好', { toolCalls: [call('web_search')] }))).toMatchObject({ pass: false, reason: '调用了 1 次工具，最多 0 次' });
    expect(trajectoryGrader.grade(makeCase('x', { facts: ['1'] }), output('1'))).toEqual({ grader: 'trajectory', value: 1, pass: true, reason: '没有轨迹上的期望' });
  });

  test('citations：引用了该引用的、格式没有问题；资料里没有答案就不该引用来源', () => {
    const c = makeCase('a', { sources: ['/benchmark.html', '/migration.html'] });
    expect(citationGrader.grade(c, output('', { cited: ['http://x/benchmark.html', 'http://x/migration.html'] }))).toMatchObject({ value: 1, pass: true });
    const bad = citationGrader.grade(c, output('', { cited: ['http://x/benchmark.html'], citationProblems: ['[9] 不是查到过的来源'] }));
    expect(bad).toMatchObject({ pass: false, reason: '没有引用 /migration.html；引用格式有问题：[9] 不是查到过的来源' });
    expect((bad as { value: number }).value).toBeCloseTo(1 / 3);
    const unknown = makeCase('v4', { unanswerable: true });
    expect(citationGrader.grade(unknown, output('没有查到', { cited: ['http://x/article.html'] }))).toMatchObject({ pass: false, reason: '资料里没有答案，却引用了来源' });
    expect(citationGrader.grade(unknown, output('没有查到'))).toMatchObject({ pass: true });
    expect(citationGrader.grade(makeCase('chat', { maxToolCalls: 0 }), output('你好'))).toEqual({ grader: 'citations', value: 1, pass: true, reason: '没有引用上的期望' });
  });
});

describe('第 32 天：解析评审的输出（TODO 3）', () => {
  test('parseRubricVerdict：每条细则都要有 1 到 5 的整数分', () => {
    expect(parseRubricVerdict('```json\n' + rubricReply([5, 4, 3, 2], '简洁扣分') + '\n```', QUALITY_RUBRIC)).toEqual({ scores: { 切题: 5, 准确: 4, 诚实: 3, 简洁: 2 }, reason: '简洁扣分' });
    expect(parseRubricVerdict(rubricReply([5, 4, 3, 6]), QUALITY_RUBRIC), '超出范围').toBeUndefined();
    expect(parseRubricVerdict(rubricReply([5, 4, 3, 2.5]), QUALITY_RUBRIC), '不是整数').toBeUndefined();
    expect(parseRubricVerdict(JSON.stringify({ scores: { 切题: 5, 准确: 5, 诚实: 5 } }), QUALITY_RUBRIC), '少一条').toBeUndefined();
    expect(parseRubricVerdict(JSON.stringify({ scores: { 切题: 5, 准确: 5, 诚实: 5, 简洁: 5, 文采: 5 } }), QUALITY_RUBRIC), '多出不认识的').toBeUndefined();
    expect(parseRubricVerdict('我觉得不错', QUALITY_RUBRIC)).toBeUndefined();
  });

  test('parseWinner', () => {
    expect(parseWinner('{"winner": "A", "reason": "准确"}')).toBe('a');
    expect(parseWinner('{"winner": "tie"}')).toBe('tie');
    expect(parseWinner('{"winner": "C"}')).toBeUndefined();
  });
});

describeMock('第 32 天：模型评审（TODO 3、4）', () => {
  test('rubricGrader：把参考答案和细则交给评审，平均分换算成 0 到 1', async () => {
    llm.reply({ content: rubricReply([5, 5, 4, 2], '有客套话'), usage: { prompt_tokens: 300, completion_tokens: 40 } });
    const grader = rubricGrader({ model: createModel('openai') });
    const score = await grader.grade(makeCase('a', { facts: ['18', ['42', '四十二']] }), output('好的！3.0 是 18 毫秒，2.x 是 42 毫秒。'));
    const request = llm.requests[0];
    expect(request.messages[0].content).toBe(RUBRIC_PROMPT);
    expect(request.messages[1].content).toContain('参考答案：必须有这些事实：18；42 或 四十二');
    expect(request.messages[1].content).toContain('- 准确：');
    expect(request.temperature, '评审要尽量稳定').toBe(0);
    expect(score.value).toBeCloseTo((1 + 1 + 0.75 + 0.25) / 4);
    expect(score.pass, '平均 0.75 才算通过').toBe(true);
    expect(score.reason).toBe('切题 5，准确 5，诚实 4，简洁 2。有客套话');
    expect(score.usage?.inputTokens).toBe(300);
  });

  test('rubricGrader：资料里没有答案的用例，参考答案是「应该说没查到」；解析不了算 0 分', async () => {
    llm.reply({ content: '这个回答挺好的' });
    const score = await rubricGrader({ model: createModel('openai') }).grade(makeCase('v4', { unanswerable: true }), output('4.0 在 2027 年发布'));
    expect(llm.requests[0].messages[1].content).toContain('好的回答应该明确说没有查到');
    expect(score).toMatchObject({ value: 0, pass: false, reason: '评审的输出解析不了' });
  });

  test('comparePair：交换位置再比一次，两次一致才算数', async () => {
    const c = makeCase('a', { facts: ['18'] });
    // 第一次 A 是好的回答；第二次交换以后 B 是好的回答
    llm.reply({ content: '{"winner": "A"}', match: '回答 A：\n18 毫秒' }).reply({ content: '{"winner": "B"}', match: '回答 A：\n15 毫秒' });
    const result = await comparePair(c, '18 毫秒', '15 毫秒', createModel('openai'));
    expect(result.winner).toBe('a');
    expect(result.votes).toEqual(['a', 'a']);
    expect(llm.requests).toHaveLength(2);

    // 位置偏差：两次都说排在前面的赢，换算回来不一致，就是平局
    llm.reply({ content: '{"winner": "A"}', match: '回答 A：\n18 毫秒' }).reply({ content: '{"winner": "A"}', match: '回答 A：\n15 毫秒' });
    const biased = await comparePair(c, '18 毫秒', '15 毫秒', createModel('openai'));
    expect(biased).toMatchObject({ winner: 'tie', votes: ['a', 'b'] });
  });

  test('calibrate：用人工标注检查评审，找出判断不一致的', async () => {
    const few = labels.filter((l) => l.id === 'web-latency');
    llm.reply({ content: rubricReply([5, 5, 5, 5]), match: '要评的回答：\n3.0 建立连接' }).reply({ content: rubricReply([5, 4, 4, 5]), match: '要评的回答：\n3.0 的延迟大约是 15' });
    const result = await calibrate(rubricGrader({ model: createModel('openai') }), few, cases);
    expect(result).toMatchObject({ total: 2, agreement: 0.5, confusion: { bothPass: 1, judgeOnly: 1, humanOnly: 0, bothFail: 0 } });
    expect(result.disagreements.map((d) => d.label.note), '评审给编了数字的回答放水了').toEqual(['数字是编的']);
  });
});

describe('第 32 天：校准和方差（TODO 5、6）', () => {
  test('agreementWith：一致率和 kappa', () => {
    const perfect = agreementWith([true, false, true, false], [true, false, true, false]);
    expect(perfect).toMatchObject({ agreement: 1, kappa: 1 });
    // 人：好好好差；评审：好好好好。一致率 75%，但评审只是一律说好，kappa 是 0
    const lazy = agreementWith([true, true, true, true], [true, true, true, false]);
    expect(lazy.agreement).toBe(0.75);
    expect(lazy.kappa).toBeCloseTo(0);
    expect(lazy.confusion).toEqual({ bothPass: 3, judgeOnly: 1, humanOnly: 0, bothFail: 0 });
    const some = agreementWith([true, true, false, false, true], [true, false, false, false, true]);
    // 实际一致 0.8；pj = 0.6，ph = 0.4；碰巧一致 0.6×0.4 + 0.4×0.6 = 0.48；kappa = (0.8 - 0.48) / 0.52
    expect(some.kappa).toBeCloseTo(0.32 / 0.52);
    expect(() => agreementWith([true], [true, false])).toThrow();
  });

  test('gradeRun：每条用例用每个评分器打分；出错的记 0 分', async () => {
    const cs = [makeCase('a', { facts: ['18'] }, ['web']), makeCase('b', { facts: ['3'] }, ['docs'])];
    const scored = await gradeRun(
      { name: 'x', startedAt: 't', results: [{ id: 'a', question: '', tags: ['web'], output: output('18'), ms: 1 }, { id: 'b', question: '', tags: ['docs'], error: '超时', ms: 1 }] },
      cs,
      [factsGrader, trajectoryGrader],
    );
    expect(scored.cases[0].scores.map((s) => [s.grader, s.pass])).toEqual([['facts', true], ['trajectory', true]]);
    expect(scored.cases[1]).toMatchObject({ id: 'b', error: '超时' });
    expect(scored.cases[1].scores).toEqual([
      { grader: 'facts', value: 0, pass: false, reason: '出错：超时' },
      { grader: 'trajectory', value: 0, pass: false, reason: '出错：超时' },
    ]);
    expect(summarizeScores(scored)).toEqual([
      { grader: 'facts', mean: 0.5, passRate: 0.5 },
      { grader: 'trajectory', mean: 0.5, passRate: 0.5 },
    ]);
    expect(summarizeScores(scored, 'web')[0]).toEqual({ grader: 'facts', mean: 1, passRate: 1 });
  });

  test('repeatability：每遍的通过率、标准差，时对时错的用例', () => {
    const runOf = (passes: Record<string, boolean>): ScoredRun => ({
      name: 'x',
      startedAt: '',
      gradingUsage: zero,
      cases: Object.entries(passes).map(([id, pass]) => ({ id, tags: [], scores: [{ grader: 'facts', value: pass ? 1 : 0, pass, reason: '' }] })),
    });
    const r = repeatability(
      [runOf({ a: true, b: true, c: false, d: false }), runOf({ a: true, b: false, c: false, d: true }), runOf({ a: true, b: true, c: false, d: false })],
      'facts',
    );
    expect(r.passRates).toEqual([0.5, 0.5, 0.5]);
    expect(r.stddev).toBe(0);
    expect(r.stable).toEqual(['a']);
    expect(r.failing).toEqual(['c']);
    expect(r.flaky, '按通过的次数从少到多').toEqual([{ id: 'd', passed: 1 }, { id: 'b', passed: 2 }]);
    const varied = repeatability([runOf({ a: true, b: true }), runOf({ a: false, b: false })], 'facts');
    expect(varied.mean).toBe(0.5);
    expect(varied.stddev).toBe(0.5);
  });

  test('人工标注：每条都对得上评估集里的用例，有好有坏', () => {
    expect(labels.length).toBeGreaterThanOrEqual(10);
    for (const label of labels) expect(cases.some((c) => c.id === label.id), `${label.id} 不在评估集里`).toBe(true);
    expect(labels.filter((l) => l.human).length).toBe(labels.filter((l) => !l.human).length);
  });
});

describeE2E('第 32 天：用真实模型做评审，并和人工标注校准', () => {
  test('评分细则评审和人的判断大体一致', { timeout: 300_000 }, async () => {
    const result = await calibrate(rubricGrader({ model: createModel('openai') }), labels, cases);
    console.log(`一致率 ${Math.round(result.agreement * 100)}%，kappa ${result.kappa.toFixed(2)}`, result.confusion);
    for (const d of result.disagreements) console.log(`- ${d.label.id}（人：${d.label.human ? '好' : '差'}）${d.label.note ?? ''}：${d.score.reason}`);
    expect(result.agreement, '一致率太低，先看看不一致的那几条，再改评分细则').toBeGreaterThanOrEqual(0.75);
  });

  test('两两比较：事实对的回答赢过编了数字的', { timeout: 120_000 }, async () => {
    const c = cases.find((x) => x.id === 'web-latency')!;
    const [good, bad] = labels.filter((l) => l.id === 'web-latency');
    const result = await comparePair(c, bad.answer, good.answer, createModel('openai'));
    console.log(result);
    expect(result.winner).toBe('b');
  });
});
