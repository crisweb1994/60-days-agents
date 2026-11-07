import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { createToolSearch, scoreTool } = await loadTarget<typeof import('../solution/tool-search.ts')>(import.meta.url, 'tool-search.ts');
const { defineTool, runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const tool = (name: string, description: string) => defineTool({ name, description, schema: z.object({}), execute: () => `${name} 的结果` });
const ALL = [
  tool('web_search', '在网上搜索'),
  tool('fetch_page', '打开一个网页，读正文'),
  tool('browser_open', '在浏览器里打开网页，可以点击和输入'),
  tool('browser_click', '点击页面上的按钮或者链接'),
  tool('update_plan', '列出或更新研究计划'),
  tool('calculator', '计算数学表达式'),
];
const call = (query: string) => ({ id: 'c', type: 'function' as const, function: { name: 'search_tools', arguments: JSON.stringify({ query }) } });

// 中文按词切，切法由 Intl.Segmenter 决定：「浏览器」切成「浏览」「器」，「点击」切成「点」「击」，每个词各算一次
test('scoreTool：名字里的词 2 分，描述里的词 1 分', () => {
  expect(scoreTool(ALL[2], 'browser')).toBe(2);
  expect(scoreTool(ALL[2], '浏览器 browser')).toBe(4);
  expect(scoreTool(ALL[3], '点击 按钮')).toBe(3);
  expect(scoreTool(ALL[5], '浏览器')).toBe(0);
});

describe('第 28 天：按需检索工具（TODO 4）', () => {
  test('一开始只有常用的工具和 search_tools', () => {
    const search = createToolSearch(ALL, { core: ['web_search', 'fetch_page'] });
    expect(search.tools.map((t) => t.name)).toEqual(['web_search', 'fetch_page', 'search_tools']);
    expect(search.deferred()).toEqual(['browser_open', 'browser_click', 'update_plan', 'calculator']);
  });

  test('搜到的工具追加在末尾，按相关程度排，最多 maxResults 个', async () => {
    const search = createToolSearch(ALL, { core: ['web_search'], maxResults: 2 });
    const result = await runToolCall(search.tools, call('浏览器 点击 browser'));
    expect(result.content).toBe('已加载 2 个工具，下一步可以直接调用：\n- browser_open：在浏览器里打开网页，可以点击和输入\n- browser_click：点击页面上的按钮或者链接');
    expect(search.tools.map((t) => t.name), '前面的不变，提示缓存才能命中').toEqual(['web_search', 'search_tools', 'browser_open', 'browser_click']);
    expect(search.deferred()).toEqual(['fetch_page', 'update_plan', 'calculator']);
  });

  test('加载过的不会再加载；搜不到时列出还没加载的', async () => {
    const search = createToolSearch(ALL, { core: [] });
    await runToolCall(search.tools, call('计划'));
    const again = await runToolCall(search.tools, call('计划'));
    expect(again.content).toContain('没有找到和「计划」相关的工具');
    expect(again.content).toContain('web_search、fetch_page、browser_open、browser_click、calculator');
    expect(search.tools.filter((t) => t.name === 'update_plan')).toHaveLength(1);
  });
});

describeMock('第 28 天：Agent 循环每一步都用最新的工具列表', () => {
  test('搜索加载了 calculator，下一次请求里就有它，模型可以直接调用', async () => {
    const search = createToolSearch(ALL, { core: ['web_search'] });
    llm
      .reply({ toolCalls: [{ name: 'search_tools', arguments: { query: '计算' } }] })
      .reply({ toolCalls: [{ name: 'calculator', arguments: {} }] })
      .reply({ content: '算好了。' });
    const result = await runAgent('算一下', { model: createModel('openai'), tools: search.tools });
    expect(llm.requests.map((r) => r.tools!.map((t) => t.function.name))).toEqual([
      ['web_search', 'search_tools'],
      ['web_search', 'search_tools', 'calculator'],
      ['web_search', 'search_tools', 'calculator'],
    ]);
    expect(result.messages.find((m) => m.role === 'tool' && m.content === 'calculator 的结果')).toBeTruthy();
  });
});
