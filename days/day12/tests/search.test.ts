import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { API_KEY, startFixture } from './fixtures.ts';

const fixture = await startFixture();
const { createTavilySearch, createBochaSearch, createBraveSearch, searchProviderFromEnv } = await loadTarget<
  typeof import('../solution/search.ts')
>(import.meta.url, 'search.ts');

describe('第 12 天：把各家的搜索结果统一成 SearchResult', () => {
  test('Tavily：POST /search，Bearer 认证，content 作为摘要', async () => {
    const tavily = createTavilySearch({ apiKey: API_KEY, baseURL: `${fixture.base}/tavily` });
    const results = await tavily.search('潮汐协议', { limit: 3 });
    expect(fixture.searches[0]).toMatchObject({ body: { query: '潮汐协议', max_results: 3 }, auth: `Bearer ${API_KEY}` });
    expect(results[0]).toEqual({
      title: '潮汐协议 3.0 发布说明',
      url: `${fixture.base}/article.html`,
      snippet: '潮汐协议 3.0 于 2026 年 3 月发布……',
      publishedAt: '2026-03-14T08:00:00Z',
    });
  });

  test('Brave：GET 请求，摘要里的标签和字符实体要去掉', async () => {
    const brave = createBraveSearch({ apiKey: API_KEY, baseURL: `${fixture.base}/brave` });
    const [first] = await brave.search('潮汐协议');
    expect(first.snippet).toBe('潮汐协议 & 潮汐协议 3.0 于 2026 年 3 月发布……');
  });

  test('Key 不对：错误信息里带上状态码', async () => {
    const tavily = createTavilySearch({ apiKey: 'wrong', baseURL: `${fixture.base}/tavily` });
    await expect(tavily.search('x')).rejects.toThrow(/401/);
  });
});

describe('第 12 天：博查（TODO 3）', () => {
  const bocha = () => createBochaSearch({ apiKey: API_KEY, baseURL: `${fixture.base}/bocha` });

  test('结果在 data.webPages.value 里：name 是标题，有 summary 就用 summary，没有就用 snippet', async () => {
    const results = await bocha().search('潮汐协议', { limit: 2 });
    expect(fixture.searches[0].body, '要请求长摘要，条数用 count').toMatchObject({ query: '潮汐协议', count: 2, summary: true });
    expect(results).toEqual([
      { title: '潮汐协议 3.0 发布说明', url: `${fixture.base}/article.html`, snippet: '潮汐协议 3.0 于 2026 年 3 月发布……', publishedAt: '2026-03-14T08:00:00Z' },
      { title: '很长的文章', url: `${fixture.base}/long.html`, snippet: '短摘要' },
    ]);
  });

  test('HTTP 200 但 code 不是 200：也是出错了', async () => {
    await expect(bocha().search('余额不足')).rejects.toThrow('余额不足');
  });

  test('没有结果：返回空数组', async () => {
    expect(await bocha().search('没有结果')).toEqual([]);
  });
});

describe('第 12 天：从环境变量选择搜索服务', () => {
  test('没有配置就不用搜索；配置了就创建对应的服务', () => {
    expect(searchProviderFromEnv({})).toBeUndefined();
    expect(searchProviderFromEnv({ SEARCH_PROVIDER: 'bocha', BOCHA_API_KEY: 'k' })?.name).toBe('bocha');
  });

  test('配置不完整：说明缺什么', () => {
    expect(() => searchProviderFromEnv({ SEARCH_PROVIDER: 'tavily' })).toThrow('TAVILY_API_KEY');
    expect(() => searchProviderFromEnv({ SEARCH_PROVIDER: 'google' })).toThrow('tavily');
  });
});
