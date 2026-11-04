import { fileURLToPath } from 'node:url';
import { loadTarget } from '#testing';

export const DOCS_ROOT = fileURLToPath(new URL('../data/docs', import.meta.url));

/** 用 EMBEDDING_* 配置的模型给 data/docs 建索引。mock 模式下是 mock 的 embedding */
export async function buildIndex(testFileUrl: string) {
  const { createOpenAIEmbedder, embeddingConfigFromEnv } = await loadTarget<typeof import('../solution/rag/embeddings.ts')>(testFileUrl, 'rag/embeddings.ts');
  const { createVectorStore } = await loadTarget<typeof import('../solution/rag/vector-store.ts')>(testFileUrl, 'rag/vector-store.ts');
  const { indexDirectory } = await loadTarget<typeof import('../solution/rag/indexer.ts')>(testFileUrl, 'rag/indexer.ts');
  const { createRetriever } = await loadTarget<typeof import('../solution/rag/hybrid.ts')>(testFileUrl, 'rag/hybrid.ts');
  const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
  const store = createVectorStore(embedder.name);
  await indexDirectory({ root: DOCS_ROOT, store, embedder });
  return { store, embedder, retriever: createRetriever(store, embedder) };
}
