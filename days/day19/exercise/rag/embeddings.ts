// 第 17 天：调用 embedding 模型，把文字变成向量。意思相近的文字，向量的方向也相近。
// 大多数服务提供 OpenAI 兼容的 POST /embeddings 接口：{ model, input: [文字……] } → { data: [{ index, embedding }] }。
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
    const res = await fetch(`${baseURL.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input, ...(dimensions ? { dimensions } : {}) }),
      signal,
    });
    if (!res.ok) throw await toModelError(res);
    const data = (await res.json()) as EmbeddingResponse;
    // 返回的顺序不一定和输入一样，要按 index 放回去
    const vectors = new Array<number[]>(input.length);
    for (const item of data.data) vectors[item.index] = item.embedding;
    if (vectors.some((v) => !v)) throw new Error(`embedding 接口只返回了 ${data.data.length} 条，请求了 ${input.length} 条`);
    return vectors;
  }

  return {
    name: `openai:${model}`,
    async embed(texts, { signal } = {}) {
      const empty = texts.findIndex((t) => !t.trim());
      if (empty !== -1) throw new Error(`第 ${empty + 1} 条文字是空的，空文字不能做 embedding`);
      const vectors: number[][] = [];
      // 一批一批地发：一次发太多会超出接口的上限，一次一条又太慢
      for (let i = 0; i < texts.length; i += batchSize) {
        vectors.push(...(await embedBatch(texts.slice(i, i + batchSize), signal)));
      }
      return vectors;
    },
  };
}
