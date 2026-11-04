// 第 17 天：给一个文档目录建索引，并实现 top-k 检索。
// 建索引是增量的：文档没改过就跳过，改过的重建，删掉的从索引里删掉。embedding 要花钱，没必要每次都全部重算。
// 第 17 天的练习：TODO 4 在这里。检查：npm run check 17
// 运行：
//   node days/day17/exercise/rag/indexer.ts index <文档目录>     建索引，存到 <文档目录>/.rag/index.json
//   node days/day17/exercise/rag/indexer.ts search <文档目录> <问题>
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { chunkMarkdown, embeddingText, type ChunkOptions } from './chunk.ts';
import type { Embedder } from './embeddings.ts';
import type { SearchHit, SearchOptions, VectorStore } from './vector-store.ts';

/** 默认建索引的文件类型 */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.txt'];

export interface IndexOptions extends ChunkOptions {
  root: string;
  store: VectorStore;
  embedder: Embedder;
  extensions?: string[];
  signal?: AbortSignal;
}

export interface IndexStats {
  added: number;
  updated: number;
  removed: number;
  /** 没改过、跳过的文档 */
  skipped: number;
  /** 这次新做了 embedding 的块数 */
  embedded: number;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 列出目录里要建索引的文件，路径用 / 分隔、按字母排序。以 . 开头的目录（.git、.rag）跳过 */
export async function listDocs(root: string, extensions = DOC_EXTENSIONS): Promise<string[]> {
  const files = await readdir(root, { recursive: true });
  return files
    .map((file) => file.split(sep).join('/'))
    .filter((file) => extensions.includes(extname(file).toLowerCase()) && !file.split('/').some((part) => part.startsWith('.')))
    .sort();
}

/** 增量地建索引 */
export async function indexDirectory(options: IndexOptions): Promise<IndexStats> {
  const { root, store, embedder, extensions, signal, ...chunkOptions } = options;
  const stats: IndexStats = { added: 0, updated: 0, removed: 0, skipped: 0, embedded: 0 };
  const docs = await listDocs(root, extensions);

  // TODO 4：增量地建索引。
  // - 索引里有（store.hashes 里有）、目录里已经没有的文档：store.removePath，removed 加一
  // - 目录里的每篇文档：读出内容，算 sha256。和 store.hashes 里记的一样：skipped 加一，跳过
  // - 新的或者改过的：用 chunkMarkdown 切块（带上 chunkOptions），用 embedder.embed 给每块的 embeddingText 做 embedding。
  //   一定要先算出向量，再删旧的块：embedding 出错时，索引里还是旧的、能用的内容
  // - 然后删掉旧的块（改过的才有），加上新的块，记下新的哈希；embedded 加上块数，新文档 added 加一，改过的 updated 加一
  void sha256;
  void readFile;
  void join;
  void chunkMarkdown;
  void embeddingText;
  void signal;
  void chunkOptions;
  void docs;
  return stats;
}

/** top-k 检索：把问题转成向量，找出最相似的几块 */
export async function retrieve(question: string, store: VectorStore, embedder: Embedder, options: SearchOptions = {}): Promise<SearchHit[]> {
  const [vector] = await embedder.embed([question]);
  return store.search(vector, options);
}

/** 检索结果写成给模型看的文字：每块标明出处和相似度 */
export function formatHits(hits: SearchHit[]): string {
  return hits
    .map((hit, i) => `[${i + 1}] ${hit.chunk.path}${hit.chunk.heading ? ` · ${hit.chunk.heading}` : ''}（相似度 ${hit.score.toFixed(2)}）\n${hit.chunk.text}`)
    .join('\n\n');
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { createOpenAIEmbedder, embeddingConfigFromEnv } = await import('./embeddings.ts');
  const { loadVectorStore } = await import('./vector-store.ts');
  const [command, root, ...rest] = process.argv.slice(2);
  if (!command || !root || (command === 'search' && rest.length === 0)) {
    console.error('用法：indexer.ts index <文档目录>  或  indexer.ts search <文档目录> <问题>');
    process.exit(1);
  }
  const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
  const file = join(root, '.rag', 'index.json');
  const store = await loadVectorStore(file, embedder.name);
  if (command === 'index') {
    const stats = await indexDirectory({ root, store, embedder });
    await store.save(file);
    console.log(`新增 ${stats.added} 篇，更新 ${stats.updated} 篇，删除 ${stats.removed} 篇，跳过 ${stats.skipped} 篇；这次做了 ${stats.embedded} 块的 embedding，索引里一共 ${store.size} 块`);
  } else {
    console.log(formatHits(await retrieve(rest.join(' '), store, embedder, { k: 5 })));
  }
}
