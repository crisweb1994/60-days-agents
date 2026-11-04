import { PassThrough } from 'node:stream';
import { expect } from 'vitest';
import { test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

async function runWith(lines: string[]) {
  const setup = await makeSetup(import.meta.url, fixture);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (data) => (text += data));
  input.end(lines.map((line) => `${line}\n`).join(''));
  await runCLI({ input, output, workspace: setup.workspace, provider: 'openai', search: setup.search, docs: setup.docs });
  return text;
}

describeMock('第 20 天：命令行的研究助手', () => {
  test('回答后面列出网页和本地文档两种来源；/sources 列出全部', async () => {
    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议' } }] })
      .reply({ toolCalls: [{ name: 'grep_docs', arguments: { pattern: 'tide reload' } }, { name: 'read_doc', arguments: { path: 'guide/config.md' } }] })
      .reply({ content: '潮汐协议 3.0 已经发布 [1]，改完配置要执行 tide reload [3]。' });
    const text = await runWith(['潮汐协议怎么样？', '/sources', '/exit']);
    expect(text).toContain('研究助手');
    expect(text).toContain('本地文档');
    expect(text).toMatch(/来源：\n\[1\] 潮汐协议 3\.0 发布说明 http:\/\/127\.0\.0\.1:\d+\/article\.html\n\[3\] 本地文档 guide\/config\.md/);
    expect(text).not.toContain('引用检查');
  });

  test('引用不合格时提醒用户', async () => {
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议' } }] }).reply({ content: '默认端口是 7443。' });
    const text = await runWith(['默认端口是多少？', '/exit']);
    expect(text).toContain('引用检查：');
    expect(text).toContain('没有任何引用');
  });

  test('没查资料的闲聊不检查引用', async () => {
    llm.reply({ content: '你好！我有 3 种查资料的办法。' });
    const text = await runWith(['你好', '/exit']);
    expect(text).not.toContain('引用检查');
  });
});
