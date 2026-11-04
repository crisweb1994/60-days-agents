import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterAll, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, mockEmbedding, setupModel } from '#testing';

const llm = await setupModel();
const { createOpenAIEmbedder, embeddingConfigFromEnv } = await loadTarget<typeof import('../solution/rag/embeddings.ts')>(
  import.meta.url,
  'rag/embeddings.ts',
);
const { cosine } = await loadTarget<typeof import('../solution/rag/vector-store.ts')>(import.meta.url, 'rag/vector-store.ts');

// 一个把结果倒着返回的服务：真实接口不保证 data 的顺序和 input 一样
const reversed = createServer(async (req, res) => {
  const body = JSON.parse(await text(req));
  const data = body.input.map((input: string, index: number) => ({ index, embedding: mockEmbedding(input, 8) })).reverse();
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
});
await new Promise<void>((resolve) => reversed.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise<void>((resolve) => reversed.close(() => resolve())));

test('embeddingConfigFromEnv：地址和 Key 可以沿用 OPENAI_*，模型名必须填', () => {
  expect(embeddingConfigFromEnv({ OPENAI_BASE_URL: 'u', OPENAI_API_KEY: 'k', EMBEDDING_MODEL: 'm' })).toMatchObject({ baseURL: 'u', apiKey: 'k', model: 'm' });
  expect(() => embeddingConfigFromEnv({ OPENAI_BASE_URL: 'u', OPENAI_API_KEY: 'k' })).toThrow('EMBEDDING_MODEL');
});

describeMock('第 17 天：调用 embedding 接口（TODO 1）', () => {
  test('分批发送：40 条、每批 16 条，发 3 次请求；结果的顺序和输入一致', async () => {
    const embedder = createOpenAIEmbedder({ ...embeddingConfigFromEnv(), batchSize: 16 });
    const texts = Array.from({ length: 40 }, (_, i) => `第 ${i} 段文字`);
    const vectors = await embedder.embed(texts);
    expect(llm.embeddingRequests.map((r) => (r.input as string[]).length)).toEqual([16, 16, 8]);
    expect(vectors).toHaveLength(40);
    expect(vectors[39]).toEqual(mockEmbedding('第 39 段文字'));
  });

  test('接口返回的顺序和输入不一样时，按 index 放回去', async () => {
    const port = (reversed.address() as AddressInfo).port;
    const embedder = createOpenAIEmbedder({ baseURL: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' });
    const vectors = await embedder.embed(['甲', '乙', '丙']);
    expect(vectors).toEqual(['甲', '乙', '丙'].map((t) => mockEmbedding(t, 8)));
  });

  test('有空文字：发请求之前就报错，说明是第几条', async () => {
    const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
    await expect(embedder.embed(['有内容', '  '])).rejects.toThrow('第 2 条');
    expect(llm.embeddingRequests).toHaveLength(0);
  });

  test('接口报错：抛出 ModelError，带上接口的说明', async () => {
    const embedder = createOpenAIEmbedder({ ...embeddingConfigFromEnv(), batchSize: 64 });
    await expect(embedder.embed(Array.from({ length: 40 }, (_, i) => `段落 ${i}`))).rejects.toThrow('分批');
  });
});

describeE2E('第 17 天：真实的 embedding 模型', () => {
  test('意思相近的句子，相似度更高', async () => {
    const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
    const [a, b, c] = await embedder.embed(['怎么把服务部署上线？', '上线的步骤是什么', '番茄炒蛋怎么做']);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});
