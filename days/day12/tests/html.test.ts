import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { PAGES } from './fixtures.ts';

const { htmlToMarkdown, removeNoise, extractMain, toMarkdown } = await loadTarget<typeof import('../solution/html.ts')>(
  import.meta.url,
  'html.ts',
);
const article = PAGES['/article.html'].body as string;
const BASE = 'https://tide.example/news/3.0.html';

describe('第 12 天：去掉噪音，找出正文（TODO 1）', () => {
  test('removeNoise：去掉脚本、样式、导航、页眉页脚、侧栏和注释', () => {
    const cleaned = removeNoise(`${article}<!-- 统计代码 -->`);
    for (const noise of ['噪音脚本', 'color:red', '关于我们', '站点横幅广告', '十大热门文章', '备案号', '统计代码']) {
      expect(cleaned, `「${noise}」应该去掉`).not.toContain(noise);
    }
    expect(cleaned).toContain('潮汐协议 3.0 于 2026 年 3 月 14 日发布');
  });

  test('extractMain：优先 <article>，其次 <main>，再次 <body>', () => {
    expect(extractMain('<body><p>外面</p><article><p>文章</p></article></body>')).toBe('<p>文章</p>');
    expect(extractMain('<body><p>外面</p><main><p>主体</p></main></body>')).toBe('<p>主体</p>');
    expect(extractMain('<html><body><p>只有 body</p></body></html>')).toBe('<p>只有 body</p>');
    expect(extractMain('<p>什么都没有</p>')).toBe('<p>什么都没有</p>');
  });
});

describe('第 12 天：把标签换成 Markdown（TODO 2）', () => {
  test('标题换成 #，列表项换成 -', () => {
    const md = toMarkdown('<h1>大标题</h1><h3>小标题</h3><ul><li>一</li><li>二</li></ul>', BASE);
    expect(md).toContain('# 大标题');
    expect(md).toContain('### 小标题');
    expect(md).toContain('- 一\n- 二');
  });

  test('链接换成 [文字](绝对网址)：相对链接按网页的网址补全，javascript: 链接只留文字', () => {
    const md = toMarkdown('<a href="/docs/a.html">文档</a> <a href="b.html">同目录</a> <a href="javascript:void(0)">别点</a>', BASE);
    expect(md).toContain('[文档](https://tide.example/docs/a.html)');
    expect(md).toContain('[同目录](https://tide.example/news/b.html)');
    expect(md).toContain('别点');
    expect(md).not.toContain('javascript');
  });

  test('整个网页：有标题、正文、绝对链接和代码块，字符实体都换回了字符', () => {
    const { title, markdown } = htmlToMarkdown(article, BASE);
    expect(title).toBe('潮汐协议 3.0 发布说明');
    expect(markdown).toContain('# 潮汐协议 3.0 发布');
    expect(markdown).toContain('## 主要变化');
    expect(markdown).toContain('- 握手只要 **1** 次');
    expect(markdown).toContain('[完整规范](https://example.com/spec?a=1&b=2)');
    expect(markdown).toContain('tide connect --port 7443 <host>');
    expect(markdown).toContain('周&王 © 2026 潮汐社区');
    expect(markdown, '不应该留下 HTML 标签').not.toMatch(/<\/?(p|div|a|span|li|ul|h[1-6]|strong|code|article)\b/i);
    expect(markdown.length, '清洗以后应该比原来短得多').toBeLessThan(article.length / 2);
  });
});
