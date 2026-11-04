// 第 17 天：一个最简单的向量库。全部存在内存里，检索时把查询向量和每一块都比一遍（暴力检索），可以存成 JSON 文件。
// 几万块以内，暴力检索只要几毫秒，完全够用。更大的规模再换成嵌入式的向量库（sqlite-vec、LanceDB），
// 或者第五阶段的 pgvector：它们用近似最近邻索引，用一点点准确率换来快得多的速度。
// 第 17 天的练习：TODO 3 在这里。检查：npm run check 17
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
  // TODO 3（一）：余弦相似度 = 点积 / (a 的长度 × b 的长度)。
  // - 维数不一样时抛出错误，提醒是不是换了 embedding 模型、没有重建索引
  // - 有一个是零向量（长度为 0）时返回 0，不要除以 0
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
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
    search(query, { k = 5, filter, minScore = -Infinity } = {}) {
      // TODO 3（二）：暴力检索。逐个比较：不满足 filter 的跳过；用 cosine 算相似度，低于 minScore 的不要；
      // 按相似度从高到低排序，返回前 k 个
      void filter;
      void minScore;
      return records.slice(0, k).map((record) => ({ chunk: record.chunk, score: cosine(query, record.vector) }));
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
