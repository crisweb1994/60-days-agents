import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runAgent, resumeAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');
const { askUser } = await loadTarget<typeof import('../solution/tools/ask-user.ts')>(import.meta.url, 'tools/ask-user.ts');
const { DEFAULT_POLICY } = await loadTarget<typeof import('../solution/permissions.ts')>(import.meta.url, 'permissions.ts');
const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'day29-'));
  const tools = [...createTools(workspace), askUser];
  return { workspace, tools, options: { model: createModel('openai'), tools, policy: DEFAULT_POLICY, pausable: true } };
}
const writeNotes = { name: 'write_file', arguments: { path: 'notes.md', content: '潮汐协议 3.0 的笔记' } };

describe('ask_user', () => {
  test('有 ask 就直接问；能暂停就中断；都不行就让模型自己判断', async () => {
    const call = { id: 'q', type: 'function' as const, function: { name: 'ask_user', arguments: JSON.stringify({ question: '哪个版本？', options: ['2.x', '3.0'] }) } };
    const asked = await runToolCall([askUser], call, { ask: async (q, o) => `${q} ${o!.join('/')} → 3.0` });
    expect(asked.content).toBe('用户回答：哪个版本？ 2.x/3.0 → 3.0');
    expect((await runToolCall([askUser], call, { pausable: true })).interrupt).toEqual({ kind: 'input', question: '哪个版本？', options: ['2.x', '3.0'] });
    expect((await runToolCall([askUser], call)).content).toContain('按你最合理的理解接着做');
  });
});

describeMock('第 29 天：暂停（TODO 3）', () => {
  test('要批准的调用没人可问：暂停，把现场交出来；同一轮里不用批准的照常执行', async () => {
    const { options, workspace } = await setup();
    llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '6*7' } }, writeNotes] }).reply({ content: '不该用到这一轮' });
    const result = await runAgent('算一下，再记下来', options);
    expect(result.status).toBe('paused');
    expect(llm.requests, '暂停以后不再调用模型').toHaveLength(1);
    const paused = result.paused!;
    expect(paused.messages.at(-1), '历史停在发起工具调用的那条消息上').toMatchObject({ role: 'assistant' });
    expect(paused.calls.map((c) => [c.call.function.name, c.result?.content, c.interrupt?.kind])).toEqual([
      ['calculator', '42', undefined],
      ['write_file', undefined, 'approval'],
    ]);
    expect(paused.calls[1].interrupt).toMatchObject({ tool: 'write_file', risk: 'write', input: { path: 'notes.md' } });
    expect(paused).toMatchObject({ steps: 1, toolErrors: 0 });
    await expect(readFile(join(workspace, 'notes.md'), 'utf8'), '还没批准，不能写').rejects.toThrow();
  });

  test('没有 pausable：和以前一样当作拒绝，接着跑', async () => {
    const { tools } = await setup();
    llm.reply({ toolCalls: [writeNotes] }).reply({ content: '好的，不写了。' });
    const result = await runAgent('记下来', { model: createModel('openai'), tools, policy: DEFAULT_POLICY });
    expect(result.status).toBe('completed');
  });
});

describeMock('第 29 天：恢复（TODO 4）', () => {
  test('批准：执行被批准的调用，结果按原来的顺序放进历史，接着调用模型；步数接着算', async () => {
    const { options, workspace } = await setup();
    llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '6*7' } }, writeNotes] }).reply({ content: '算好了，也记下来了。' });
    const first = await runAgent('算一下，再记下来', options);
    // 现场存成 JSON 再读回来：模拟程序重启以后接着跑
    const paused = JSON.parse(JSON.stringify(first.paused));
    const callId = paused.calls[1].call.id;
    const result = await resumeAgent(paused, { [callId]: { approved: true } }, options);
    expect(result).toMatchObject({ status: 'completed', answer: '算好了，也记下来了。', steps: 2 });
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('潮汐协议 3.0 的笔记');
    const tail = llm.requests[1].messages.slice(-2);
    expect(tail.map((m) => m.content)).toEqual(['42', expect.stringContaining('notes.md')]);
  });

  test('拒绝：结果是一条错误，模型看到以后换个办法', async () => {
    const { options } = await setup();
    llm.reply({ toolCalls: [writeNotes] }).reply({ content: '那就不写了。' });
    const { paused } = await runAgent('记下来', options);
    const result = await resumeAgent(paused!, { [paused!.calls[0].call.id]: { approved: false } }, options);
    expect(result.status).toBe('completed');
    expect(llm.requests[1].messages.at(-1)!.content).toContain('用户没有同意');
  });

  test('always：这个工具加进 grants，下次不再暂停', async () => {
    const { options } = await setup();
    const grants = new Set<string>();
    llm
      .reply({ toolCalls: [writeNotes] })
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'b.md', content: '第二个' } }] })
      .reply({ content: '都写好了。' });
    const { paused } = await runAgent('记下来', { ...options, grants });
    const result = await resumeAgent(paused!, { [paused!.calls[0].call.id]: { approved: true, always: true } }, { ...options, grants });
    expect([...grants]).toEqual(['write_file']);
    expect(result.status, '第二次写文件没有再暂停').toBe('completed');
  });

  test('回答问题：用户的回答就是 ask_user 的结果', async () => {
    const { options } = await setup();
    llm
      .reply({ toolCalls: [{ name: 'ask_user', arguments: { question: '你说的是哪个协议？', options: ['潮汐协议', '浪花协议'] } }] })
      .reply({ content: '好的，查潮汐协议。' });
    const { paused, status } = await runAgent('查一下那个协议', options);
    expect(status).toBe('paused');
    expect(paused!.calls[0].interrupt).toEqual({ kind: 'input', question: '你说的是哪个协议？', options: ['潮汐协议', '浪花协议'] });
    await resumeAgent(paused!, { [paused!.calls[0].call.id]: { answer: '潮汐协议' } }, options);
    expect(llm.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', content: '用户回答：潮汐协议' });
  });

  test('有中断没有答复、答复的种类不对：报错', async () => {
    const { options } = await setup();
    llm.reply({ toolCalls: [writeNotes] });
    const { paused } = await runAgent('记下来', options);
    const id = paused!.calls[0].call.id;
    await expect(resumeAgent(paused!, {}, options)).rejects.toThrow(`还有 1 个工具调用在等答复：${id}`);
    await expect(resumeAgent(paused!, { [id]: { answer: '好' } }, options)).rejects.toThrow('答复要写成 { approved }');
  });
});

describeE2E('第 29 天：真实模型主动澄清', () => {
  test('含糊的问题：先用 ask_user 问清楚', { timeout: 120_000 }, async () => {
    const { options } = await setup();
    const { RESEARCH_PROMPT } = await loadTarget<typeof import('../solution/prompts.ts')>(import.meta.url, 'prompts.ts');
    const result = await runAgent('帮我把那个文件改一下', { ...options, system: RESEARCH_PROMPT });
    console.log(result.status, JSON.stringify(result.paused?.calls.map((c) => c.interrupt)));
    expect(result.status).toBe('paused');
    expect(result.paused!.calls.some((c) => c.interrupt?.kind === 'input')).toBe(true);
  });
});
