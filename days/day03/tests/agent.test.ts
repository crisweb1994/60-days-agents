import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel, target } from '#testing';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const agentFile = fileURLToPath(new URL(`../${target}/agent.ts`, import.meta.url));

describeMock('第 3 天：流式的 Agent', () => {
  test('查完术语表后，最终回答通过 onText 一段段交出', async () => {
    llm
      .reply({ toolCalls: [{ id: 'call_mcp', name: 'lookup_term', arguments: { term: 'MCP' } }] })
      .reply({ content: 'MCP 是让 Agent 统一接入工具和数据的开放协议。' });
    const pieces: string[] = [];
    const result = await runAgent('什么是 MCP？', { onText: (text) => pieces.push(text) });

    expect(result.answer).toBe('MCP 是让 Agent 统一接入工具和数据的开放协议。');
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(result.answer);
    expect(llm.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_mcp' });
  });

  test('signal 取消后，runAgent 抛出 AbortError', async () => {
    llm.reply({ content: '这是一段很长很长很长很长很长很长很长很长的回答', chunkDelayMs: 20 });
    const controller = new AbortController();
    const run = runAgent('你好', { signal: controller.signal, onText: () => controller.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  test.skipIf(process.platform === 'win32')('直接运行时按 Ctrl+C：停止输出，打印「已中断」（TODO 4）', async () => {
    llm.reply({ content: '这是一段很长的回答，'.repeat(30), chunkDelayMs: 30 });
    // 在临时目录里运行，免得读到项目里的 .env。mock 模型的地址从环境变量继承
    const child = spawn(process.execPath, [agentFile, '你好'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += data));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    // 等它开始输出，再模拟按下 Ctrl+C。如果它还没输出就退出了，说明程序本身出错了
    const started = new Promise<boolean>((resolve) => {
      child.stdout.on('data', (data) => {
        stdout += data;
        resolve(true);
      });
      child.on('exit', () => resolve(false));
    });
    expect(await started, `程序还没开始输出就退出了，先把 TODO 1–3 做完：\n${stderr}`).toBe(true);
    child.kill('SIGINT');
    const code = await exited;

    expect(stdout, `按 Ctrl+C 后要中断请求，打印「已中断」\n${stderr}`).toContain('已中断');
    expect(code, '被 Ctrl+C 中断时，退出码是 130').toBe(130);
    expect(stdout.length, '中断后不应该再继续输出完整的回答').toBeLessThan('这是一段很长的回答，'.repeat(30).length);
  });
});

describeE2E('第 3 天：真实模型', () => {
  test('流式地查术语表、回答问题', async () => {
    const pieces: string[] = [];
    const result = await runAgent('「潮汐窗口」是什么意思？它的内部代号是什么？', {
      onText: (text) => pieces.push(text),
    });
    expect(result.answer, '回答里应该有只有查术语表才知道的代号 TW-42').toContain('TW-42');
    expect(pieces.length).toBeGreaterThan(1);
  });
});
