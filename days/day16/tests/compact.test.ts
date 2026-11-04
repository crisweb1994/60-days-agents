import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { loadTarget } from '#testing';
import type { Message } from '../solution/types.ts';

const compact = await loadTarget<typeof import('../solution/compact.ts')>(import.meta.url, 'compact.ts');
const { defineTool, runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createScriptedModel } = await loadTarget<typeof import('../solution/testing/scripted-model.ts')>(
  import.meta.url,
  'testing/scripted-model.ts',
);
const { compactHistory, factRetention, formatTranscript, offloadLargeResults, pruneToolOutputs, SUMMARY_ACK } = compact;

const turn = (n: number, toolOutput = `网页 ${n} 的内容：${'正文'.repeat(400)}`): Message[] => [
  { role: 'user', content: `第 ${n} 个问题` },
  { role: 'assistant', content: null, tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: 'fetch_page', arguments: `{"url":"https://e.example/${n}"}` } }] },
  { role: 'tool', tool_call_id: `call_${n}`, content: toolOutput },
  { role: 'assistant', content: `第 ${n} 个回答` },
];
const system: Message = { role: 'system', content: '你是助手' };

describe('第 16 天：清理旧的工具输出（TODO 1）', () => {
  test('最近几轮不动，更早的长输出换成一行说明；工具调用本身留着', () => {
    const messages = [system, ...turn(1), ...turn(2), ...turn(3)];
    const { messages: result, pruned } = pruneToolOutputs(messages, { keepRecentTurns: 2 });
    expect(pruned).toBe(1);
    expect(result).toHaveLength(messages.length);
    expect(result[0]).toEqual(system);
    expect(result[3].content).toMatch(/已清理.*原来有 \d+ 个字符/);
    expect(result[2], '工具调用要留着，模型才知道自己做过什么').toEqual(messages[2]);
    expect(result.slice(5)).toEqual(messages.slice(5));
    expect(messages[3].content, '不要修改传进来的数组').toContain('网页 1 的内容');
  });

  test('短的输出不清理', () => {
    const messages = [system, ...turn(1, '42'), ...turn(2), ...turn(3)];
    expect(pruneToolOutputs(messages, { keepRecentTurns: 2 }).pruned).toBe(0);
  });
});

describe('第 16 天：大结果写入文件（TODO 2）', () => {
  test('太长的结果写进 .context/results/，上下文里只有开头和文件的位置；短的结果原样返回', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'day16-offload-'));
    const big = defineTool({ name: 'big', description: '', schema: z.object({ n: z.number() }), execute: ({ n }) => 'x'.repeat(n) });
    const tools = offloadLargeResults([big], { workspace, maxChars: 1000, previewChars: 100 });
    expect(tools[0].name).toBe('big');
    const call = (n: number) => ({ id: 'c', type: 'function' as const, function: { name: 'big', arguments: JSON.stringify({ n }) } });

    expect((await runToolCall(tools, call(500))).content).toBe('x'.repeat(500));
    const result = await runToolCall(tools, call(5000));
    expect(result.content.length).toBeLessThan(400);
    expect(result.content).toContain('共 5000 个字符');
    expect(result.content).toContain('read_file');
    const path = result.content.match(/(\.context\/results\/\S+\.md)/)?.[1];
    expect(path, '要写出文件的相对路径').toBeTruthy();
    expect(existsSync(join(workspace, path!))).toBe(true);
    expect(readFileSync(join(workspace, path!), 'utf8')).toBe('x'.repeat(5000));
  });
});

describe('第 16 天：摘要压缩（TODO 3、4）', () => {
  test('formatTranscript：写成「用户：」「助手：」，工具调用写出名字和参数，长的工具结果截短', () => {
    const text = formatTranscript([turn(1)]);
    expect(text).toContain('用户：第 1 个问题');
    expect(text).toContain('助手调用了工具 fetch_page，参数 {"url":"https://e.example/1"}');
    expect(text).toContain('工具结果：网页 1 的内容');
    expect(text).toContain('助手：第 1 个回答');
    expect(text.length).toBeLessThan(1800);
  });

  test('compactHistory：较早的几轮交给模型写摘要，结果是 [system, 摘要, 确认, 最近几轮]', async () => {
    const model = createScriptedModel([{ text: '## 用户的目标\n查潮汐协议', usage: { inputTokens: 300 } }]);
    const messages = [system, ...turn(1), ...turn(2), ...turn(3)];
    const result = await compactHistory(messages, model, { keepRecentTurns: 1 });

    const request = model.requests[0].messages;
    expect(request[0].content, '用 SUMMARY_PROMPT 作为 system prompt').toBe(compact.SUMMARY_PROMPT);
    expect(request[1].content).toContain('第 1 个问题');
    expect(request[1].content).toContain('第 2 个回答');
    expect(request[1].content, '最近一轮不压缩').not.toContain('第 3 个问题');
    expect(result.compactedTurns).toBe(2);
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
    expect(result.messages[1].content).toContain('查潮汐协议');
    expect(result.messages[2].content).toBe(SUMMARY_ACK);
    expect(result.messages.slice(3)).toEqual(turn(3));
    expect(result.usage?.inputTokens).toBe(300);
  });

  test('轮数不多于 keepRecentTurns：什么都不做，不调用模型', async () => {
    const model = createScriptedModel([]);
    const messages = [system, ...turn(1)];
    const result = await compactHistory(messages, model, { keepRecentTurns: 2 });
    expect(result).toEqual({ messages, summary: '', compactedTurns: 0 });
  });

  test('模型返回空的摘要：抛出错误，不要用空摘要替换掉对话', async () => {
    const model = createScriptedModel([{ text: '   ' }]);
    await expect(compactHistory([system, ...turn(1), ...turn(2), ...turn(3)], model)).rejects.toThrow('摘要');
  });
});

describe('第 16 天：测出压缩丢了什么', () => {
  test('factRetention：忽略空白和大小写，列出保留的和丢掉的事实', () => {
    const retention = factRetention('默认端口是 7443，代号 Blue Whale。', ['7443', 'bluewhale', '3 月 14 日']);
    expect(retention.kept).toEqual(['7443', 'bluewhale']);
    expect(retention.lost).toEqual(['3 月 14 日']);
    expect(retention.ratio).toBeCloseTo(2 / 3);
  });
});
