import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createLibraryTools, LIBRARY_PAGE_SIZE } = await loadTarget<typeof import('../solution/tools/library.ts')>(
  import.meta.url,
  'tools/library.ts',
);
const { createBadLibraryTools } = await loadTarget<typeof import('../solution/tools/library-bad.ts')>(
  import.meta.url,
  'tools/library-bad.ts',
);

const tools = createLibraryTools();
let nextId = 1;
const run = (name: string, args: object) =>
  runToolCall(tools, { id: `call_${nextId++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

describe('第 11 天：search_articles 返回精简的结果（TODO 4）', () => {
  test('每篇文章一行：slug、标题、作者、年份，不带数据库的内部字段', async () => {
    const result = await run('search_articles', { query: '错误信息' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('共找到 1 篇');
    expect(result.content).toContain('three-part-errors');
    expect(result.content).toContain('唐果');
    expect(result.content).toContain('2024');
    for (const field of ['db_id', '_rev', 'indexed_at', 'bucket', 'acl', 'role:reader']) {
      expect(result.content, `内部字段 ${field} 对模型没用`).not.toContain(field);
    }
  });

  test('可以按作者搜，也可以按标签和年份筛选', async () => {
    const byAuthor = await run('search_articles', { query: '韩松' });
    expect(byAuthor.content).toContain('共找到 3 篇');
    const filtered = await run('search_articles', { query: '', tag: 'evaluation', year_from: 2025 });
    expect(filtered.content).toContain('共找到 3 篇');
    expect(filtered.content).not.toContain('2023');
  });

  test('结果比 limit 多：只显示前几篇，并说明怎么看更多', async () => {
    const result = await run('search_articles', { query: '', limit: 2 });
    expect(result.content).toContain('共找到 8 篇');
    expect(result.content.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    expect(result.content).toContain('limit');
  });

  test('什么都没找到：不是空字符串，而是建议换个关键词，并列出可用的标签', async () => {
    const result = await run('search_articles', { query: '量子计算', tag: 'mcp' });
    expect(result.content).toContain('没有找到');
    expect(result.content, '提示去掉筛选条件').toContain('tag=mcp');
    expect(result.content).toContain('evaluation');
  });

  test('比设计糟糕的版本短得多', async () => {
    const bad = await runToolCall(createBadLibraryTools(), {
      id: 'call_bad',
      type: 'function',
      function: { name: 'query', arguments: JSON.stringify({ q: '', t: 'a' }) },
    });
    const good = await run('search_articles', { query: '', limit: 10 });
    expect(good.content.length * 5, `改前 ${bad.content.length} 字符，改后 ${good.content.length} 字符`).toBeLessThan(bad.content.length);
  });
});

describe('第 11 天：read_article 分页阅读，抄错了 slug 给出建议（TODO 5）', () => {
  test('短文章一次读完，带标题和作者', async () => {
    const result = await run('read_article', { slug: 'three-part-errors' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('# 让模型自己改正：三段式错误信息');
    expect(result.content).toContain('唐果');
    expect(result.content).not.toContain('页');
  });

  test('长文章分页，每页不超过 LIBRARY_PAGE_SIZE，最后一页能读到结论', async () => {
    const first = await run('read_article', { slug: 'context-budget-handbook' });
    const pages = Number(first.content.match(/第 1\/(\d+) 页/)?.[1]);
    expect(pages, '第一页的末尾要说明一共几页').toBeGreaterThan(1);
    expect(first.content.split('\n\n（')[0].length).toBeLessThanOrEqual(LIBRARY_PAGE_SIZE);
    expect(first.content).not.toContain('30%');
    const last = await run('read_article', { slug: 'context-budget-handbook', page: pages });
    expect(last.content).toContain('30%');
  });

  test('slug 抄错了：错误信息里给出最像的 slug，并建议先搜索', async () => {
    const result = await run('read_article', { slug: 'three-part-error' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('three-part-errors');
    expect(result.content).toContain('search_articles');
  });

  test('页码超出范围：告诉模型一共有几页', async () => {
    const result = await run('read_article', { slug: 'three-part-errors', page: 5 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('一共只有 1 页');
  });
});
