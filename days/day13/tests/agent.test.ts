import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import type { McpHost } from '../solution/mcp.ts';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { connectMcpServers, parseMcpConfig } = await loadTarget<typeof import('../solution/mcp.ts')>(import.meta.url, 'mcp.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

const STDIO_SERVER = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));
let host: McpHost;
beforeAll(async () => {
  host = await connectMcpServers(
    parseMcpConfig({ mcpServers: { notes: { command: process.execPath, args: [STDIO_SERVER] }, broken: { command: '/no/such/day13' } } }),
  );
});
afterAll(() => host.close());

describeMock('第 13 天：Agent 使用 MCP 服务器的工具', () => {
  test('MCP 工具和内置工具一起交给模型，调用结果交回模型', async () => {
    llm.reply({ toolCalls: [{ name: 'notes__search_notes', arguments: { query: '发布' } }] }).reply({ content: '每周四下午三点发布。' });
    const result = await runAgent('我们什么时候发布？', { model: createModel('openai'), tools: host.tools });
    expect(result.answer).toBe('每周四下午三点发布。');
    const tool = llm.requests[0].tools?.find((t) => t.function.name === 'notes__search_notes');
    expect(tool?.function.parameters, '参数是服务器给的 JSON Schema').toMatchObject({ properties: { query: { type: 'string' } } });
    expect(llm.requests[1].messages.at(-1)?.content).toContain('每周四下午三点');
  });

  test('命令行：启动时显示连上了几个服务器，/mcp 列出工具和失败的原因；不是只读的工具执行前要确认', async () => {
    llm.reply({ toolCalls: [{ name: 'notes__add_note', arguments: { title: '新笔记', text: '内容' } }] }).reply({ content: '好的，没有新建。' });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (data) => (text += data));
    input.end('/mcp\n记一条笔记\nn\n/exit\n');
    const workspace = await mkdtemp(join(tmpdir(), 'day13-cli-'));
    await runCLI({ input, output, workspace, provider: 'openai', search: null, mcp: host });
    expect(text).toContain('连上了 1/2 个');
    expect(text).toContain('notes（team-notes 1.2.0，协议 2026-07-28）：search_notes、add_note');
    expect(text).toContain('✗ broken：连接失败');
    expect(text).toContain('要执行 notes__add_note');
    expect(text).toContain('✗ notes__add_note');
  });
});

describeE2E('第 13 天：真实模型', () => {
  test('用 MCP 服务器的工具查到只有那里才有的信息', async () => {
    const result = await runAgent('查一下团队笔记：十一月的值班负责人是谁？', { model: createModel('openai'), tools: host.tools });
    expect(result.answer).toContain('老周');
  });
});
