import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterAll, describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { applyRanking, createAPIReranker, createLLMReranker, extractJSON } = await loadTarget<typeof import('../solution/rag/rerank.ts')>(
  import.meta.url,
  'rag/rerank.ts',
);
const { rewriteQuery } = await loadTarget<typeof import('../solution/rag/rewrite.ts')>(import.meta.url, 'rag/rewrite.ts');
const { createScriptedModel } = await loadTarget<typeof import('../solution/testing/scripted-model.ts')>(
  import.meta.url,
  'testing/scripted-model.ts',
);
const hits = ['a', 'b', 'c', 'd'].map((id, i) => ({ chunk: { id, path: `${id}.md`, heading: id, text: `内容 ${id}` }, score: 1 - i / 10 }));

describe('第 18 天：让模型重排（TODO 3）', () => {
  test('extractJSON：JSON 前后有别的文字、包在代码块里，都能找出来', () => {
    expect(extractJSON('好的，结果是：\n```json\n{"ranking":[2,1]}\n```')).toEqual({ ranking: [2, 1] });
    expect(() => extractJSON('没有 JSON')).toThrow();
  });

  test('applyRanking：按模型给的编号（从 1 开始）重排，没放进 ranking 的不要，最多 topN 个', () => {
    expect(applyRanking(hits, '{"ranking":[3,1]}', 3).map((h) => h.chunk.id)).toEqual(['c', 'a']);
    expect(applyRanking(hits, '{"ranking":[4,3,2,1]}', 2).map((h) => h.chunk.id)).toEqual(['d', 'c']);
  });

  test('applyRanking：重复的、超出范围的、不是整数的编号忽略', () => {
    expect(applyRanking(hits, '{"ranking":[2,2,9,0,1.5,"1",4]}', 5).map((h) => h.chunk.id)).toEqual(['b', 'd']);
  });

  test('applyRanking：解析不了，退回原来的顺序', () => {
    expect(applyRanking(hits, '我觉得第三个最好', 2).map((h) => h.chunk.id)).toEqual(['a', 'b']);
    expect(applyRanking(hits, '{"order":[3]}', 2).map((h) => h.chunk.id)).toEqual(['a', 'b']);
  });

  test('createLLMReranker：把问题和编号的资料发给模型，temperature 为 0', async () => {
    const model = createScriptedModel([{ text: '{"ranking":[4]}' }]);
    const result = await createLLMReranker(model).rerank('问题', hits, 2);
    expect(result.map((h) => h.chunk.id)).toEqual(['d']);
    expect(model.requests[0].temperature).toBe(0);
    expect(model.requests[0].messages[1].content).toContain('[4] d\n内容 d');
  });
});

describe('第 18 天：重排接口和查询改写', () => {
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await text(req));
    const results = body.documents.map((_: string, index: number) => ({ index, relevance_score: index / 10 }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results }));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('createAPIReranker：按 relevance_score 从高到低', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const reranker = createAPIReranker({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'k', model: 'm' });
    expect((await reranker.rerank('q', hits, 2)).map((h) => h.chunk.id)).toEqual(['d', 'c']);
  });

  test('rewriteQuery：原来的问题排第一，加上改写的查询；格式不对时只用原来的问题', async () => {
    const model = createScriptedModel([{ text: '{"queries":["故障 应急 回滚","值班手册"]}' }, { text: '改写不了' }]);
    expect(await rewriteQuery(model, '半夜出事了咋办')).toEqual(['半夜出事了咋办', '故障 应急 回滚', '值班手册']);
    expect(await rewriteQuery(model, '你好')).toEqual(['你好']);
  });
});
