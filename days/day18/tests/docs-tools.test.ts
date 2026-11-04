import { describe, expect, test } from 'vitest';
import { loadTarget, setupModel } from '#testing';
import { buildIndex, DOCS_ROOT } from './helpers.ts';

await setupModel();
const { createDocsTools } = await loadTarget<typeof import('../solution/tools/docs.ts')>(import.meta.url, 'tools/docs.ts');
const { runToolCall, toToolDefinition } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createSourceRegistry } = await loadTarget<typeof import('../solution/web.ts')>(import.meta.url, 'web.ts');
const { createScriptedModel } = await loadTarget<typeof import('../solution/testing/scripted-model.ts')>(
  import.meta.url,
  'testing/scripted-model.ts',
);
const { createLLMReranker } = await loadTarget<typeof import('../solution/rag/rerank.ts')>(import.meta.url, 'rag/rerank.ts');

const { retriever } = await buildIndex(import.meta.url);
let nextId = 1;
const runner = (tools: ReturnType<typeof createDocsTools>) => (name: string, args: object) =>
  runToolCall(tools, { id: `c${nextId++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

describe('第 18 天：search_docs 工具（TODO 4）', () => {
  test('返回编号、出处、标题和内容，并提示可以用 read_doc 读全文', async () => {
    const run = runner(createDocsTools({ root: DOCS_ROOT, retriever }));
    const result = await run('search_docs', { query: 'TIDE_E2077', mode: 'keyword', k: 2 });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/^找到 1 段：/);
    expect(result.content).toContain('[1] ops/errors.md · 错误码');
    expect(result.content).toContain('熔断');
    expect(result.content).toContain('read_doc');
  });

  test('有来源登记：用来源的编号，同一篇文档的段落编号相同', async () => {
    const sources = createSourceRegistry();
    sources.add('https://example.com', '先登记的网页');
    const run = runner(createDocsTools({ root: DOCS_ROOT, retriever, sources }));
    const result = await run('search_docs', { query: '握手 重试 超时', k: 3 });
    const config = sources.list().find((s) => s.url === 'doc:guide/config.md');
    expect(config, '检索到的文档要登记成来源').toBeTruthy();
    expect(config!.id, '先登记的网页是 [1]，文档从 [2] 开始').toBeGreaterThan(1);
    expect(result.content).toContain(`[${config!.id}] guide/config.md`);
  });

  test('一段都没找到：建议换说法或者用 grep_docs', async () => {
    const run = runner(createDocsTools({ root: DOCS_ROOT, retriever }));
    const result = await run('search_docs', { query: 'zzzz', mode: 'keyword' });
    expect(result.content).toContain('grep_docs');
  });

  test('有重排：先取 4 倍的候选，再重排', async () => {
    const reranker = createLLMReranker(createScriptedModel([{ text: '{"ranking":[2]}' }]));
    const run = runner(createDocsTools({ root: DOCS_ROOT, retriever, reranker }));
    const result = await run('search_docs', { query: '证书', k: 1 });
    expect(result.content).toMatch(/^找到 1 段/);
  });

  test('固定检索方式时，参数里没有 mode', () => {
    const [search] = createDocsTools({ root: DOCS_ROOT, retriever, mode: 'keyword' });
    expect(Object.keys((toToolDefinition(search).function.parameters as any).properties)).toEqual(['query', 'k']);
  });
});

describe('第 18 天：grep_docs 和 read_doc', () => {
  const run = runner(createDocsTools({ root: DOCS_ROOT, retriever }));

  test('grep_docs：精确地逐行查找，返回路径和行号', async () => {
    const result = await run('grep_docs', { pattern: 'tide_e1042' });
    expect(result.content).toMatch(/^ops\/errors\.md:\d+: \| TIDE_E1042/);
    const regex = await run('grep_docs', { pattern: 'handshake\\.\\w+', regex: true });
    expect(regex.content).toMatch(/guide\/config\.md:\d+:.*handshake\.retries/);
    expect((await run('grep_docs', { pattern: '[', regex: true })).isError).toBe(true);
  });

  test('read_doc：读整篇文档；目录外的路径不行', async () => {
    expect((await run('read_doc', { path: 'ops/oncall.md' })).content).toContain('tide rollback');
    expect((await run('read_doc', { path: '../qa.ts' })).isError).toBe(true);
    expect((await run('read_doc', { path: 'nope.md' })).content).toContain('search_docs');
  });
});
