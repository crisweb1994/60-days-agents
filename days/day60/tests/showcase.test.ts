import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const s = await loadTarget<typeof import('../solution/showcase.ts')>(import.meta.url, 'showcase.ts');
const { checkEntry, renderRow, parseShowcase, addToShowcase } = s;

type Entry = import('../solution/showcase.ts').ShowcaseEntry;
const SHOWCASE = await readFile(new URL('../../../SHOWCASE.md', import.meta.url), 'utf8');
const entry = (over: Partial<Entry> = {}): Entry => ({ name: 'review-bot', repo: 'https://github.com/alice-dev/review-bot', author: 'alice-dev', pitch: '给小团队的 PR 审查机器人，少而准', demo: 'https://review-bot.example.com', ...over });

describe('第 60 天：检查一条作品（TODO 1）', () => {
  test('合格的没有问题', () => {
    expect(checkEntry(entry())).toEqual([]);
    expect(renderRow(entry())).toBe('| [review-bot](https://github.com/alice-dev/review-bot) | [alice-dev](https://github.com/alice-dev) | 给小团队的 PR 审查机器人，少而准 | [在线地址](https://review-bot.example.com) |');
  });

  test('按顺序报出问题', () => {
    expect(checkEntry({ name: ' ', repo: 'https://gitlab.com/a/b', author: '-bad-', pitch: '一句话 | 两句话', demo: 'http://insecure.example.com' })).toEqual([
      'pitch 里不能有 | 或者换行',
      'name 不能是空的',
      'repo 要是 https://github.com/用户/仓库',
      'author 不是合法的 GitHub 用户名',
      'demo 要是 https 开头的在线地址',
    ]);
    expect(checkEntry(entry({ pitch: '很'.repeat(51) }))).toEqual(['pitch 太长了（51 字），50 字以内']);
    expect(checkEntry(entry({ pitch: '  ' }))).toEqual(['pitch 不能是空的']);
    expect(checkEntry(entry({ demo: 'not a url' }))).toEqual(['demo 要是 https 开头的在线地址']);
    expect(checkEntry(entry({ author: 'a--b' })), '不能有连续的连字符').toEqual(['author 不是合法的 GitHub 用户名']);
  });
});

describe('第 60 天：读作品墙（TODO 2）', () => {
  test('只读作品的行；仓库里的 SHOWCASE.md 能读', () => {
    const md = ['# 学员作品墙', '', '<!-- | [项目名](仓库地址) | 注释 -->', '', '| 项目 | 作者 | 一句话介绍 | 在线地址 |', '|---|---|---|---|', renderRow(entry()), renderRow(entry({ name: 'faq', repo: 'https://github.com/bob/faq' }))].join('\n');
    expect(parseShowcase(md)).toEqual([entry(), entry({ name: 'faq', repo: 'https://github.com/bob/faq' })]);
    expect(Array.isArray(parseShowcase(SHOWCASE))).toBe(true);
  });
});

describe('第 60 天：加一条作品（TODO 3）', () => {
  test('加在表格的最后；其余不动；同一个仓库不能加两次', () => {
    const once = addToShowcase(SHOWCASE, entry());
    expect(once.split('\n').length).toBe(SHOWCASE.split('\n').length + 1);
    expect(parseShowcase(once).at(-1)).toEqual(entry());
    expect(once.startsWith(SHOWCASE.split('\n').slice(0, 3).join('\n'))).toBe(true);
    const twice = addToShowcase(once, entry({ name: 'faq', repo: 'https://github.com/bob/faq', author: 'bob' }));
    expect(parseShowcase(twice).map((e) => e.name).slice(-2)).toEqual(['review-bot', 'faq']);
    expect(() => addToShowcase(twice, entry({ repo: 'https://github.com/Alice-Dev/Review-Bot/' }))).toThrow('已经在作品墙里了');
  });

  test('格式不对、没有表格：抛错', () => {
    expect(() => addToShowcase(SHOWCASE, entry({ name: '', demo: 'ftp://x' }))).toThrow('name 不能是空的；demo 要是 https 开头的在线地址');
    expect(() => addToShowcase('# 空的', entry())).toThrow('没有找到表格');
  });
});
