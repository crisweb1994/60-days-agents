import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { QA_SET } from '../data/qa.ts';
import { buildIndex, DOCS_ROOT } from './helpers.ts';

const llm = await setupModel();
const { evaluateRetrieval, formatScores, isRelevant } = await loadTarget<typeof import('../solution/rag/eval.ts')>(import.meta.url, 'rag/eval.ts');
const { createDocsTools } = await loadTarget<typeof import('../solution/tools/docs.ts')>(import.meta.url, 'tools/docs.ts');
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const hit = (path: string, heading: string) => ({ chunk: { id: path, path, heading, text: '' }, score: 0 });
const questions = [
  { question: '甲', path: 'a.md', heading: 'A', kind: '原词' },
  { question: '乙', path: 'b.md', heading: 'B', kind: '换说法' },
  { question: '丙', path: 'c.md', heading: 'C', kind: '换说法' },
];

describe('第 18 天：比较检索方式（TODO 5）', () => {
  test('isRelevant：路径一样，标题路径的最后一段一样', () => {
    expect(isRelevant(hit('a.md', '总览 > A'), questions[0])).toBe(true);
    expect(isRelevant(hit('a.md', 'A > 别的'), questions[0])).toBe(false);
  });

  test('recall@k 和 MRR：第一题排第 1，第二题排第 2，第三题前 k 个里没有', async () => {
    const results: Record<string, ReturnType<typeof hit>[]> = {
      甲: [hit('a.md', 'A'), hit('x.md', 'X')],
      乙: [hit('x.md', 'X'), hit('b.md', 'B')],
      丙: [hit('x.md', 'X'), hit('y.md', 'Y'), hit('z.md', 'Z'), hit('c.md', 'C')],
    };
    const score = await evaluateRetrieval(questions, async (q) => results[q], 3);
    expect(score.recall).toBeCloseTo(2 / 3);
    expect(score.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(score.byKind).toEqual({ 原词: 1, 换说法: 0.5 });
  });

  test('formatScores：每种方式一行', async () => {
    const score = await evaluateRetrieval(questions, async () => [], 3);
    const table = formatScores([{ name: '向量', score }], 3);
    expect(table).toContain('| 方式 | recall@3 | MRR | 原词 | 换说法 |');
    expect(table).toContain('| 向量 | 0% | 0.00 | 0% | 0% |');
  });

  test('关键词检索找精确的编号最准', async () => {
    const { retriever } = await buildIndex(import.meta.url);
    const ids = QA_SET.filter((q) => q.kind === '编号');
    const score = await evaluateRetrieval(ids, (q) => retriever.search(q, { mode: 'keyword', k: 3 }), 3);
    expect(score.recall).toBe(1);
  });
});

describeMock('第 18 天：Agent 自己决定怎么查', () => {
  test('先 search_docs，再 grep_docs 找编号，最后回答', async () => {
    const { retriever } = await buildIndex(import.meta.url);
    llm
      .reply({ toolCalls: [{ name: 'search_docs', arguments: { query: '熔断 错误码' } }] })
      .reply({ toolCalls: [{ name: 'grep_docs', arguments: { pattern: 'TIDE_E2077' } }] })
      .reply({ content: 'TIDE_E2077 表示熔断已打开。' });
    const result = await runAgent('TIDE_E2077 是什么？', { model: createModel('openai'), tools: createDocsTools({ root: DOCS_ROOT, retriever }) });
    expect(result.answer).toContain('熔断');
    expect(llm.requests[2].messages.at(-1)?.content).toContain('ops/errors.md:');
  });
});

describeE2E('第 18 天：真实模型（需真实模型）', () => {
  test('比较三种检索方式；Agent 用 search_docs 答对大部分问题', { timeout: 600_000 }, async () => {
    const { retriever } = await buildIndex(import.meta.url);
    const rows = [];
    for (const mode of ['vector', 'keyword', 'hybrid'] as const) {
      rows.push({ name: mode, score: await evaluateRetrieval(QA_SET, (q) => retriever.search(q, { mode, k: 3 }), 3) });
    }
    console.log(`\n${formatScores(rows, 3)}`);
    const hybrid = rows[2].score;
    expect(hybrid.recall, '混合检索至少不比两种单独的都差').toBeGreaterThanOrEqual(Math.min(rows[0].score.recall, rows[1].score.recall));

    const tools = createDocsTools({ root: DOCS_ROOT, retriever });
    let correct = 0;
    for (const qa of QA_SET) {
      const result = await runAgent(`${qa.question}请查本地文档后回答。`, { model: createModel('openai'), tools });
      if (result.answer.includes(qa.answer)) correct++;
    }
    console.log(`Agent 答对了 ${correct}/${QA_SET.length}`);
    expect(correct).toBeGreaterThanOrEqual(QA_SET.length - 2);
  });
});
