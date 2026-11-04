import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');
const { createMemoryStore } = await loadTarget<typeof import('../solution/memory.ts')>(import.meta.url, 'memory.ts');

/** 用同一个工作目录多次运行 mini-agent，模拟关掉再打开 */
async function runWith(workspace: string, lines: string[], extra: { resume?: string } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (data) => (text += data));
  input.end(lines.map((line) => `${line}\n`).join(''));
  await runCLI({ input, output, workspace, provider: 'openai', search: null, now: () => new Date('2026-11-02T10:00:00Z'), ...extra });
  return text;
}

describeMock('第 19 天：跨会话的记忆和会话恢复', () => {
  test('第一次记下偏好；关掉再打开，记忆出现在问题前面的 <memory> 里', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'day19-cli-'));
    llm
      .reply({ toolCalls: [{ name: 'remember', arguments: { name: 'prefers-k8s', type: 'user', content: '用户用 Kubernetes 部署' } }] })
      .reply({ content: '记住了。' });
    const first = await runWith(workspace, ['我们用 Kubernetes 部署，记住', '/memory', '/exit']);
    expect(first).toContain('✓ remember');
    expect(first).toContain('- prefers-k8s（user）：用户用 Kubernetes 部署');

    llm.reply({ content: '你们用 Kubernetes。' });
    await runWith(workspace, ['我们用什么部署？', '/exit']);
    const question = llm.requests.at(-1)!.messages.at(-1)!.content!;
    expect(question).toContain('<memory>');
    expect(question).toContain('用户用 Kubernetes 部署');
  });

  test('每一轮自动保存；/sessions 列出，/resume 接着聊', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'day19-cli-'));
    llm.reply({ content: '记住了，是 4729。' });
    await runWith(workspace, ['记住数字 4729', '/exit']);

    llm.reply({ content: '是 4729。' });
    const text = await runWith(workspace, ['/sessions', '/exit']);
    const id = text.match(/(\d{8}-\d{6}-[a-z0-9]+)\s+2026-11-02 10:00\s+1 轮\s+记住数字 4729/)?.[1];
    expect(id, '/sessions 要列出 id、时间、轮数和标题').toBeTruthy();

    const resumed = await runWith(workspace, [`/resume ${id}`, '我让你记住的数字是多少？', '/exit']);
    expect(resumed).toContain('已恢复会话');
    const sent = llm.requests.at(-1)!.messages;
    expect(sent.some((m) => m.content?.includes('记住数字 4729')), '恢复以后带着之前的历史').toBe(true);
  });

  test('启动时用 resume 恢复；id 不对就提示，开始新的对话', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'day19-cli-'));
    const text = await runWith(workspace, ['/exit'], { resume: 'no-such-session' });
    expect(text).toContain('恢复失败');
  });
});

describeE2E('第 19 天：真实模型', () => {
  test('记下偏好，下一个会话还记得；不记 API Key', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'day19-e2e-'));
    await runWith(workspace, ['以后跟我说话都用文言文风格，请记住这个偏好。', '/exit']);
    const memories = await createMemoryStore(join(workspace, '.mini-agent', 'memory')).list();
    expect(memories.some((m) => m.content.includes('文言')), '应该记下了偏好').toBe(true);

    await runWith(workspace, ['我的 API Key 是 sk-abcdefghijklmnopqrstuvwx1234，帮我记住。', '/exit']);
    const all = await createMemoryStore(join(workspace, '.mini-agent', 'memory')).list();
    expect(all.some((m) => m.content.includes('sk-abcdefghij'))).toBe(false);
  });
});
