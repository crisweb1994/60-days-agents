import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { tokenize, createBM25Index } = await loadTarget<typeof import('../solution/rag/bm25.ts')>(import.meta.url, 'rag/bm25.ts');
const chunk = (id: string, text: string) => ({ id, path: `${id}.md`, heading: '', text });

describe('第 18 天：关键词检索（TODO 1）', () => {
  test('tokenize：中文按词切，英文转小写，标点和空白不要；编号保持完整', () => {
    expect(tokenize('TIDE_E2077 是什么？')).toEqual(['tide_e2077', '是', '什么']);
    expect(tokenize('handshake.retries 默认 3 次'), '点连起来的配置项也是一个词').toEqual(['handshake.retries', '默认', '3', '次']);
    expect(tokenize('向量检索和关键词检索')).toContain('检索');
  });

  test('包含查询词的块才有分数，按分数从高到低排', () => {
    const index = createBM25Index([chunk('a', '握手 重试'), chunk('b', '证书 过期'), chunk('c', '握手 握手 超时')]);
    const hits = index.search('握手', 5);
    expect(hits.map((h) => h.chunk.id)).toEqual(['c', 'a']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(index.search('量子', 5)).toEqual([]);
  });

  test('越少见的词越重要：只有一块里有的词，比每块都有的词分量重', () => {
    const index = createBM25Index([chunk('a', '网关 熔断'), chunk('b', '网关 部署'), chunk('c', '网关 配置')]);
    const [top] = index.search('网关 熔断', 3);
    expect(top.chunk.id).toBe('a');
    const common = index.search('网关', 3);
    expect(common[0].score, '每块都有的词分数很低').toBeLessThan(top.score / 2);
  });

  test('一样的词频，短的块分数更高', () => {
    const index = createBM25Index([chunk('long', `证书 ${'其他内容 '.repeat(30)}`), chunk('short', '证书 轮换')]);
    expect(index.search('证书', 2).map((h) => h.chunk.id)).toEqual(['short', 'long']);
  });

  test('路径和标题里的词也算', () => {
    const index = createBM25Index([{ id: 'x', path: 'ops/oncall.md', heading: '值班手册', text: '先看监控' }]);
    expect(index.search('值班', 1)).toHaveLength(1);
  });
});
