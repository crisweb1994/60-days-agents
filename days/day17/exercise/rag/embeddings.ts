// 第 17 天：调用 embedding 模型，把文字变成向量。意思相近的文字，向量的方向也相近。
// 大多数服务提供 OpenAI 兼容的 POST /embeddings 接口：{ model, input: [文字……] } → { data: [{ index, embedding }] }。
// 第 17 天的练习：TODO 1 在这里，TODO 2 在 chunk.ts，TODO 3 在 vector-store.ts，TODO 4 在 indexer.ts。检查：npm run check 17
import { toModelError } from '../errors.ts';

export interface Embedder {
  /** 用来显示和记录，比如 openai:text-embedding-v4 */
  readonly name: string;
  /** 把一组文字转成向量，顺序和输入一致 */
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 一次请求最多发几条，默认 16。各家的上限不一样，超出会报错 */
  batchSize?: number;
  /** 向量的维数。有的模型支持指定，不传就用模型的默认值 */
  dimensions?: number;
}

/**
 * 从环境变量读取配置：EMBEDDING_BASE_URL、EMBEDDING_API_KEY、EMBEDDING_MODEL。
 * 地址和 Key 没填时沿用 OPENAI_*：很多模型服务的对话和 embedding 是同一个地址、同一个 Key。模型名必须填
 */
export function embeddingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const baseURL = env.EMBEDDING_BASE_URL || env.OPENAI_BASE_URL;
  const apiKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY;
  const model = env.EMBEDDING_MODEL;
  if (!baseURL || !apiKey || !model) {
    throw new Error('缺少 embedding 的配置：至少要填 EMBEDDING_MODEL，地址和 Key 没填时沿用 OPENAI_BASE_URL、OPENAI_API_KEY');
  }
  const dimensions = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : undefined;
  return { baseURL, apiKey, model, dimensions };
}

type EmbeddingResponse = { data: { index: number; embedding: number[] }[] };

export function createOpenAIEmbedder(config: EmbeddingConfig): Embedder {
  const { baseURL, apiKey, model, batchSize = 16, dimensions } = config;

  async function embedBatch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input, ...(dimensions ? { dimensions } : {}) }),
      signal,
    });
    if (!res.ok) throw await toModelError(res);
    const data = (await res.json()) as EmbeddingResponse;
    // TODO 1（一）：返回的 data 的顺序不一定和 input 一样。按每一项的 index 放回对应的位置；
    // 有位置没有放上向量（接口少返回了），抛出错误，说明返回了几条、请求了几条
    return data.data.map((item) => item.embedding);
  }

  return {
    name: `openai:${model}`,
    async embed(texts, { signal } = {}) {
      // TODO 1（二）：
      // - 有空的文字（去掉空白以后是空的）：不发请求，直接抛出错误，说明是第几条（从 1 开始数）
      // - 每 batchSize 条发一次请求（embedBatch），一批一批地按顺序发，把结果按顺序接起来
      void batchSize;
      return embedBatch(texts, signal);
    },
  };
}
