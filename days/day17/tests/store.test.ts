import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { cosine, createVectorStore, loadVectorStore } = await loadTarget<typeof import('../solution/rag/vector-store.ts')>(
  import.meta.url,
  'rag/vector-store.ts',
);

const chunk = (id: string, path = 'a.md') => ({ id, path, heading: '', text: id });

describe('第 17 天：向量库（TODO 3）', () => {
  test('cosine：方向相同是 1，垂直是 0，相反是 -1，不看长短', () => {
    expect(cosine([1, 0], [3, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 2])).toBeCloseTo(0);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 0]), '零向量不要除以 0').toBe(0);
  });

  test('维数不一样：报错，提醒是不是换了模型', () => {
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow('重建索引');
  });

  test('search：按相似度从高到低返回前 k 个；可以过滤，可以设最低分', () => {
    const store = createVectorStore('m');
    store.add([
      { chunk: chunk('x', 'docs/x.md'), vector: [1, 0] },
      { chunk: chunk('xy', 'docs/xy.md'), vector: [1, 1] },
      { chunk: chunk('y', 'other/y.md'), vector: [0, 1] },
    ]);
    expect(store.search([1, 0.1], { k: 2 }).map((h) => h.chunk.id)).toEqual(['x', 'xy']);
    expect(store.search([1, 0.1], { filter: (c) => c.path.startsWith('other/') }).map((h) => h.chunk.id)).toEqual(['y']);
    expect(store.search([1, 0], { minScore: 0.5 }).map((h) => h.chunk.id)).toEqual(['x', 'xy']);
    const [top] = store.search([1, 0]);
    expect(top.score).toBeCloseTo(1);
  });

  test('存成文件再读回来；建索引的模型换了，就当作空的', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'day17-store-')), 'sub', 'index.json');
    const store = createVectorStore('model-a');
    store.add([{ chunk: chunk('x'), vector: [1, 0] }]);
    store.hashes.set('a.md', 'h1');
    await store.save(file);
    const loaded = await loadVectorStore(file, 'model-a');
    expect(loaded.size).toBe(1);
    expect(loaded.hashes.get('a.md')).toBe('h1');
    expect((await loadVectorStore(file, 'model-b')).size).toBe(0);
    expect((await loadVectorStore(join(tmpdir(), 'no-such-day17.json'), 'm')).size).toBe(0);
  });
});
