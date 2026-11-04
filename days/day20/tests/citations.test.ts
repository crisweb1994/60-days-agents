import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const c = await loadTarget<typeof import('../solution/citations.ts')>(import.meta.url, 'citations.ts');
const { createSourceRegistry } = await loadTarget<typeof import('../solution/web.ts')>(import.meta.url, 'web.ts');
const { appendReferences, checkCitations, citedIds, formatSourceLine, splitSentences } = c;

const sources = createSourceRegistry();
sources.add('https://tide.example/news/3.0.html', '潮汐协议 3.0 发布说明');
sources.add('doc:guide/deploy.md', 'guide/deploy.md');

test('citedIds 和 splitSentences', () => {
  expect(citedIds('甲 [2]。乙 [1, 2]，见 [文档](https://x.example) [3][1]。')).toEqual([2, 1, 3]);
  expect(splitSentences('第一句。第二句！\n- 列表项 3 个\n1. 第一步\n```\n代码 123\n```')).toEqual(['第一句。', '第二句！', '列表项 3 个', '第一步']);
});

describe('第 20 天：来源列表（TODO 1）', () => {
  test('formatSourceLine：网页写标题和网址，本地文档写「本地文档」和路径', () => {
    expect(formatSourceLine(sources.get(1)!)).toBe('[1] 潮汐协议 3.0 发布说明 https://tide.example/news/3.0.html');
    expect(formatSourceLine(sources.get(2)!)).toBe('[2] 本地文档 guide/deploy.md');
  });

  test('appendReferences：在回答后面空一行，加上「来源：」；没有引用就原样返回', () => {
    expect(appendReferences('回答 [2]。', [sources.get(2)!])).toBe('回答 [2]。\n\n来源：\n[2] 本地文档 guide/deploy.md');
    expect(appendReferences('回答。', [])).toBe('回答。');
  });
});

describe('第 20 天：检查引用的格式（TODO 2）', () => {
  test('合格的回答：查过资料，引用都登记过，带数字的句子都有引用', () => {
    const report = checkCitations('潮汐协议 3.0 把握手减少到 1 次 [1]。上线前要检查证书 [2]。这很重要。', sources, { researched: true });
    expect(report).toEqual({ ok: true, cited: [sources.get(1), sources.get(2)], problems: [] });
  });

  test('编号不是查到过的来源', () => {
    const report = checkCitations('据说如此 [9]。', sources, { researched: true });
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('[9] 不是查到过的来源');
  });

  test('查过资料却一个引用都没有；没查资料的闲聊不要求引用', () => {
    expect(checkCitations('潮汐协议很好用。', sources, { researched: true }).problems).toContain('查过资料，但回答里没有任何引用');
    expect(checkCitations('你好！今天有 3 件事要做吗？', sources, { researched: false }).ok).toBe(true);
  });

  test('带数字的句子没有引用：指出是哪一句', () => {
    const report = checkCitations('握手减少到 1 次 [1]。默认端口是 7443。', sources, { researched: true });
    expect(report.problems).toEqual(['这句话有具体的数字，但没有标明来源：「默认端口是 7443。」']);
  });

  test('引用写在句子开头、自己写来源列表：都是问题', () => {
    expect(checkCitations('[1] 握手减少了。', sources, { researched: true }).problems).toContain('引用要写在句子的末尾，不要写在开头');
    const listed = checkCitations('握手减少了 [1]。\n\n来源：\n[1] https://tide.example', sources, { researched: true });
    expect(listed.problems.some((p) => p.includes('来源列表'))).toBe(true);
  });
});
