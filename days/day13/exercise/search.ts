// 第 12 天：联网搜索。各家搜索 API 的请求和返回格式都不一样，这里统一成 SearchProvider：
// 输入一个查询，返回标题、网址和摘要。Agent 只认这个接口，换一家搜索服务不用改别的代码。
import { stripTags } from './html.ts';

export interface SearchResult {
  title: string;
  url: string;
  /** 搜索服务给的摘要。有的服务给的是一小段，有的是整理过的一大段 */
  snippet: string;
  /** 发布时间，有的服务会给 */
  publishedAt?: string;
}

export interface SearchOptions {
  /** 最多返回几条，默认 5 */
  limit?: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  /** 比如 tavily、bocha、brave，用来显示和记录 */
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface SearchConfig {
  apiKey: string;
  /** 接口地址，不填就用官方地址。测试时指向本地的假服务 */
  baseURL?: string;
  /** 超时时间，默认 15 秒 */
  timeoutMs?: number;
}

/** 发请求、检查状态码、解析 JSON。出错时把服务返回的内容带上，方便排查 */
async function requestJSON(name: string, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch((error: Error) => {
    if (timeout.aborted) throw new Error(`${name} 搜索超时（${timeoutMs / 1000} 秒）`);
    throw error;
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} 搜索出错：HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

/**
 * Tavily：为 Agent 设计的搜索服务，摘要是整理过的正文片段。
 * POST /search，Authorization: Bearer，返回 { results: [{ title, url, content, published_date? }] }
 */
export function createTavilySearch({ apiKey, baseURL = 'https://api.tavily.com', timeoutMs = 15_000 }: SearchConfig): SearchProvider {
  return {
    name: 'tavily',
    async search(query, { limit = 5, signal } = {}) {
      const data = await requestJSON(
        'Tavily',
        `${baseURL}/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: limit }),
        },
        timeoutMs,
        signal,
      );
      return (data.results ?? []).map(
        (item: any): SearchResult => ({
          title: item.title ?? '',
          url: item.url,
          snippet: item.content ?? '',
          ...(item.published_date ? { publishedAt: item.published_date } : {}),
        }),
      );
    },
  };
}

/**
 * 博查：国内的搜索 API。summary: true 时每条结果多一段更长的摘要。
 * POST /v1/web-search，Authorization: Bearer，返回 { code, data: { webPages: { value: [{ name, url, snippet, summary?, datePublished? }] } } }。
 * 注意：出错时 HTTP 状态码不一定不是 200，要再看一下 code
 */
export function createBochaSearch({ apiKey, baseURL = 'https://api.bochaai.com', timeoutMs = 15_000 }: SearchConfig): SearchProvider {
  return {
    name: 'bocha',
    async search(query, { limit = 5, signal } = {}) {
      const data = await requestJSON(
        '博查',
        `${baseURL}/v1/web-search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, count: limit, summary: true }),
        },
        timeoutMs,
        signal,
      );
      if (data.code !== undefined && Number(data.code) !== 200) {
        throw new Error(`博查搜索出错：${data.code} ${data.msg ?? data.message ?? ''}`.trim());
      }
      return (data.data?.webPages?.value ?? []).map(
        (item: any): SearchResult => ({
          title: item.name ?? '',
          url: item.url,
          // 有长摘要就用长摘要，信息更多
          snippet: item.summary || item.snippet || '',
          ...(item.datePublished ? { publishedAt: item.datePublished } : {}),
        }),
      );
    },
  };
}

/**
 * Brave Search：有自己的索引。GET /res/v1/web/search?q=…&count=…，请求头 X-Subscription-Token，
 * 返回 { web: { results: [{ title, url, description, page_age? }] } }。description 里带着 <strong> 之类的标签，要去掉
 */
export function createBraveSearch({ apiKey, baseURL = 'https://api.search.brave.com', timeoutMs = 15_000 }: SearchConfig): SearchProvider {
  return {
    name: 'brave',
    async search(query, { limit = 5, signal } = {}) {
      const url = `${baseURL}/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit) })}`;
      const data = await requestJSON(
        'Brave',
        url,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } },
        timeoutMs,
        signal,
      );
      return (data.web?.results ?? []).map(
        (item: any): SearchResult => ({
          title: stripTags(item.title ?? ''),
          url: item.url,
          snippet: stripTags(item.description ?? ''),
          ...(item.page_age ? { publishedAt: item.page_age } : {}),
        }),
      );
    },
  };
}

export const SEARCH_PROVIDERS = ['tavily', 'bocha', 'brave'] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

/**
 * 从环境变量创建搜索服务：SEARCH_PROVIDER 选哪一家，对应的 TAVILY_API_KEY、BOCHA_API_KEY 或 BRAVE_API_KEY 填 Key。
 * 没有配置时返回 undefined：Agent 照样能用，只是不能联网搜索
 */
export function searchProviderFromEnv(env: NodeJS.ProcessEnv = process.env): SearchProvider | undefined {
  const name = env.SEARCH_PROVIDER;
  if (!name) return undefined;
  if (!SEARCH_PROVIDERS.includes(name as SearchProviderName)) {
    throw new Error(`SEARCH_PROVIDER 只能是 ${SEARCH_PROVIDERS.join('、')}，现在是 ${name}`);
  }
  const key = `${name.toUpperCase()}_API_KEY`;
  const apiKey = env[key];
  if (!apiKey) throw new Error(`SEARCH_PROVIDER 是 ${name}，但没有填 ${key}`);
  const create = { tavily: createTavilySearch, bocha: createBochaSearch, brave: createBraveSearch }[name as SearchProviderName];
  return create({ apiKey });
}
