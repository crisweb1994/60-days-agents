// 第 18 天：关键词检索。BM25 是搜索引擎用了几十年的打分公式：
// 一个词在这一块里出现得越多、在所有块里越少见，这一块的分数就越高；块越长，每次出现的分量越轻。
// 它不懂意思，但对精确的名字、编号、配置项（TIDE_E2077、handshake.retries）非常准，正好补上向量检索的短板。
import { embeddingText, type Chunk } from './chunk.ts';
import type { SearchHit } from './vector-store.ts';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * 分词：中文按词切（Intl.Segmenter 自带中文词典），英文按单词切，都转成小写；标点和空白不要。
 * 「TIDE_E2077 是什么」→ ['tide_e2077', '是', '什么']
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text.toLowerCase())) {
    if (isWordLike) tokens.push(segment);
  }
  return tokens;
}

export interface BM25Options {
  /** 词频的饱和程度，默认 1.2：一个词出现 10 次，不会比出现 3 次重要太多 */
  k1?: number;
  /** 长度归一化的程度，默认 0.75：0 表示不管块的长短，1 表示完全按长度折算 */
  b?: number;
}

export interface BM25Index {
  readonly size: number;
  search(query: string, k?: number): SearchHit[];
}

/** 给一组块建 BM25 索引。用 embeddingText，路径和标题里的词也算 */
export function createBM25Index(chunks: Chunk[], { k1 = 1.2, b = 0.75 }: BM25Options = {}): BM25Index {
  const docs = chunks.map((chunk) => {
    const tokens = tokenize(embeddingText(chunk));
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { chunk, tf, length: tokens.length };
  });
  // 每个词出现在多少块里
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const N = docs.length;
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (N || 1);
  /** 越少见的词越重要。加 1 再取对数，保证不会是负数 */
  const idf = (token: string) => {
    const n = df.get(token) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  return {
    size: N,
    search(query, k = 5) {
      const terms = [...new Set(tokenize(query))];
      const hits: SearchHit[] = [];
      for (const doc of docs) {
        let score = 0;
        for (const term of terms) {
          const tf = doc.tf.get(term);
          if (!tf) continue;
          score += (idf(term) * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLength));
        }
        if (score > 0) hits.push({ chunk: doc.chunk, score });
      }
      return hits.sort((x, y) => y.score - x.score).slice(0, k);
    },
  };
}
