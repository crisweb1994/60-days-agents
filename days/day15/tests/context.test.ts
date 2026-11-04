import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { Message } from '../solution/types.ts';

const ctx = await loadTarget<typeof import('../solution/context.ts')>(import.meta.url, 'context.ts');
const { buildContext, cacheStats, estimateTokens, firstDifference, splitTurns, ContextOverflowError } = ctx;

const toolCall = (id: string) => ({ id, type: 'function' as const, function: { name: 'calculator', arguments: '{"expression":"1+1"}' } });
/** 第 n 轮：问题、一次工具调用、工具结果、回答。每轮的文字长度差不多 */
const turn = (n: number, size = 100): Message[] => [
  { role: 'user', content: `第 ${n} 个问题：${'问'.repeat(size)}` },
  { role: 'assistant', content: null, tool_calls: [toolCall(`call_${n}`)] },
  { role: 'tool', tool_call_id: `call_${n}`, content: `结果 ${n}` },
  { role: 'assistant', content: `第 ${n} 个回答：${'答'.repeat(size)}` },
];

describe('第 15 天：估算 token（TODO 1）', () => {
  test('中文每个字算 1 个，其他字符每 4 个算 1 个，向上取整', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('hello world!')).toBe(3);
    expect(estimateTokens('MCP 服务器')).toBe(3 + 1);
    expect(estimateTokens('a')).toBe(1);
  });

  test('全角标点也按中文算', () => {
    expect(estimateTokens('你好，世界。')).toBe(6);
  });
});

describe('第 15 天：按轮分组（TODO 2）', () => {
  test('每轮从 user 消息开始，带着后面的 assistant 和 tool 消息；system 消息不算', () => {
    const history: Message[] = [{ role: 'system', content: '系统' }, ...turn(1), ...turn(2)];
    const turns = splitTurns(history);
    expect(turns).toHaveLength(2);
    expect(turns[0].map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(turns[1][0].content).toContain('第 2 个问题');
  });
});

describe('第 15 天：按预算组装上下文（TODO 3）', () => {
  const tools = [{ type: 'function' as const, function: { name: 'calculator', description: '计算', parameters: { type: 'object' } } }];
  const history = [{ role: 'system' as const, content: '旧的系统提示' }, ...turn(1), ...turn(2), ...turn(3)];

  test('预算够：全部历史都留下，顺序是 [system, 历史, 这一轮的问题]', () => {
    const built = buildContext({ system: '你是助手', tools, history, question: '新问题' }, { contextWindow: 100_000 });
    expect(built.history[0], '用传进来的 system，不用历史里旧的').toEqual({ role: 'system', content: '你是助手' });
    expect(built.history.slice(1)).toEqual(history.slice(1));
    expect(built.question).toBe('新问题');
    expect(built.report.droppedTurns).toBe(0);
    expect(built.report.total).toBeLessThanOrEqual(built.report.limit);
  });

  test('预算不够：从最旧的一轮开始整轮删掉，工具调用和结果不会被拆开', () => {
    // 每轮大约 230 tokens，固定部分大约 40：能放下两轮，放不下三轮
    const built = buildContext({ system: '你是助手', tools, history, question: '新问题' }, { contextWindow: 600, reserveOutput: 0 });
    expect(built.report.droppedTurns).toBe(1);
    expect(built.history.slice(1)).toEqual([...turn(2), ...turn(3)]);
    expect(built.report.total).toBeLessThanOrEqual(600);
  });

  test('一轮都放不下：只留 system；固定部分都放不下：抛出 ContextOverflowError', () => {
    const tight = buildContext({ system: '你是助手', tools, history, question: '新问题' }, { contextWindow: 100, reserveOutput: 0 });
    expect(tight.history).toHaveLength(1);
    expect(() => buildContext({ system: '长'.repeat(500), tools, history, question: '问' }, { contextWindow: 400, reserveOutput: 0 })).toThrow(
      ContextOverflowError,
    );
  });

  test('给输出留出空间：reserveOutput 默认 4000', () => {
    const built = buildContext({ system: '你是助手', tools, history: [], question: '问' }, { contextWindow: 10_000 });
    expect(built.report.limit).toBe(6000);
  });

  test('动态信息放在这一轮的问题前面，用标签包起来；按 priority 取舍，放进去的保持原来的顺序', () => {
    const built = buildContext(
      {
        system: '你是助手',
        tools,
        history: [],
        dynamic: [
          { label: 'retrieved', content: '资料'.repeat(300), priority: 1 },
          { label: 'date', content: '今天是 2026-11-02', priority: 10 },
          { label: 'memory', content: '用户喜欢简短的回答', priority: 5 },
        ],
        question: '新问题',
      },
      { contextWindow: 10_000, maxDynamic: 100 },
    );
    expect(built.question).toBe('<date>\n今天是 2026-11-02\n</date>\n<memory>\n用户喜欢简短的回答\n</memory>\n\n新问题');
    expect(built.report.droppedSections).toEqual(['retrieved']);
    expect(built.report.dynamic).toBeGreaterThan(0);
  });
});

describe('第 15 天：缓存命中率和前缀（TODO 4）', () => {
  test('cacheStats：命中缓存的输入占全部输入的比例', () => {
    const usage = (inputTokens: number, cachedTokens: number) => ({ inputTokens, cachedTokens, outputTokens: 0, reasoningTokens: 0 });
    expect(cacheStats([usage(1000, 0), usage(1200, 900), usage(1400, 1100)])).toEqual({ inputTokens: 3600, cachedTokens: 2000, hitRate: 2000 / 3600 });
    expect(cacheStats([]).hitRate).toBe(0);
  });

  test('firstDifference：找出两次请求从哪里开始不一样', () => {
    const a: Message[] = [{ role: 'system', content: 'S' }, { role: 'user', content: '1' }];
    const tools = [{ type: 'function' as const, function: { name: 't', parameters: {} } }];
    expect(firstDifference({ messages: a, tools }, { messages: [...a, { role: 'user', content: '2' }], tools }), '前缀完全保留').toBe(-1);
    expect(firstDifference({ messages: a }, { messages: [{ role: 'system', content: '今天是 11 月 3 日' }, a[1]] })).toBe(0);
    expect(firstDifference({ messages: a, tools }, { messages: a, tools: [] })).toBe('tools');
  });
});
