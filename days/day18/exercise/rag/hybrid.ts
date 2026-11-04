// 第 18 天：混合检索。向量检索懂意思，关键词检索认得精确的词，两种结果合在一起。
// 两种分数的尺度完全不同（余弦相似度在 0 到 1 之间，BM25 可以是 15），不能直接相加，所以按排名来融合：RRF。
// 第 18 天的练习：TODO 2 在这里。检查：npm run check 18
import { createBM25Index, type BM25Index } from './bm25.ts';
import type { Embedder } from './embeddings.ts';
import type { SearchHit, VectorStore } from './vector-store.ts';

/**
 * Reciprocal Rank Fusion：每个结果在每份排名里得 1 / (k + 名次) 分（名次从 1 开始），加起来按总分排序。
 * 在两份排名里都靠前的，总分最高；只在一份里出现的也有分。k 默认 60，让排名靠后的结果也不至于完全没有分量。
 * 返回的 score 是融合后的分数，不再是相似度
 */
export function reciprocalRankFusion(rankings: SearchHit[][], k = 60): SearchHit[] {
  // TODO 2：用 chunk.id 认出同一块。每份排名里第 i 个（从 0 开始）结果得 1 / (k + i + 1) 分，同一块的分数加起来；
  // 返回每块一个 SearchHit，score 是总分，按总分从高到低排
  void k;
  return rankings.flat();
}

export type SearchMode = 'vector' | 'keyword' | 'hybrid';
export const SEARCH_MODES: SearchMode[] = ['vector', 'keyword', 'hybrid'];

export interface Retriever {
  search(query: string, options?: { mode?: SearchMode; k?: number; signal?: AbortSignal }): Promise<SearchHit[]>;
  /** 文档更新以后，重建关键词索引 */
  refresh(): void;
}

/** 三种检索方式放在一起。混合检索时每种各取 k 的 3 倍作为候选，再融合 */
export function createRetriever(store: VectorStore, embedder: Embedder): Retriever {
  let bm25: BM25Index = createBM25Index(store.chunks());
  return {
    refresh() {
      bm25 = createBM25Index(store.chunks());
    },
    async search(query, { mode = 'hybrid', k = 5, signal } = {}) {
      if (mode === 'keyword') return bm25.search(query, k);
      const [vector] = await embedder.embed([query], { signal });
      if (mode === 'vector') return store.search(vector, { k });
      const candidates = k * 3;
      return reciprocalRankFusion([store.search(vector, { k: candidates }), bm25.search(query, candidates)]).slice(0, k);
    },
  };
}
