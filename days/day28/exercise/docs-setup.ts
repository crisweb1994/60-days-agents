// 第 20 天：启动时给本地文档建索引。目录由环境变量 DOCS_DIR 指定，索引存在 <目录>/.rag/index.json，增量更新（第 17 天）。
import { join, resolve } from 'node:path';
import { createOpenAIEmbedder, embeddingConfigFromEnv } from './rag/embeddings.ts';
import { createRetriever, type Retriever } from './rag/hybrid.ts';
import { indexDirectory } from './rag/indexer.ts';
import { loadVectorStore } from './rag/vector-store.ts';

/** 没有配置 DOCS_DIR 就返回 undefined：研究助手照样能用，只是不能查本地文档 */
export async function loadDocs(dir: string | undefined, log: (text: string) => void = console.error): Promise<{ root: string; retriever: Retriever } | undefined> {
  if (!dir) return undefined;
  const root = resolve(dir);
  const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
  const file = join(root, '.rag', 'index.json');
  const store = await loadVectorStore(file, embedder.name);
  const stats = await indexDirectory({ root, store, embedder });
  await store.save(file);
  log(`本地文档 ${root}：${store.size} 块（新增 ${stats.added} 篇，更新 ${stats.updated} 篇，删除 ${stats.removed} 篇）`);
  return { root, retriever: createRetriever(store, embedder) };
}
