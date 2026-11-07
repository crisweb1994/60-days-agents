// 第 18 天：比较几种检索方式。用一个小型问答集，每个问题都知道答案在哪一块，算两个指标：
// - recall@k：答案所在的块出现在前 k 个结果里的比例。检索的第一要务是「找得到」
// - MRR：答案所在的块排第几，取倒数再平均。排第一得 1 分，第二得 0.5 分，前 k 个里没有得 0 分
// 运行（需要 embedding 模型，最后一部分还需要对话模型）：node days/day18/solution/rag/eval.ts
import type { SearchHit } from './vector-store.ts';

export interface RelevantChunk {
  path: string;
  /** 标题路径的最后一段 */
  heading: string;
  kind?: string;
}

export interface RetrievalScore {
  recall: number;
  mrr: number;
  /** 每一类问题的 recall@k */
  byKind: Record<string, number>;
}

/** 一个结果是不是答案所在的块：路径一样，标题路径的最后一段一样 */
export function isRelevant(hit: SearchHit, target: RelevantChunk): boolean {
  return hit.chunk.path === target.path && (hit.chunk.heading.split(' > ').at(-1) ?? '') === target.heading;
}

export async function evaluateRetrieval<Q extends RelevantChunk & { question: string }>(
  questions: Q[],
  search: (question: string) => Promise<SearchHit[]>,
  k = 3,
): Promise<RetrievalScore> {
  let found = 0;
  let reciprocal = 0;
  const kinds = new Map<string, { total: number; found: number }>();
  for (const q of questions) {
    const hits = (await search(q.question)).slice(0, k);
    const rank = hits.findIndex((hit) => isRelevant(hit, q)) + 1;
    const kind = kinds.get(q.kind ?? '全部') ?? { total: 0, found: 0 };
    kind.total++;
    if (rank > 0) {
      found++;
      reciprocal += 1 / rank;
      kind.found++;
    }
    kinds.set(q.kind ?? '全部', kind);
  }
  const n = questions.length || 1;
  return {
    recall: found / n,
    mrr: reciprocal / n,
    byKind: Object.fromEntries([...kinds].map(([name, v]) => [name, v.found / v.total])),
  };
}

/** 几种方式的结果列成一张表 */
export function formatScores(rows: { name: string; score: RetrievalScore }[], k: number): string {
  const kinds = Object.keys(rows[0]?.score.byKind ?? {});
  const header = `| 方式 | recall@${k} | MRR | ${kinds.map((kind) => `${kind}`).join(' | ')} |`;
  const divider = `|---|---|---|${kinds.map(() => '---').join('|')}|`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = rows.map(({ name, score }) => `| ${name} | ${pct(score.recall)} | ${score.mrr.toFixed(2)} | ${kinds.map((kind) => pct(score.byKind[kind])).join(' | ')} |`);
  return [header, divider, ...lines].join('\n');
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { fileURLToPath } = await import('node:url');
  const { QA_SET } = await import('../../data/qa.ts');
  const { createOpenAIEmbedder, embeddingConfigFromEnv } = await import('./embeddings.ts');
  const { createVectorStore } = await import('./vector-store.ts');
  const { indexDirectory } = await import('./indexer.ts');
  const { createRetriever } = await import('./hybrid.ts');
  const { createLLMReranker } = await import('./rerank.ts');
  const { rewriteQuery, multiQuerySearch } = await import('./rewrite.ts');
  const { createModel, providerFromEnv } = await import('../providers.ts');

  const root = fileURLToPath(new URL('../../data/docs', import.meta.url));
  const embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
  const store = createVectorStore(embedder.name);
  await indexDirectory({ root, store, embedder });
  const retriever = createRetriever(store, embedder);
  const model = createModel(providerFromEnv());
  const reranker = createLLMReranker(model);
  const k = 3;
  const rows = [
    { name: '向量', score: await evaluateRetrieval(QA_SET, (q) => retriever.search(q, { mode: 'vector', k }), k) },
    { name: '关键词', score: await evaluateRetrieval(QA_SET, (q) => retriever.search(q, { mode: 'keyword', k }), k) },
    { name: '混合', score: await evaluateRetrieval(QA_SET, (q) => retriever.search(q, { mode: 'hybrid', k }), k) },
    {
      name: '混合 + 重排',
      score: await evaluateRetrieval(QA_SET, async (q) => reranker.rerank(q, await retriever.search(q, { k: 12 }), k), k),
    },
    {
      name: '改写 + 混合',
      score: await evaluateRetrieval(QA_SET, async (q) => multiQuerySearch(retriever, await rewriteQuery(model, q), { k }), k),
    },
  ];
  console.log(`${embedder.name}，${QA_SET.length} 个问题\n\n${formatScores(rows, k)}`);
}
