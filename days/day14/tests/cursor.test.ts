import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { encodeCursor, decodeCursor } = await loadTarget<typeof import('../solution/server/cursor.ts')>(import.meta.url, 'server/cursor.ts');

describe('第 14 天：游标（TODO 1）', () => {
  test('编码以后是 base64url，解码回原来的内容', () => {
    const cursor = encodeCursor({ kind: 'read', path: 'work/发布.md', offset: 2000 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, 'read')).toEqual({ kind: 'read', path: 'work/发布.md', offset: 2000 });
  });

  test('坏掉的、种类不对的、版本不对的游标：报错，并建议去掉 cursor 重新调用', () => {
    const search = encodeCursor({ kind: 'search', query: 'x', offset: 5 });
    expect(() => decodeCursor('不是游标', 'search')).toThrow('去掉 cursor');
    expect(() => decodeCursor(search, 'read'), 'search 的游标不能拿来 read').toThrow('cursor 无效');
    const old = Buffer.from(JSON.stringify({ v: 0, kind: 'search', query: 'x', offset: 5 })).toString('base64url');
    expect(() => decodeCursor(old, 'search')).toThrow('cursor 无效');
    const negative = Buffer.from(JSON.stringify({ v: 1, kind: 'search', query: 'x', offset: -1 })).toString('base64url');
    expect(() => decodeCursor(negative, 'search')).toThrow('cursor 无效');
  });
});
