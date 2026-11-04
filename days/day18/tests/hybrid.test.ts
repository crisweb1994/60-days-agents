import { describe, expect, test } from 'vitest';
import { loadTarget, setupModel } from '#testing';
import { buildIndex } from './helpers.ts';

await setupModel();
const { reciprocalRankFusion } = await loadTarget<typeof import('../solution/rag/hybrid.ts')>(import.meta.url, 'rag/hybrid.ts');
const hit = (id: string, score = 0) => ({ chunk: { id, path: `${id}.md`, heading: '', text: id }, score });

describe('第 18 天：RRF 融合（TODO 2）', () => {
  test('每份排名里得 1/(k+名次) 分，加起来排序', () => {
    const fused = reciprocalRankFusion([[hit('a', 0.9), hit('b', 0.8)], [hit('b', 15), hit('c', 9)]], 60);
    expect(fused.map((h) => h.chunk.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(fused[1].score).toBeCloseTo(1 / 61);
  });

  test('只看名次，不看原来的分数', () => {
    const fused = reciprocalRankFusion([[hit('a', 0.01)], [hit('b', 1000)]]);
    expect(fused[0].score).toBeCloseTo(fused[1].score);
  });
});

test('createRetriever：三种方式都能用；精确的编号用关键词检索排第一', async () => {
  const { retriever } = await buildIndex(import.meta.url);
  const keyword = await retriever.search('TIDE_E2077', { mode: 'keyword', k: 3 });
  expect(keyword[0].chunk.path).toBe('ops/errors.md');
  expect(await retriever.search('握手', { mode: 'vector', k: 2 })).toHaveLength(2);
  const hybrid = await retriever.search('handshake.retries 默认值', { mode: 'hybrid', k: 3 });
  expect(hybrid[0].chunk.path).toBe('guide/config.md');
});
