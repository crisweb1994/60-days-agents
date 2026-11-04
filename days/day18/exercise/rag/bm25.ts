// 第 18 天：关键词检索。BM25 是搜索引擎用了几十年的打分公式：
// 一个词在这一块里出现得越多、在所有块里越少见，这一块的分数就越高；块越长，每次出现的分量越轻。
// 它不懂意思，但对精确的名字、编号、配置项（TIDE_E2077、handshake.retries）非常准，正好补上向量检索的短板。
// 第 18 天的练习：TODO 1 在这里，TODO 2 在 hybrid.ts，TODO 3 在 rerank.ts，TODO 4 在 tools/docs.ts，TODO 5 在 eval.ts。检查：npm run check 18
import { embeddingText, type Chunk } from './chunk.ts';
import type { SearchHit } from './vector-store.ts';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * 分词：中文按词切（Intl.Segmenter 自带中文词典），英文按单词切，都转成小写；标点和空白不要。
 * 「TIDE_E2077 是什么」→ ['tide_e2077', '是', '什么']
 */
export function tokenize(text: string): string[] {
  // TODO 1（一）：先转成小写，再用 segmenter.segment() 切分。每一段有 segment（文字）和 isWordLike（是不是一个词）：
  // 只留下 isWordLike 为 true 的，标点和空白都不要
  void segmenter;
  return text.toLowerCase().split(/\s+/).filter(Boolean);
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
      // TODO 1（二）：BM25 打分。查询分词、去重以后，对每一块累加每个查询词的分数：
      //   idf(词) × tf × (k1 + 1) / (tf + k1 × (1 - b + b × 块长 / 平均块长))
      // tf 是这个词在这一块里出现的次数，没出现就不加分。分数大于 0 的块按分数从高到低排，返回前 k 个
      void idf;
      void avgLength;
      void k1;
      void b;
      return docs.filter((doc) => tokenize(query).some((t) => doc.tf.has(t))).slice(0, k).map((doc) => ({ chunk: doc.chunk, score: 1 }));
    },
  };
}
