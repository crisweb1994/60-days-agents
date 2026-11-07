// 第 31 天：评估用的环境。假互联网（data/web.ts）加上本地文档（data/docs/）的索引，每条用例一个新的工作目录。
// 评估集里的答案只在这两个地方：环境固定，两次评估的分数才能比较。真实的搜索 API 结果每天在变，适合线上监控，不适合回归评估。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_KEY, startWebServer, type WebServer } from '../../data/web.ts';
import { createOpenAIEmbedder, embeddingConfigFromEnv, type Embedder } from '../rag/embeddings.ts';
import { createRetriever } from '../rag/hybrid.ts';
import { indexDirectory } from '../rag/indexer.ts';
import { createVectorStore } from '../rag/vector-store.ts';
import type { ResearchSetup } from '../research.ts';
import { createTavilySearch } from '../search.ts';

export const DOCS_ROOT = fileURLToPath(new URL('../../data/docs', import.meta.url));
export const DATASET_FILE = fileURLToPath(new URL('../../data/eval/research.jsonl', import.meta.url));

export interface EvalEnv {
  web: WebServer;
  /** 每次调用都返回一套新的配置：新的工作目录、新的来源登记。本地文档的索引共用，只建一次 */
  makeSetup(): Promise<ResearchSetup>;
  /** 关掉假互联网，删掉临时目录 */
  close(): Promise<void>;
}

export async function startEvalEnv(options: { embedder?: Embedder; docsRoot?: string } = {}): Promise<EvalEnv> {
  const { embedder = createOpenAIEmbedder(embeddingConfigFromEnv()), docsRoot = DOCS_ROOT } = options;
  const web = await startWebServer();
  const store = createVectorStore(embedder.name);
  await indexDirectory({ root: docsRoot, store, embedder });
  const docs = { root: docsRoot, retriever: createRetriever(store, embedder) };
  const search = createTavilySearch({ apiKey: API_KEY, baseURL: `${web.base}/tavily` });
  const dirs: string[] = [];
  return {
    web,
    async makeSetup() {
      const workspace = await mkdtemp(join(tmpdir(), 'eval-'));
      dirs.push(workspace);
      // 假互联网在本机，要允许 fetch_page 访问本机地址
      return { workspace, search, docs, fetchOptions: { allowPrivate: true } };
    },
    async close() {
      await web.close();
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
