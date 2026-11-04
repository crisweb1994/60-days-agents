import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { createSession } = await loadTarget<typeof import('../solution/session.ts')>(import.meta.url, 'session.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');
const { firstDifference } = await loadTarget<typeof import('../solution/context.ts')>(import.meta.url, 'context.ts');
const { dateSection, RESEARCH_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

const workspace = await mkdtemp(join(tmpdir(), 'day15-'));
const newSession = (contextWindow = 64_000, reserveOutput?: number) =>
  createSession({ model: createModel('openai'), tools: createTools(workspace), system: RESEARCH_PROMPT, budget: { contextWindow, reserveOutput } });

test('dateSection：日期和星期，优先级高', () => {
  expect(dateSection(new Date(2026, 10, 2))).toEqual({ label: 'date', content: '今天是 2026-11-02，星期一', priority: 10 });
});

test('system prompt 里没有会变的内容', () => {
  expect(RESEARCH_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|今天是/);
});

describeMock('第 15 天：会话按预算组装上下文（TODO 5）', () => {
  test('日期每天都变，但放在最后一条消息里：后一轮请求以前一轮请求的全部消息开头，前缀能命中缓存', async () => {
    llm.reply({ content: '一' }).reply({ content: '二' }).reply({ content: '三' });
    const session = newSession();
    await session.send('第一个问题', { dynamic: [dateSection(new Date(2026, 10, 2))] });
    await session.send('第二个问题', { dynamic: [dateSection(new Date(2026, 10, 3))] });
    await session.send('第三个问题', { dynamic: [dateSection(new Date(2026, 10, 3))] });
    const [r1, r2, r3] = llm.requests;
    expect(r1.messages[0].content).toBe(RESEARCH_PROMPT);
    expect(r1.messages[1].content).toContain('<date>\n今天是 2026-11-02');
    expect(r1.messages[1].content).toContain('第一个问题');
    expect(firstDifference(r1 as never, r2 as never), '第二轮的请求要以第一轮的全部消息开头').toBe(-1);
    expect(firstDifference(r2 as never, r3 as never)).toBe(-1);
    expect(session.lastContext?.droppedTurns).toBe(0);
  });

  test('预算不够时删掉最早的对话；删掉的就不在历史里了', async () => {
    llm.reply({ content: '答'.repeat(400) }).reply({ content: '答'.repeat(400) }).reply({ content: '好' });
    // 固定部分（system prompt 和工具定义）大约 950 tokens，每轮大约 420：只放得下一轮
    const session = newSession(1700, 0);
    await session.send('问题一', { dynamic: [] });
    await session.send('问题二');
    await session.send('问题三');
    expect(session.lastContext?.droppedTurns).toBeGreaterThan(0);
    expect(llm.requests[2].messages.some((m) => m.content?.includes('问题一')), '最早的一轮被删掉了').toBe(false);
    expect(llm.requests[2].messages.some((m) => m.content?.includes('问题二'))).toBe(true);
  });

  test('命令行：/context 显示每部分的 token，/cost 显示缓存命中率', async () => {
    llm.reply({ content: '你好！', usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 600 } } });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (data) => (text += data));
    input.end('你好\n/context\n/cost\n/exit\n');
    await runCLI({ input, output, workspace, provider: 'openai', search: null, now: () => new Date(2026, 10, 2) });
    expect(llm.requests[0].messages[1].content).toContain('今天是 2026-11-02');
    expect(text).toMatch(/system prompt\s+\d+ tokens/);
    expect(text).toMatch(/工具定义\s+\d+ tokens/);
    expect(text).toContain('缓存命中率 60%');
  });
});

describeE2E('第 15 天：真实模型', () => {
  test('知道今天的日期；连续几轮之后，缓存命中率大于 0', async () => {
    const session = newSession();
    const date = dateSection(new Date(2031, 0, 15));
    const first = await session.send('今天是几月几号？只回答日期。', { dynamic: [date] });
    expect(first.answer).toMatch(/1\s*月\s*15|01-15|1\/15/);
    for (const q of ['用一句话介绍你自己。', '再说一遍你能做什么。']) await session.send(q, { dynamic: [date] });
    // 有的模型服务要求前缀至少 1024 个 token 才缓存，system prompt 加工具定义刚好够；不支持缓存的服务这里会失败
    console.log(`缓存命中 ${session.usage.cachedTokens} / ${session.usage.inputTokens}`);
    expect(session.usage.cachedTokens).toBeGreaterThan(0);
  });
});
