// 用真正的 Chromium 测 browser-playwright.ts。没有下载浏览器时跳过（npx playwright install chromium）。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { startFixture } from './web-fixture.ts';

const fixture = await startFixture();
const { createPlaywrightBrowser } = await loadTarget<typeof import('../solution/browser-playwright.ts')>(import.meta.url, 'browser-playwright.ts');
const { createBrowserTools } = await loadTarget<typeof import('../solution/browser.ts')>(import.meta.url, 'browser.ts');
const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');

const installed = existsSync(chromium.executablePath());
const call = (name: string, args: object) => ({ id: 'c', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe.runIf(installed)('第 27 天：真正的浏览器', { timeout: 30_000 }, () => {
  const browsers: { close(): Promise<void> }[] = [];
  afterAll(() => Promise.all(browsers.map((b) => b.close())));
  function tools(policy: { allowedHosts?: string[] } = {}) {
    const browser = createPlaywrightBrowser({ allowPrivate: true, ...policy });
    browsers.push(browser);
    const { tools } = createBrowserTools({ open: () => browser.open(), allowPrivate: true, ...policy });
    return (name: string, args: object) => runToolCall(tools, call(name, args), { confirm: async () => true });
  }

  test('运行脚本以后的内容、能操作的元素、点击、输入', async () => {
    const run = tools();
    const opened = await run('browser_open', { url: `${fixture.base}/spa.html` });
    expect(opened.isError).toBe(false);
    expect(opened.content, '脚本画出来的内容').toContain('从 3.0.2 开始支持');
    expect(opened.content).toContain('searchbox「搜索问题」');
    expect(opened.content).toContain('password「密码」');
    const ref = opened.content.match(/\[(e\d+)\] button「加载更多」/)![1];
    const clicked = await run('browser_click', { ref });
    expect(clicked.content).toContain('limits.max_connections');
    expect(clicked.content).toMatch(/button「加载更多」（不可用）/);
    const box = clicked.content.match(/\[(e\d+)\] searchbox/)![1];
    const searched = await run('browser_type', { ref: box, text: 'IPv6', submit: true });
    expect(searched.content).toContain('搜索「IPv6」：找到 1 条');
  });

  test('页面里的脚本请求不允许的地址：在浏览器里就被拦下', async () => {
    const run = tools({ allowedHosts: ['127.0.0.1'] });
    await run('browser_open', { url: `${fixture.base}/spa.html` });
    await new Promise((r) => setTimeout(r, 200));
    expect(fixture.hits.get('/notes.txt'), '对 localhost 的请求不该发出去').toBeUndefined();
  });

  test('不限制时，同样的请求会发出去（说明上一个测试拦住的是它）', async () => {
    const run = tools();
    await run('browser_open', { url: `${fixture.base}/spa.html` });
    await new Promise((r) => setTimeout(r, 200));
    expect(fixture.hits.get('/notes.txt')).toBe(1);
  });
});
