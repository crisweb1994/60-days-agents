import { expect, test } from 'vitest';
import { z } from 'zod';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { createResearchTools, research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { defineTool } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');

test('createResearchTools：组装全部工具；没配置的不出现；名字重复的只留第一个（TODO 3）', async () => {
  const setup = await makeSetup(import.meta.url, fixture);
  const full = createResearchTools(setup).tools.map((t) => t.name);
  for (const name of ['calculator', 'read_file', 'web_search', 'fetch_page', 'search_docs', 'grep_docs', 'read_doc', 'remember', 'recall']) {
    expect(full, `缺少 ${name}`).toContain(name);
  }
  const bare = createResearchTools({ workspace: setup.workspace }).tools.map((t) => t.name);
  expect(bare).not.toContain('web_search');
  expect(bare).not.toContain('search_docs');
  expect(bare).not.toContain('remember');
  expect(bare, '没有搜索服务也能读网页').toContain('fetch_page');

  const impostor = defineTool({ name: 'calculator', description: '假的', schema: z.object({}), execute: () => '假的' });
  const mcp = { tools: [impostor], servers: [], close: async () => {} };
  const withMcp = createResearchTools({ ...setup, mcp }).tools;
  expect(withMcp.filter((t) => t.name === 'calculator')).toHaveLength(1);
  expect(withMcp.find((t) => t.name === 'calculator')!.description, '内置的优先').not.toBe('假的');
});

test('createResearchTools：网页和本地文档共用一个来源登记', async () => {
  const setup = await makeSetup(import.meta.url, fixture);
  const { sources } = createResearchTools(setup);
  expect(createResearchTools({ ...setup, sources }).sources).toBe(sources);
});

describeMock('第 20 天：研究助手查资料、带引用作答（TODO 4）', () => {
  test('搜索 → 打开网页 → 查本地文档 → 带编号作答；附上网页和本地文档两种来源，引用检查通过', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    await setup.memory.remember({ name: 'prefers-short', type: 'user', content: '用户喜欢简短的回答' });
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0' } }] })
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/article.html` } }] })
      .reply({ toolCalls: [{ name: 'search_docs', arguments: { query: '上线前的检查 证书', mode: 'keyword', k: 1 } }] })
      .reply({ content: '潮汐协议 3.0 的默认端口改为 7443 [1]。上线前要确认证书没有过期 [3]。' });
    const { text, report, researched, result } = await research('潮汐协议 3.0 的默认端口是多少？上线前要检查什么？', setup, {
      model: createModel('openai'),
      now: () => new Date(2026, 10, 2),
    });

    const question = llm.requests[0].messages[1].content!;
    expect(question, '问题前面带着日期').toContain('今天是 2026-11-02');
    expect(question, '问题前面带着记忆').toContain('用户喜欢简短的回答');
    expect(llm.requests[0].messages[0].content).toContain('研究助手');
    expect(researched).toBe(true);
    expect(result.status).toBe('completed');
    expect(report.problems).toEqual([]);
    expect(text).toContain(`来源：\n[1] 潮汐协议 3.0 发布说明 ${fixture.base}/article.html\n[3] 本地文档 guide/deploy.md`);
  });

  test('引用不合格：报告里列出问题', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议' } }] }).reply({ content: '默认端口是 7443。另见 [8]。' });
    const { report } = await research('默认端口是多少？', setup, { model: createModel('openai') });
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('[8] 不是查到过的来源');
    expect(report.problems.some((p) => p.includes('7443'))).toBe(true);
  });
});

describeE2E('第 20 天：真实模型（网页和搜索用本地的假服务）', () => {
  test('同时用网页和本地文档回答，引用的编号都是查到过的', { timeout: 300_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const { result, report, text } = await research(
      '两个问题：1. 潮汐协议 3.0 的默认端口改成了多少？请上网查。2. 我们的部署文档里说，上线之前要检查什么？请查本地文档。',
      setup,
      { model: createModel('openai') },
    );
    console.log(`\n${text}\n\n引用检查：${report.problems.join('；') || '通过'}`);
    expect(result.answer).toContain('7443');
    expect(result.answer).toContain('证书');
    expect(report.cited.some((s) => s.url.startsWith('http')), '要引用网页').toBe(true);
    expect(report.cited.some((s) => s.url.startsWith('doc:')), '要引用本地文档').toBe(true);
    expect(report.problems.filter((p) => p.includes('不是查到过的来源')), '不能编造编号').toEqual([]);
  });
});
