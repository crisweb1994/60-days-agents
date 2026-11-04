import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { API_KEY, startFixture } from './fixtures.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { createTavilySearch } = await loadTarget<typeof import('../solution/search.ts')>(import.meta.url, 'search.ts');
const { createSourceRegistry, createWebTools, formatReferences, RESEARCH_PROMPT } = await loadTarget<
  typeof import('../solution/web.ts')
>(import.meta.url, 'web.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

const search = () => createTavilySearch({ apiKey: API_KEY, baseURL: `${fixture.base}/tavily` });
function setup() {
  const sources = createSourceRegistry();
  const tools = createWebTools({ search: search(), sources, fetchOptions: { allowPrivate: true } });
  return { sources, tools };
}

describeMock('第 12 天：研究助手查资料、带引用作答', () => {
  test('搜索 → 打开网页 → 带编号作答，附上来源', async () => {
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0' } }] })
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/article.html` } }] })
      .reply({ content: '潮汐协议 3.0 把握手减少到了 1 次 [1]。' });
    const { sources, tools } = setup();
    const result = await runAgent('潮汐协议 3.0 有什么变化？', { model: createModel('openai'), tools, system: RESEARCH_PROMPT });

    expect(result.status).toBe('completed');
    expect(llm.requests[0].messages[0], '用研究助手的 system prompt').toMatchObject({ role: 'system', content: RESEARCH_PROMPT });
    const fetched = llm.requests[2].messages.at(-1)!;
    expect(fetched.role).toBe('tool');
    expect(fetched.content).toContain('网页内容开始');
    const { text } = formatReferences(result.answer, sources);
    expect(text).toContain(`[1] 潮汐协议 3.0 发布说明 ${fixture.base}/article.html`);
  });

  test('命令行：回答后面列出引用的来源，/sources 列出所有来源', async () => {
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议' } }] })
      .reply({ content: '潮汐协议 3.0 在 2026 年 3 月发布 [1]，另见 [7]。' });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (data) => (text += data));
    input.end('潮汐协议什么时候发布的？\n/sources\n/exit\n');
    const workspace = await mkdtemp(join(tmpdir(), 'day12-cli-'));
    await runCLI({ input, output, workspace, provider: 'openai', search: search() });

    expect(text).toContain('搜索 tavily');
    expect(text).toContain(`来源：\n[1] 潮汐协议 3.0 发布说明 ${fixture.base}/article.html`);
    expect(text, '编号对不上的要提醒').toContain('[7] 不是查到过的来源');
    expect(text).toContain(`[2] 很长的文章 ${fixture.base}/long.html`);
  });
});

describeE2E('第 12 天：真实模型（搜索和网页用本地的假服务）', () => {
  test('查到只有网页里才有的信息，并标明来源', async () => {
    const { sources, tools } = setup();
    const result = await runAgent('潮汐协议 3.0 的默认端口改成了多少？请查资料后回答。', {
      model: createModel('openai'),
      tools,
      system: RESEARCH_PROMPT,
    });
    expect(result.answer).toContain('7443');
    expect(formatReferences(result.answer, sources).cited.length, '回答里要用 [编号] 标明来源').toBeGreaterThan(0);
  });
});
