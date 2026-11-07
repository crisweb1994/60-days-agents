import { describe, expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';
import { API_KEY, startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const v = await loadTarget<typeof import('../solution/verify.ts')>(import.meta.url, 'verify.ts');
const { extractClaims, numbersIn, containsNumber, missingNumbers, parseVerdict, judgeClaim, verifyCitations, formatVerification, JUDGE_PROMPT } = v;
const { createSourceRegistry, createWebTools } = await loadTarget<typeof import('../solution/web.ts')>(import.meta.url, 'web.ts');
const { createTavilySearch } = await loadTarget<typeof import('../solution/search.ts')>(import.meta.url, 'search.ts');
const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const RELEASE = '潮汐协议 3.0 于 2026 年 3 月 14 日发布，最大的变化是把握手从 3 次减少到 1 次。默认端口改为 7443。';
const BENCH = '建立连接的平均延迟：3.0 是 18 毫秒，2.x 是 42 毫秒。单机吞吐量：3.0 是 2.x 的 1.8 倍。';

function registry() {
  const sources = createSourceRegistry();
  sources.add('https://tide.example/release', '发布说明', RELEASE);
  sources.add('https://tide.example/bench', '性能测试', BENCH);
  sources.add('https://tide.example/empty', '只有标题');
  return sources;
}

describe('第 24 天：来源登记保存读到的内容', () => {
  test('读到一段记一段；已经记过的不重复记', () => {
    const sources = createSourceRegistry();
    sources.add('https://a.example/x', 'A', '摘要');
    sources.add('https://a.example/x#part', '', '正文第一段');
    sources.add('https://a.example/x', 'A', '正文第一段');
    expect(sources.get(1)!.content).toBe('摘要\n\n正文第一段');
    expect(sources.add('https://b.example', 'B').content).toBeUndefined();
  });

  test('web_search 记下摘要，fetch_page 记下正文', async () => {
    const sources = createSourceRegistry();
    const tools = createWebTools({ search: createTavilySearch({ apiKey: API_KEY, baseURL: `${fixture.base}/tavily` }), sources, fetchOptions: { allowPrivate: true } });
    const call = (name: string, args: object) => ({ id: 'c', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
    await runToolCall(tools, call('web_search', { query: '潮汐' }));
    expect(sources.get(1)!.content).toBe('潮汐协议 3.0 于 2026 年 3 月发布……');
    await runToolCall(tools, call('fetch_page', { url: `${fixture.base}/article.html` }));
    expect(sources.get(1)!.content).toContain('默认端口改为 7443');
  });
});

describe('第 24 天：客观校验数字（TODO 1）', () => {
  test('extractClaims：只要带引用的句子', () => {
    expect(extractClaims('握手减少到 1 次 [1]。这很好。延迟是 18 毫秒 [2][1]。')).toEqual([
      { sentence: '握手减少到 1 次 [1]。', ids: [1] },
      { sentence: '延迟是 18 毫秒 [2][1]。', ids: [2, 1] },
    ]);
  });

  test('numbersIn：去掉引用编号，留下句子里的数字', () => {
    expect(numbersIn('3.0 的延迟是 18 毫秒，吞吐量是 1.8 倍 [2]。')).toEqual(['3.0', '18', '1.8']);
    expect(numbersIn('没有数字 [1, 2]。')).toEqual([]);
  });

  test('containsNumber：要是一个完整的数', () => {
    expect(containsNumber('延迟是 18 毫秒', '18')).toBe(true);
    expect(containsNumber('2018 年', '18')).toBe(false);
    expect(containsNumber('18.5 毫秒', '18')).toBe(false);
    expect(containsNumber('是 2.x 的 1.8 倍。', '1.8')).toBe(true);
    expect(containsNumber('第 3 次。', '3')).toBe(true);
    expect(containsNumber('3.0 版', '3')).toBe(false);
  });

  test('missingNumbers：句子里有、来源里没有的数字', () => {
    const sources = registry();
    const claim = { sentence: '3.0 的延迟是 18 毫秒，2.x 是 45 毫秒 [2]。', ids: [2] };
    expect(missingNumbers(claim, [sources.get(2)!])).toEqual(['45']);
    expect(missingNumbers({ sentence: '默认端口是 7443 [1]。', ids: [1] }, [sources.get(1)!])).toEqual([]);
  });
});

describe('第 24 天：模型评审，再校验评审（TODO 2）', () => {
  test('parseVerdict', () => {
    expect(parseVerdict('{"verdict": "partial", "quote": "原文", "reason": "只说了一半"}')).toEqual({ verdict: 'partial', quote: '原文', reason: '只说了一半' });
    expect(parseVerdict('```json\n{"verdict": "unsupported"}\n```')).toEqual({ verdict: 'unsupported', quote: '', reason: '' });
    expect(parseVerdict('{"verdict": "yes"}')).toBeUndefined();
    expect(parseVerdict('支持')).toBeUndefined();
  });
});

describeMock('第 24 天：模型评审，再校验评审（TODO 2）', () => {
  const claim = { sentence: '3.0 的最大变化是握手减少了 [1]。', ids: [1] };

  test('评审给出支撑的原文，原文确实在来源里（忽略空白）：supported', async () => {
    // 模型复制原文时常常丢掉或者多出空格，比较时忽略空白
    llm.reply({ content: '{"verdict": "supported", "quote": "最大的变化是把握手从3次减少到1次", "reason": "原文写了"}' });
    const { check } = await judgeClaim(claim, [registry().get(1)!], createModel('openai'));
    expect(check).toEqual({ claim, verdict: 'supported', reason: '原文写了', quote: '最大的变化是把握手从3次减少到1次', method: 'judge' });
    expect(llm.requests[0].messages[0].content).toBe(JUDGE_PROMPT);
    const prompt = llm.requests[0].messages[1].content!;
    expect(prompt).toContain('要核查的句子：3.0 的最大变化是握手减少了 [1]。');
    expect(prompt).toContain(`[1] 发布说明\n${RELEASE}`);
  });

  test('评审说支撑，但原文是编的，或者没给原文：改判 unsupported', async () => {
    llm.reply({ content: '{"verdict": "supported", "quote": "握手只需要一次就够了", "reason": "对"}' }).reply({ content: '{"verdict": "partial", "quote": "", "reason": "差不多"}' });
    const fake = await judgeClaim(claim, [registry().get(1)!], createModel('openai'));
    expect(fake.check).toMatchObject({ verdict: 'unsupported', reason: '评审给的原文在来源里找不到：「握手只需要一次就够了」' });
    const empty = await judgeClaim(claim, [registry().get(1)!], createModel('openai'));
    expect(empty.check).toMatchObject({ verdict: 'unsupported', reason: '评审说有来源支撑，但没有给出原文' });
  });

  test('评审说 unsupported 不用给原文；输出解析不了：unverifiable', async () => {
    llm.reply({ content: '{"verdict": "unsupported", "quote": "", "reason": "来源里没有"}' }).reply({ content: '我觉得是对的' });
    expect((await judgeClaim(claim, [registry().get(1)!], createModel('openai'))).check).toMatchObject({ verdict: 'unsupported', reason: '来源里没有' });
    expect((await judgeClaim(claim, [registry().get(1)!], createModel('openai'))).check).toMatchObject({ verdict: 'unverifiable', method: 'judge' });
  });
});

describeMock('第 24 天：核查整个回答（TODO 3）', () => {
  // 两句同时核查，请求到达的顺序不固定，用 match 把评审的回复对上句子
  test('数字对不上的直接判 unsupported，不问模型；没有内容的来源没法核查；其余的同时交给评审', async () => {
    llm
      .reply({ content: '{"verdict": "supported", "quote": "默认端口改为 7443", "reason": "对"}', match: '要核查的句子：默认端口', delayMs: 200 })
      .reply({ content: '{"verdict": "partial", "quote": "握手从 3 次减少到 1 次", "reason": "原文没说是唯一的变化"}', match: '要核查的句子：握手减少', delayMs: 200 });
    const answer = '默认端口是 7443 [1]。延迟只有 15 毫秒 [2]。握手减少是唯一的变化 [1]。它很受欢迎 [3]。没有引用的句子。';
    const start = performance.now();
    const report = await verifyCitations(answer, registry(), { model: createModel('openai') });
    expect(performance.now() - start, '要评审的两句同时核查（一句一句要 400 毫秒）').toBeLessThan(330);
    expect(llm.requests, '数字对不上、没法核查的，都不用问模型').toHaveLength(2);
    expect(report.checks.map((c) => [c.verdict, c.method])).toEqual([
      ['supported', 'judge'],
      ['unsupported', 'numbers'],
      ['partial', 'judge'],
      ['unverifiable', 'none'],
    ]);
    expect(report.checks[1].reason).toBe('来源里没有这些数字：15');
    expect(report.problems.map((c) => c.claim.sentence)).toEqual(['延迟只有 15 毫秒 [2]。', '握手减少是唯一的变化 [1]。']);
    expect(report.ok).toBe(false);
    expect(report.usage.inputTokens, '评审的用量要算上').toBeGreaterThan(0);
  });

  test('评审出错：这一句记成没法核查，不影响其他句', async () => {
    llm.fail({ status: 400, message: '请求有问题' });
    const report = await verifyCitations('默认端口是 7443 [1]。', registry(), { model: createModel('openai') });
    expect(report.checks[0]).toMatchObject({ verdict: 'unverifiable', method: 'none' });
    expect(report.checks[0].reason).toContain('核查出错');
    expect(report.ok, '没法核查的不算问题').toBe(true);
  });
});

test('formatVerification：一句一行，最后是统计', () => {
  const claim = (sentence: string) => ({ sentence, ids: [1] });
  const text = formatVerification({
    checks: [
      { claim: claim('甲 [1]。'), verdict: 'supported', reason: '对', method: 'judge' },
      { claim: claim('乙 [1]。'), verdict: 'unsupported', reason: '来源里没有这些数字：15', method: 'numbers' },
      { claim: claim('丙 [1]。'), verdict: 'unverifiable', reason: '引用的来源没有可以对照的内容', method: 'none' },
    ],
    problems: [],
    ok: false,
    usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  });
  expect(text).toBe('✓ 甲 [1]。\n✗ 乙 [1]。（来源里没有这些数字：15）\n? 丙 [1]。（引用的来源没有可以对照的内容）\n核查了 3 句，1 句有来源支撑');
});
