import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, loadTarget, setupModel } from '#testing';
import { makeDocs } from './docs.ts';

await setupModel();
const { indexDirectory, listDocs, retrieve, formatHits } = await loadTarget<typeof import('../solution/rag/indexer.ts')>(
  import.meta.url,
  'rag/indexer.ts',
);
const { createVectorStore } = await loadTarget<typeof import('../solution/rag/vector-store.ts')>(import.meta.url, 'rag/vector-store.ts');
const { createOpenAIEmbedder, embeddingConfigFromEnv } = await loadTarget<typeof import('../solution/rag/embeddings.ts')>(
  import.meta.url,
  'rag/embeddings.ts',
);

/** 包一层，数一数一共做了多少条 embedding */
function counting() {
  const inner = createOpenAIEmbedder(embeddingConfigFromEnv());
  const counter = {
    count: 0,
    name: inner.name,
    async embed(texts: string[]) {
      counter.count += texts.length;
      return inner.embed(texts);
    },
  };
  return counter;
}

test('listDocs：只列文档类型的文件，跳过 . 开头的目录', async () => {
  const root = await makeDocs();
  expect(await listDocs(root)).toEqual(['faq.md', 'guide/config.md', 'guide/deploy.md', 'notes.txt']);
});

describe('第 17 天：增量建索引（TODO 4）', () => {
  test('第一次全部建；再建一次全部跳过，不再调用 embedding', async () => {
    const root = await makeDocs();
    const embedder = counting();
    const store = createVectorStore(embedder.name);
    const first = await indexDirectory({ root, store, embedder });
    expect(first).toMatchObject({ added: 4, updated: 0, removed: 0, skipped: 0 });
    expect(first.embedded).toBe(store.size);
    expect(store.paths().sort()).toEqual(['faq.md', 'guide/config.md', 'guide/deploy.md', 'notes.txt']);
    const before = embedder.count;
    const second = await indexDirectory({ root, store, embedder });
    expect(second).toMatchObject({ added: 0, skipped: 4, embedded: 0 });
    expect(embedder.count).toBe(before);
  });

  test('改过的文档重建（旧的块删掉），删掉的文档从索引里删掉', async () => {
    const root = await makeDocs();
    const embedder = counting();
    const store = createVectorStore(embedder.name);
    await indexDirectory({ root, store, embedder });
    await writeFile(join(root, 'notes.txt'), '会议记录：端口不改了。');
    await rm(join(root, 'faq.md'));
    const stats = await indexDirectory({ root, store, embedder });
    expect(stats).toMatchObject({ added: 0, updated: 1, removed: 1, skipped: 2, embedded: 1 });
    expect(store.paths()).not.toContain('faq.md');
    const notes = store.search(new Array(256).fill(0.01), { k: 100, filter: (c) => c.path === 'notes.txt' });
    expect(notes.map((h) => h.chunk.text)).toEqual(['会议记录：端口不改了。']);
  });

  test('embedding 出错：这篇文档的旧内容还在索引里', async () => {
    const root = await makeDocs();
    const embedder = counting();
    const store = createVectorStore(embedder.name);
    await indexDirectory({ root, store, embedder });
    await writeFile(join(root, 'notes.txt'), '新的内容');
    const broken = { name: embedder.name, embed: async () => Promise.reject(new Error('网络断了')) };
    await expect(indexDirectory({ root, store, embedder: broken })).rejects.toThrow('网络断了');
    expect(store.search(new Array(256).fill(0.01), { k: 100, filter: (c) => c.path === 'notes.txt' })[0].chunk.text).toContain('8443');
  });

  test('retrieve：top-k 检索，结果带着出处', async () => {
    const root = await makeDocs();
    const embedder = counting();
    const store = createVectorStore(embedder.name);
    await indexDirectory({ root, store, embedder });
    const hits = await retrieve('handshake.retries 默认重试几次', store, embedder, { k: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0].chunk.path).toBe('guide/config.md');
    expect(formatHits(hits)).toMatch(/^\[1\] guide\/config\.md · 配置 > 握手（相似度 0\.\d\d）/);
  });
});

describeE2E('第 17 天：真实的 embedding 模型', () => {
  test('换一种说法提问，也能找到对的文档', async () => {
    const root = await makeDocs();
    const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
    const store = createVectorStore(embedder.name);
    await indexDirectory({ root, store, embedder });
    const hits = await retrieve('服务上线之前需要做哪些准备？', store, embedder, { k: 3 });
    expect(hits.map((h) => h.chunk.heading)).toContain('部署 > 上线前的检查');
  });
});
