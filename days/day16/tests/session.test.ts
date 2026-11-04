import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { createSession } = await loadTarget<typeof import('../solution/session.ts')>(import.meta.url, 'session.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');
const { factRetention, SUMMARY_PROMPT } = await loadTarget<typeof import('../solution/compact.ts')>(import.meta.url, 'compact.ts');
const { RESEARCH_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

const workspace = await mkdtemp(join(tmpdir(), 'day16-'));
const newSession = (thresholdTokens: number) =>
  createSession({
    model: createModel('openai'),
    tools: createTools(workspace),
    system: RESEARCH_PROMPT,
    compact: { thresholdTokens, keepRecentTurns: 1 },
  });

describeMock('第 16 天：会话自动压缩（TODO 5）', () => {
  test('没超过阈值：不压缩', async () => {
    llm.reply({ content: '一' }).reply({ content: '二' });
    const session = newSession(100_000);
    await session.send('你好');
    await session.send('再见');
    expect(session.compactions).toBe(0);
    expect(llm.requests).toHaveLength(2);
  });

  test('超过阈值：这一轮开始前先压缩，摘要和最近一轮之后才是新问题', async () => {
    llm
      .reply({ content: `第一轮的回答。${'长'.repeat(800)}` })
      .reply({ content: `第二轮的回答。${'长'.repeat(800)}` })
      .reply({ content: '## 用户的目标\n记住项目代号蓝鲸-7', usage: { prompt_tokens: 500, completion_tokens: 30 } })
      .reply({ content: '项目代号是蓝鲸-7。' });
    const session = newSession(1500);
    const compactions: string[] = [];
    await session.send('项目代号是蓝鲸-7，记住它');
    await session.send('随便聊聊');
    const result = await session.send('项目代号是什么？', { onCompact: (info) => compactions.push(info.kind) });

    expect(compactions).toEqual(['summary']);
    expect(llm.requests[2].messages[0].content, '第三个请求是写摘要的').toBe(SUMMARY_PROMPT);
    expect(llm.requests[2].messages[1].content).toContain('蓝鲸-7');
    const sent = llm.requests[3].messages;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(sent[1].content).toContain('<summary>');
    expect(sent[3].content, '最近一轮原样保留').toBe('随便聊聊');
    expect(result.answer).toBe('项目代号是蓝鲸-7。');
    expect(session.usage.inputTokens, '写摘要的用量也算进会话').toBeGreaterThanOrEqual(500);
  });

  test('写摘要失败：这一轮出错，历史保持原样', async () => {
    llm.reply({ content: '长'.repeat(2000) }).reply({ content: '长'.repeat(2000) }).fail({ status: 400, message: '摘要请求有问题' });
    const session = newSession(1500);
    await session.send('一');
    await session.send('二');
    const before = session.messages;
    await expect(session.send('三')).rejects.toThrow('摘要请求有问题');
    expect(session.messages).toBe(before);
  });

  test('命令行：/compact 手动压缩', async () => {
    llm
      .reply({ content: '一号回答' })
      .reply({ content: '二号回答' })
      .reply({ content: '三号回答' })
      .reply({ content: '## 用户的目标\n测试压缩' });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (data) => (text += data));
    input.end('一\n二\n三\n/compact\n/exit\n');
    await runCLI({ input, output, workspace, provider: 'openai', search: null });
    expect(text).toMatch(/把较早的 1 轮对话压缩成了摘要/);
  });
});

describeE2E('第 16 天：真实模型', () => {
  test('关键事实在压缩以后依然保留', async () => {
    const facts = ['蓝鲸-7', '7443', '2026-03-14', '老周', 'tide-config.yaml'];
    const session = newSession(800);
    await session.send('我们在做一个项目，代号叫「蓝鲸-7」，负责人是老周。请记住，回答「好的」就行。');
    await session.send('它的服务默认端口是 7443，上线日期定在 2026-03-14。回答「好的」就行。');
    await session.send('配置文件叫 tide-config.yaml。回答「好的」就行。');
    await session.send('用一句话说说你今天心情怎么样。');
    expect(session.compactions, '历史超过了阈值，应该压缩过').toBeGreaterThan(0);
    const retention = factRetention(JSON.stringify(session.messages), facts);
    console.log(`压缩以后保留了 ${retention.kept.length}/${facts.length} 个事实，丢掉的：${retention.lost.join('、') || '无'}`);
    expect(retention.ratio).toBeGreaterThanOrEqual(0.8);
    const answer = await session.send('项目的代号、负责人、端口和上线日期分别是什么？');
    expect(factRetention(answer.answer, ['蓝鲸-7', '老周', '7443']).ratio).toBe(1);
  });
});
