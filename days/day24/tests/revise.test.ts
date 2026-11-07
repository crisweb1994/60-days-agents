import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { reviseUntilSupported, describeProblems, verifyCitations, formatVerification, REVISE_PROMPT } = await loadTarget<typeof import('../solution/verify.ts')>(
  import.meta.url,
  'verify.ts',
);
const { createSourceRegistry } = await loadTarget<typeof import('../solution/web.ts')>(import.meta.url, 'web.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const BENCH = '建立连接的平均延迟：3.0 是 18 毫秒，2.x 是 42 毫秒。单机吞吐量：3.0 是 2.x 的 1.8 倍。';
function registry() {
  const sources = createSourceRegistry();
  sources.add('https://tide.example/release', '发布说明', '潮汐协议 3.0 于 2026 年 3 月 14 日发布。');
  sources.add('https://tide.example/bench', '性能测试', BENCH);
  return sources;
}
const supported = (quote: string) => ({ content: JSON.stringify({ verdict: 'supported', quote, reason: '原文写了' }) });

describeMock('第 24 天：生成 → 核查 → 修改（TODO 4）', () => {
  test('核查发现问题，交回模型修改，再核查：没有问题了就停下', async () => {
    const sources = registry();
    llm.reply({ content: '3.0 的延迟是 18 毫秒 [2]。' }).reply(supported('3.0 是 18 毫秒'));
    const result = await reviseUntilSupported('3.0 的延迟是多少？', '3.0 的延迟只有 15 毫秒 [2]。', sources, { model: createModel('openai') });
    expect(result).toMatchObject({ answer: '3.0 的延迟是 18 毫秒 [2]。', rounds: 1, stopped: 'verified' });
    expect(result.reports.map((r) => r.problems.length)).toEqual([1, 0]);
    const revise = llm.requests[0].messages;
    expect(revise[0].content).toBe(REVISE_PROMPT);
    expect(revise[1].content).toBe(describeProblems('3.0 的延迟是多少？', '3.0 的延迟只有 15 毫秒 [2]。', result.reports[0], sources));
    expect(revise[1].content, '修改时要看到问题和来源').toContain('来源里没有这些数字：15');
    expect(revise[1].content).toContain(BENCH);
  });

  test('一开始就没有问题：不用改', async () => {
    llm.reply(supported('3.0 是 18 毫秒'));
    const result = await reviseUntilSupported('问题', '延迟是 18 毫秒 [2]。', registry(), { model: createModel('openai') });
    expect(result).toMatchObject({ rounds: 0, stopped: 'verified' });
    expect(llm.requests).toHaveLength(1);
  });

  test('改了以后问题没有变少：停下，返回改之前的那一版', async () => {
    llm.reply({ content: '3.0 的延迟只有 16 毫秒 [2]。' }).reply({ content: '不该用到这一轮' });
    const result = await reviseUntilSupported('问题', '3.0 的延迟只有 15 毫秒 [2]。', registry(), { model: createModel('openai') });
    expect(result).toMatchObject({ answer: '3.0 的延迟只有 15 毫秒 [2]。', rounds: 1, stopped: 'no_improvement' });
  });

  test('轮数用完：停下，返回问题最少的那一版', async () => {
    llm.reply({ content: '延迟只有 15 毫秒 [2]。吞吐量是 1.8 倍 [2]。' }).reply(supported('3.0 是 2.x 的 1.8 倍')).reply({ content: '不该用到这一轮' });
    const result = await reviseUntilSupported('问题', '延迟只有 15 毫秒 [2]。吞吐量是 3 倍 [2]。', registry(), { model: createModel('openai'), maxRounds: 1 });
    expect(result).toMatchObject({ answer: '延迟只有 15 毫秒 [2]。吞吐量是 1.8 倍 [2]。', rounds: 1, stopped: 'max_rounds' });
    expect(result.reports.map((r) => r.problems.length)).toEqual([2, 1]);
  });

  test('核查可以用另一个（更便宜的）模型', async () => {
    const { createOpenAIModel } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');
    const judge = createOpenAIModel({ baseURL: llm.baseURL, apiKey: 'mock-key', model: 'judge-model' });
    llm.reply({ content: '延迟是 18 毫秒 [2]。' }).reply(supported('3.0 是 18 毫秒'));
    await reviseUntilSupported('问题', '延迟是 15 毫秒 [2]。', registry(), { model: createModel('openai'), judge });
    expect(llm.requests.map((r) => r.model)).toEqual(['mock-model', 'judge-model']);
  });
});

describeMock('第 24 天：研究助手回答以后核查', () => {
  test('research({ verify })：数字不对，改正以后再附上来源', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 性能' } }] })
      .reply({ content: '3.0 的平均延迟是 15 毫秒 [1]。' })
      .reply({ content: '3.0 的平均延迟是 18 毫秒 [1]。' })
      .reply(supported('3.0 的平均延迟是 18 毫秒'));
    const result = await research('3.0 快了多少？', setup, { model: createModel('openai'), verify: {} });
    expect(result.result.answer, 'Agent 原来的回答').toBe('3.0 的平均延迟是 15 毫秒 [1]。');
    expect(result.answer).toBe('3.0 的平均延迟是 18 毫秒 [1]。');
    expect(result.verification?.stopped).toBe('verified');
    expect(result.text).toBe('3.0 的平均延迟是 18 毫秒 [1]。\n\n来源：\n[1] 潮汐协议 3.0 性能测试报告 ' + `${fixture.base}/benchmark.html`);
  });

  test('没有查资料的回答不核查；没有要求核查也不核查', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '你好！' });
    expect((await research('你好', setup, { model: createModel('openai'), verify: {} })).verification).toBeUndefined();
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐' } }] }).reply({ content: '发布了 [1]。' });
    expect((await research('潮汐', setup, { model: createModel('openai') })).verification).toBeUndefined();
    expect(llm.pending).toBe(0);
  });

  test('命令行的 /verify：核查上一个回答，一句一行显示结果', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0' } }] })
      .reply({ content: '潮汐协议 3.0 于 2026 年 3 月发布 [1]。' })
      .reply(supported('潮汐协议 3.0 于 2026 年 3 月发布'));
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (data) => (text += data));
    input.end(['潮汐协议 3.0 什么时候发布？', '/verify', '/exit'].map((l) => `${l}\n`).join(''));
    await runCLI({ input, output, workspace: setup.workspace, provider: 'openai', search: setup.search });
    expect(text).toContain('✓ 潮汐协议 3.0 于 2026 年 3 月发布 [1]。\n核查了 1 句，1 句有来源支撑');
  });
});

describeE2E('第 24 天：真实模型核查引用', () => {
  test('一个故意写错的回答：核查能发现，修改以后数字对了', { timeout: 300_000 }, async () => {
    const sources = registry();
    const wrong = '潮汐协议 3.0 于 2026 年 5 月发布 [1]。3.0 建立连接的平均延迟是 18 毫秒，是 2.x 的一半 [2]。';
    const report = await verifyCitations(wrong, sources, { model: createModel('openai') });
    console.log(`\n${formatVerification(report)}`);
    expect(report.problems.length, '两句都有问题：5 月不对；42 的一半不是 18').toBeGreaterThanOrEqual(1);
    const result = await reviseUntilSupported('潮汐协议 3.0 什么时候发布？快了多少？', wrong, sources, { model: createModel('openai') });
    console.log(`\n${result.answer}\n（${result.stopped}，改了 ${result.rounds} 轮）`);
    expect(result.answer).not.toContain('5 月');
  });
});
