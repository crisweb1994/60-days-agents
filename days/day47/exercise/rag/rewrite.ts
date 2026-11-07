// 第 18 天：查询改写。用户的问题常常不是好的检索词：太口语（「半夜出事了咋办」）、带着指代（「它的端口是多少」），
// 或者一个问题里包含好几件事。让模型先把问题改写成几个检索词，分别检索，再把结果融合起来。
import type { Model } from '../types.ts';
import { reciprocalRankFusion, type Retriever, type SearchMode } from './hybrid.ts';
import { extractJSON } from './rerank.ts';
import type { SearchHit } from './vector-store.ts';

export const REWRITE_PROMPT = `把用户的问题改写成适合在技术文档里检索的查询。
- 写出 2 到 3 个查询，用文档里可能出现的说法，比如把「半夜出事」改成「故障 应急 回滚」
- 有指代的（它、这个）要换成具体的名字；一个问题问了几件事，就拆成几个查询
只输出 JSON，比如 {"queries":["查询一","查询二"]}`;

/** 改写成几个查询。原来的问题总是排在第一个；模型出错或者格式不对时，就只用原来的问题 */
export async function rewriteQuery(model: Model, question: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
  try {
    const result = await model.chat(
      { messages: [{ role: 'system', content: REWRITE_PROMPT }, { role: 'user', content: question }], temperature: 0 },
      options,
    );
    const { queries } = extractJSON(result.message.content ?? '') as { queries?: unknown };
    const extra = Array.isArray(queries) ? queries.filter((q): q is string => typeof q === 'string' && q.trim() !== '') : [];
    return [...new Set([question, ...extra.map((q) => q.trim())])].slice(0, 4);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return [question];
  }
}

/** 每个查询分别检索，用 RRF 融合 */
export async function multiQuerySearch(retriever: Retriever, queries: string[], options: { mode?: SearchMode; k?: number } = {}): Promise<SearchHit[]> {
  const k = options.k ?? 5;
  const rankings = await Promise.all(queries.map((q) => retriever.search(q, { ...options, k: k * 2 })));
  return reciprocalRankFusion(rankings).slice(0, k);
}
