// 测试用的本地服务：把 data/web.ts 的假互联网包上 vitest 的钩子，每个测试开始前清空记录，测试文件跑完关掉。
// 网页和搜索结果的内容在 data/web.ts（第 31 天从这里挪过去，评估也要用）。
import { afterAll, beforeEach } from 'vitest';
import { startWebServer, type WebServer } from '../data/web.ts';

export { API_KEY, PAGES, searchHits } from '../data/web.ts';

export type Fixture = Omit<WebServer, 'close'>;

export async function startFixture(): Promise<Fixture> {
  const web = await startWebServer();
  beforeEach(() => {
    web.hits.clear();
    web.searches.length = 0;
    web.received.length = 0;
  });
  afterAll(() => web.close());
  return web;
}
