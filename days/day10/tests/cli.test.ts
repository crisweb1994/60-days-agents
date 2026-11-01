import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day10-cli-'));
});

/** 在进程里运行 mini-agent：把几行输入一次性写进去，收集全部输出 */
async function runWith(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (data) => (text += data));
  input.end(lines.map((line) => `${line}\n`).join(''));
  const session = await runCLI({ input, output, workspace, provider: 'openai' });
  return { text, session };
}

describeMock('第 10 天：mini-agent', () => {
  test('多轮对话：流式输出回答，每一轮之后显示用量，/exit 退出时显示总计', async () => {
    llm.reply({ content: '你好！有什么可以帮你？' }).reply({ content: '我记得你说了「你好」。' });
    const { text, session } = await runWith(['你好', '我刚才说了什么？', '/exit']);
    expect(text).toContain('mini-agent');
    expect(text).toContain('你好！有什么可以帮你？');
    expect(text).toContain('我记得你说了「你好」。');
    expect(text).toMatch(/输入 \d+ tokens/);
    expect(text).toContain('再见');
    expect(session.turns).toBe(2);
    expect(llm.requests[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  test('输入结束（比如按了 Ctrl+D）也会正常退出', async () => {
    llm.reply({ content: '好的。' });
    const { text } = await runWith(['你好']);
    expect(text).toContain('再见');
  });

  test('显示每一次工具调用的结果', async () => {
    llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '6 * 7' } }] }).reply({ content: '是 42。' });
    const { text } = await runWith(['6 乘 7 是多少？', '/exit']);
    expect(text).toContain('✓ calculator');
    expect(text).toContain('42');
  });
});

describeMock('第 10 天：命令（TODO 4）', () => {
  test('/help 列出命令，不认识的命令给出提示', async () => {
    const { text } = await runWith(['/help', '/foo', '/exit']);
    for (const command of ['/model', '/cost', '/clear', '/exit']) expect(text).toContain(command);
    expect(text).toContain('不认识的命令');
    expect(llm.requests, '命令不会发给模型').toHaveLength(0);
  });

  test('/cost 显示这次会话的轮数和用量', async () => {
    llm.reply({ content: '好的。', usage: { prompt_tokens: 120, completion_tokens: 3 } });
    const { text } = await runWith(['你好', '/cost', '/exit']);
    expect(text).toMatch(/1 轮 · 输入 120 tokens/);
  });

  test('/clear 清空对话历史', async () => {
    llm.reply({ content: '一' }).reply({ content: '二' });
    await runWith(['第一个话题', '/clear', '第二个话题', '/exit']);
    expect(llm.requests[1].messages.map((m) => m.role), '/clear 之后，下一轮从头开始').toEqual(['system', 'user']);
  });

  test('/model 查看当前模型，/model anthropic 切换协议，历史保留', async () => {
    llm.reply({ content: '你好！' }).reply({ content: '换了协议，我还记得。' });
    const { text, session } = await runWith(['/model', '你好', '/model anthropic', '你还记得吗？', '/model gemini', '/exit']);
    expect(text).toContain('openai:mock-model');
    expect(text).toContain('anthropic:mock-model');
    expect(llm.anthropicRequests, '切换之后，请求发到 Anthropic 协议的接口').toHaveLength(1);
    expect(llm.anthropicRequests[0].messages.length, '之前的历史也一起发过去了').toBe(3);
    expect(text, '不认识的协议给出提示').toContain('不认识的协议');
    expect(session.model.name).toBe('anthropic:mock-model');
  });
});

describeMock('第 10 天：写文件之前先确认（TODO 5）', () => {
  const writeCall = { toolCalls: [{ name: 'write_file', arguments: { path: 'note.txt', content: '买牛奶' } }] };

  test('回答 y：写入文件', async () => {
    llm.reply(writeCall).reply({ content: '写好了。' });
    const { text } = await runWith(['帮我记一下：买牛奶', 'y', '/exit']);
    expect(text, '执行之前要说明要做什么').toContain('write_file');
    expect(text).toContain('(y/N)');
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('买牛奶');
  });

  test('回答 n 或者直接回车：不写', async () => {
    llm.reply(writeCall).reply({ content: '好的，没有写。' }).reply(writeCall).reply({ content: '好的，没有写。' });
    await runWith(['帮我记一下：买牛奶', 'n', '再试一次', '', '/exit']);
    expect(existsSync(join(workspace, 'note.txt')), '只有明确回答 y 才执行').toBe(false);
    const toolMessages = llm.requests.flatMap((r) => r.messages).filter((m) => m.role === 'tool');
    expect(toolMessages.every((m) => m.content?.includes('没有同意')), '拒绝的结果交回了模型').toBe(true);
  });
});
