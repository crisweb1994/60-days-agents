// 第 18 天：重排。第一轮检索为了快，用的是很粗的办法（向量的夹角、词的计数），取出 20 个候选；
// 再用一个更准、更慢的办法把这 20 个重新排一下，只留最好的几个。
// 两种做法：专门的重排模型（rerank 接口），或者直接让对话模型来排。
import type { Model } from '../types.ts';
import type { SearchHit } from './vector-store.ts';

export interface Reranker {
  rerank(query: string, hits: SearchHit[], topN: number, options?: { signal?: AbortSignal }): Promise<SearchHit[]>;
}

export const RERANK_PROMPT = `你负责给检索结果排序。用户会给出一个问题和几段编号的资料。
按照每段资料对回答这个问题有多大帮助，从最有帮助到最没帮助排序，只输出 JSON，比如 {"ranking":[3,1,2]}。
完全无关的资料不要放进 ranking。`;

/** 从模型的回复里找出 JSON 对象。模型有时会在 JSON 前后加几句话，或者包在 ```json 代码块里 */
export function extractJSON(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('回复里没有 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * 按模型给的排名重排。ranking 里的编号从 1 开始；重复的、超出范围的编号忽略。
 * 模型认为无关、没有放进 ranking 的结果不要了。解析失败时退回原来的顺序：重排是锦上添花，不能因为它出错就没有结果
 */
export function applyRanking(hits: SearchHit[], reply: string, topN: number): SearchHit[] {
  let ranking: unknown;
  try {
    ranking = (extractJSON(reply) as { ranking?: unknown }).ranking;
  } catch {
    return hits.slice(0, topN);
  }
  if (!Array.isArray(ranking)) return hits.slice(0, topN);
  const seen = new Set<number>();
  const result: SearchHit[] = [];
  for (const n of ranking) {
    if (!Number.isInteger(n) || n < 1 || n > hits.length || seen.has(n)) continue;
    seen.add(n);
    result.push(hits[n - 1]);
  }
  return result.slice(0, topN);
}

/** 让对话模型来排。每段资料截到 600 个字符，免得候选一多就超出上下文 */
export function createLLMReranker(model: Model): Reranker {
  return {
    async rerank(query, hits, topN, { signal } = {}) {
      if (hits.length <= 1) return hits.slice(0, topN);
      const passages = hits.map((hit, i) => `[${i + 1}] ${hit.chunk.heading}\n${hit.chunk.text.slice(0, 600)}`).join('\n\n');
      const result = await model.chat(
        {
          messages: [
            { role: 'system', content: RERANK_PROMPT },
            { role: 'user', content: `问题：${query}\n\n资料：\n${passages}` },
          ],
          temperature: 0,
        },
        { signal },
      );
      return applyRanking(hits, result.message.content ?? '', topN);
    },
  };
}

export interface RerankAPIConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * 专门的重排模型。不少服务提供格式相近的 POST /rerank：
 * { model, query, documents: [文字……], top_n } → { results: [{ index, relevance_score }] }
 */
export function createAPIReranker({ baseURL, apiKey, model }: RerankAPIConfig): Reranker {
  return {
    async rerank(query, hits, topN, { signal } = {}) {
      const res = await fetch(`${baseURL}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, query, documents: hits.map((h) => h.chunk.text), top_n: topN }),
        signal,
      });
      if (!res.ok) throw new Error(`重排接口出错：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { results: { index: number; relevance_score: number }[] };
      return data.results
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, topN)
        .map((r) => ({ chunk: hits[r.index].chunk, score: r.relevance_score }));
    },
  };
}
