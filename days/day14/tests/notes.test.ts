import { beforeAll, describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { makeNotes } from './helpers.ts';

const { loadNotes, searchNotes, readNote, READ_CHUNK } = await loadTarget<typeof import('../solution/server/notes.ts')>(
  import.meta.url,
  'server/notes.ts',
);

let root: string;
beforeAll(async () => {
  root = await makeNotes();
});

test('loadNotes：只读 .md 文件，按路径排序，标题取第一个 # 标题', async () => {
  const notes = await loadNotes(root);
  expect(notes.map((n) => n.path)).toEqual(['life/recipes.md', 'long.md', 'work/oncall.md', 'work/release.md']);
  expect(notes[3].title).toBe('发布流程');
});

describe('第 14 天：搜索笔记，用游标翻页（TODO 2）', () => {
  test('标题或正文里有关键词就算匹配，返回路径、标题和摘要', async () => {
    const result = await searchNotes(root, { query: '值班', limit: 5 });
    expect(result.total).toBe(1);
    expect(result.results[0]).toMatchObject({ path: 'work/oncall.md', title: '值班表' });
    expect(result.results[0].snippet).toContain('老周');
    expect(result.nextCursor, '没有更多结果时不给游标').toBeUndefined();
  });

  test('结果比 limit 多：给出游标，带着游标再调用得到下一页，直到没有游标', async () => {
    const first = await searchNotes(root, { query: '发布', limit: 1 });
    expect(first.total).toBe(2);
    expect(first.results).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await searchNotes(root, { query: '发布', limit: 1, cursor: first.nextCursor });
    expect(second.results[0].path).not.toBe(first.results[0].path);
    expect(second.nextCursor).toBeUndefined();
  });

  test('游标是另一个查询的：报错，说明要去掉游标', async () => {
    const { nextCursor } = await searchNotes(root, { query: '发布', limit: 1 });
    await expect(searchNotes(root, { query: '值班', limit: 1, cursor: nextCursor })).rejects.toThrow('去掉 cursor');
  });
});

describe('第 14 天：分段读笔记（TODO 3）', () => {
  test('短笔记一次读完，没有游标', async () => {
    const result = await readNote(root, { path: 'work/release.md' });
    expect(result).toMatchObject({ path: 'work/release.md', title: '发布流程' });
    expect(result.content).toContain('每周四');
    expect(result.nextCursor).toBeUndefined();
  });

  test('长笔记：每次最多 READ_CHUNK 个字符，跟着游标读完，拼起来就是全文', async () => {
    let cursor: string | undefined;
    let text = '';
    let calls = 0;
    do {
      const result = await readNote(root, { path: 'long.md', cursor });
      expect(result.content.length).toBeLessThanOrEqual(READ_CHUNK);
      text += result.content;
      cursor = result.nextCursor;
      calls++;
    } while (cursor && calls < 10);
    expect(calls).toBe(3);
    expect(text).toContain('暗号是青柠');
    expect(text.startsWith('# 长笔记')).toBe(true);
  });

  test('目录外的路径、不存在的笔记、不是 .md 的文件：都报错', async () => {
    await expect(readNote(root, { path: '../../etc/passwd.md' })).rejects.toThrow('工作目录之外');
    await expect(readNote(root, { path: 'nope.md' })).rejects.toThrow('search_notes');
    await expect(readNote(root, { path: 'draft.txt' })).rejects.toThrow('.md');
  });
});
