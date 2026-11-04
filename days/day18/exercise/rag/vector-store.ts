// 第 17 天：一个最简单的向量库。全部存在内存里，检索时把查询向量和每一块都比一遍（暴力检索），可以存成 JSON 文件。
// 几万块以内，暴力检索只要几毫秒，完全够用。更大的规模再换成嵌入式的向量库（sqlite-vec、LanceDB），
// 或者第五阶段的 pgvector：它们用近似最近邻索引，用一点点准确率换来快得多的速度。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Chunk } from './chunk.ts';

export interface VectorRecord {
  chunk: Chunk;
  vector: number[];
}

export interface SearchHit {
  chunk: Chunk;
  /** 余弦相似度，-1 到 1，越大越相似 */
  score: number;
}

export interface SearchOptions {
  /** 返回最相似的几块，默认 5 */
  k?: number;
  /** 只在满足条件的块里找，比如只找某个目录下的文档 */
  filter?: (chunk: Chunk) => boolean;
  /** 相似度低于这个值的不要，默认不限制 */
  minScore?: number;
}

/** 余弦相似度：两个向量夹角的余弦。只看方向，不看长短 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`向量的维数不一样：${a.length} 和 ${b.length}。是不是换了 embedding 模型，没有重建索引？`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/** 存进文件里的样子。记下 embedding 模型：换了模型，旧的向量就不能用了 */
interface StoreFile {
  version: 1;
  embedder: string;
  /** 每个文档内容的哈希，用来判断文档有没有改过（indexer.ts） */
  hashes: Record<string, string>;
  records: VectorRecord[];
}

export interface VectorStore {
  /** 建索引用的 embedding 模型的名字 */
  readonly embedder: string;
  /** 每个文档的内容哈希 */
  readonly hashes: Map<string, string>;
  readonly size: number;
  add(records: VectorRecord[]): void;
  /** 删掉某个文档的所有块 */
  removePath(path: string): void;
  paths(): string[];
  /** 所有的块，第 18 天用它建关键词索引 */
  chunks(): Chunk[];
  search(query: number[], options?: SearchOptions): SearchHit[];
  save(file: string): Promise<void>;
}

export function createVectorStore(embedder: string): VectorStore {
  return fromData({ version: 1, embedder, hashes: {}, records: [] });
}

function fromData(data: StoreFile): VectorStore {
  let records = data.records;
  const hashes = new Map(Object.entries(data.hashes));
  return {
    embedder: data.embedder,
    hashes,
    get size() {
      return records.length;
    },
    add(items) {
      records.push(...items);
    },
    removePath(path) {
      records = records.filter((r) => r.chunk.path !== path);
      hashes.delete(path);
    },
    paths() {
      return [...new Set(records.map((r) => r.chunk.path))];
    },
    chunks() {
      return records.map((r) => r.chunk);
    },
    search(query, { k = 5, filter, minScore = -Infinity } = {}) {
      const hits: SearchHit[] = [];
      for (const record of records) {
        if (filter && !filter(record.chunk)) continue;
        const score = cosine(query, record.vector);
        if (score >= minScore) hits.push({ chunk: record.chunk, score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, k);
    },
    async save(file) {
      await mkdir(dirname(file), { recursive: true });
      const out: StoreFile = { version: 1, embedder: data.embedder, hashes: Object.fromEntries(hashes), records };
      await writeFile(file, JSON.stringify(out));
    },
  };
}

/** 从文件读出向量库。文件不存在就返回一个空的；建索引用的模型和现在的不一样，也返回空的，需要重建 */
export async function loadVectorStore(file: string, embedder: string): Promise<VectorStore> {
  let data: StoreFile;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createVectorStore(embedder);
    throw new Error(`索引文件 ${file} 坏了：${(error as Error).message}。删掉它重新建索引`);
  }
  if (data.embedder !== embedder) return createVectorStore(embedder);
  return fromData(data);
}
