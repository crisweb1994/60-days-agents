import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { loadTarget } from '#testing';

const { closest, defineTool, describeParameters, paginate, runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(
  import.meta.url,
  'tool.ts',
);

const search = defineTool({
  name: 'search_articles',
  description: '搜索文章',
  schema: z.object({
    query: z.string().describe('关键词'),
    limit: z.int().min(1).max(10).optional().describe('最多返回几篇'),
    method: z.enum(['GET', 'POST']).describe('请求方法'),
  }),
  execute: () => '好的',
});
const tools = [search, defineTool({ name: 'read_article', description: '读文章', schema: z.object({}), execute: () => '' })];
const call = (name: string, args: object | string) => ({
  id: 'call_1',
  type: 'function' as const,
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

describe('第 11 天：叫错了工具名，告诉模型最像的是哪个（TODO 1）', () => {
  test('closest：拼写、大小写、连字符的差别都能认出来', () => {
    const names = ['search_articles', 'read_article', 'calculator'];
    expect(closest('search_article', names)).toBe('search_articles');
    expect(closest('Read-Article', names), '不区分大小写，- 当成 _').toBe('read_article');
    expect(closest('calculater', names)).toBe('calculator');
  });

  test('closest：差得太远就不提示，免得误导', () => {
    expect(closest('send_email', ['search_articles', 'read_article'])).toBeUndefined();
    expect(closest('x', ['calculator'])).toBeUndefined();
  });

  test('没有这个工具：错误信息里有「你是不是想用」和可用的工具', async () => {
    const result = await runToolCall(tools, call('search-article', { query: 'x' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('你是不是想用 search_articles');
    expect(result.content).toContain('read_article');
  });
});

describe('第 11 天：参数不对，把每个参数的要求列出来（TODO 2）', () => {
  test('describeParameters：每个参数一行，写明类型、必填还是可选、说明', () => {
    const lines = describeParameters(search).split('\n');
    expect(lines).toEqual([
      '- query（字符串，必填）：关键词',
      '- limit（整数，可选）：最多返回几篇',
      '- method（"GET" 或 "POST"，必填）：请求方法',
    ]);
  });

  test('校验失败：先说哪里错了，再附上参数的要求', async () => {
    const result = await runToolCall(tools, call('search_articles', { query: 123 }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('参数不符合要求');
    expect(result.content, '要附上 describeParameters 的结果').toContain('- query（字符串，必填）：关键词');
    expect(result.content.indexOf('参数不符合要求')).toBeLessThan(result.content.indexOf('- query'));
  });
});

describe('第 11 天：长文本分页（TODO 3）', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `第 ${String(i + 1).padStart(2, '0')} 行：一些内容`);
  const text = lines.join('\n');

  test('不超过一页：原样返回，不加页码', () => {
    expect(paginate('很短的内容', 1, 100)).toEqual({ content: '很短的内容', page: 1, pages: 1 });
  });

  test('超过一页：每页不超过 pageSize，末尾说明怎么读下一页；最后一页说明已经读完', () => {
    const first = paginate(text, 1, 100);
    expect(first.pages).toBeGreaterThan(1);
    const body = first.content.split('\n\n（')[0];
    expect(body.length).toBeLessThanOrEqual(100);
    expect(first.content).toContain(`第 1/${first.pages} 页`);
    expect(first.content).toContain('page=2');
    const last = paginate(text, first.pages, 100);
    expect(last.content).toContain('最后一页');
    expect(last.content).toContain('第 30 行');
  });

  test('在换行处分页，不把一行切成两半；所有页拼起来不丢内容', () => {
    const { pages } = paginate(text, 1, 100);
    const bodies = Array.from({ length: pages }, (_, i) => paginate(text, i + 1, 100).content.split('\n\n（')[0]);
    for (const body of bodies) {
      for (const line of body.split('\n')) expect(lines, `「${line}」被切断了`).toContain(line);
    }
    expect(bodies.join('\n')).toBe(text);
  });

  test('一整段没有换行：只能硬切，但也不丢内容', () => {
    const long = 'x'.repeat(250);
    const { pages } = paginate(long, 1, 100);
    expect(pages).toBe(3);
    const joined = Array.from({ length: pages }, (_, i) => paginate(long, i + 1, 100).content.split('\n\n（')[0]).join('');
    expect(joined).toBe(long);
  });

  test('页码超出范围：抛出错误，说明一共有几页', () => {
    expect(() => paginate(text, 99, 100)).toThrow(/一共只有 \d+ 页/);
    expect(() => paginate(text, 0, 100)).toThrow(/一共只有/);
  });
});
