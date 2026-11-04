import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { DOCS } from './docs.ts';

const { chunkMarkdown, embeddingText, splitLong, splitSection, splitSections } = await loadTarget<typeof import('../solution/rag/chunk.ts')>(
  import.meta.url,
  'rag/chunk.ts',
);

describe('第 17 天：切分文档（TODO 2）', () => {
  test('splitSections：按标题分节，heading 是标题的路径；没有正文的标题不成节', () => {
    const sections = splitSections(DOCS['guide/deploy.md']);
    expect(sections.map((s) => s.heading)).toEqual(['部署', '部署 > 用 Docker 部署', '部署 > 上线前的检查']);
    expect(sections[1].body).toContain('docker run');
  });

  test('splitSections：回到上一级标题时，路径也跟着回去；代码块里的 # 不是标题', () => {
    const md = '# A\n\n## B\n\nb 的内容\n\n# C\n\n```sh\n# 这是注释\necho hi\n```';
    const sections = splitSections(md);
    expect(sections.map((s) => s.heading)).toEqual(['A > B', 'C']);
    expect(sections[1].body).toContain('# 这是注释');
  });

  test('没有标题的文档：整篇是一节，heading 是空字符串', () => {
    expect(splitSections(DOCS['notes.txt'])).toEqual([{ heading: '', body: DOCS['notes.txt'] }]);
  });

  test('splitSection：段落尽量完整地放进同一块，放不下就开始新的一块', () => {
    const body = ['一'.repeat(30), '二'.repeat(30), '三'.repeat(30)].join('\n\n');
    expect(splitSection(body, 70, 10)).toEqual([`${'一'.repeat(30)}\n\n${'二'.repeat(30)}`, '三'.repeat(30)]);
  });

  test('splitLong：太长的段落硬切，相邻两块重叠 overlap 个字符，最后一块到结尾为止', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    expect(splitLong(text, 10, 3)).toEqual(['abcdefghij', 'hijklmnopq', 'opqrstuvwx', 'vwxyz']);
    expect(splitLong('short', 10, 3)).toEqual(['short']);
  });

  test('chunkMarkdown：每块带着 id、路径和标题；embeddingText 带上路径和标题', () => {
    const chunks = chunkMarkdown(DOCS['guide/deploy.md'], 'guide/deploy.md');
    expect(chunks.map((c) => c.id)).toEqual(['guide/deploy.md#0', 'guide/deploy.md#1', 'guide/deploy.md#2']);
    expect(chunks[1]).toMatchObject({ path: 'guide/deploy.md', heading: '部署 > 用 Docker 部署' });
    expect(embeddingText(chunks[1])).toMatch(/^guide\/deploy\.md · 部署 > 用 Docker 部署\n运行 docker run/);
  });
});
