import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTarget } from '#testing';
import { API_KEY, type Fixture } from './web-fixture.ts';

export const DOCS_ROOT = fileURLToPath(new URL('../data/docs', import.meta.url));

/** 研究助手的全套配置：假的搜索服务、本地文档的索引、临时的记忆目录 */
export async function makeSetup(testFileUrl: string, fixture: Fixture) {
  const { createOpenAIEmbedder, embeddingConfigFromEnv } = await loadTarget<typeof import('../solution/rag/embeddings.ts')>(testFileUrl, 'rag/embeddings.ts');
  const { createVectorStore } = await loadTarget<typeof import('../solution/rag/vector-store.ts')>(testFileUrl, 'rag/vector-store.ts');
  const { indexDirectory } = await loadTarget<typeof import('../solution/rag/indexer.ts')>(testFileUrl, 'rag/indexer.ts');
  const { createRetriever } = await loadTarget<typeof import('../solution/rag/hybrid.ts')>(testFileUrl, 'rag/hybrid.ts');
  const { createTavilySearch } = await loadTarget<typeof import('../solution/search.ts')>(testFileUrl, 'search.ts');
  const { createMemoryStore } = await loadTarget<typeof import('../solution/memory.ts')>(testFileUrl, 'memory.ts');
  const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
  const store = createVectorStore(embedder.name);
  await indexDirectory({ root: DOCS_ROOT, store, embedder });
  const workspace = await mkdtemp(join(tmpdir(), 'day20-'));
  return {
    workspace,
    search: createTavilySearch({ apiKey: API_KEY, baseURL: `${fixture.base}/tavily` }),
    docs: { root: DOCS_ROOT, retriever: createRetriever(store, embedder) },
    memory: createMemoryStore(join(workspace, 'memory')),
    fetchOptions: { allowPrivate: true },
  };
}
