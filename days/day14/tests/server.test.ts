import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadTarget, target } from '#testing';
import { makeNotes } from './helpers.ts';

const { startHttpServer } = await loadTarget<typeof import('../solution/server/http.ts')>(import.meta.url, 'server/http.ts');
const { connectMcpServers, parseMcpConfig } = await loadTarget<typeof import('../solution/mcp.ts')>(import.meta.url, 'mcp.ts');
const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');

const STDIO = fileURLToPath(new URL(`../${target}/server/stdio.ts`, import.meta.url));
let root: string;
let client: Client;
beforeAll(async () => {
  root = await makeNotes();
  client = new Client({ name: 'day14-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [STDIO], env: { NOTES_DIR: root }, stderr: 'ignore' }));
});
afterAll(() => client.close());

describe('第 14 天：stdio 部署', () => {
  test('用 2026-07-28 协议连上；工具的顺序固定，带着输入和输出的 schema', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()).toMatchObject({ name: 'notes-server' });
    const first = await client.listTools();
    const second = await client.listTools();
    expect(first.tools.map((t) => t.name)).toEqual(['search_notes', 'read_note']);
    expect(JSON.stringify(second.tools), '每次列出的工具一模一样，才能命中提示缓存').toBe(JSON.stringify(first.tools));
    expect(first.tools[0].outputSchema).toMatchObject({ properties: { results: { type: 'array' } } });
    expect(first.tools[0].annotations?.readOnlyHint).toBe(true);
  });

  test('调用工具：既有给模型看的文字，也有符合 outputSchema 的结构化结果', async () => {
    const result: any = await client.callTool({ name: 'search_notes', arguments: { query: '值班' } });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('work/oncall.md');
    expect(result.structuredContent).toMatchObject({ total: 1, results: [{ path: 'work/oncall.md', title: '值班表' }] });
  });

  test('工具出错：返回 isError 的结果，说明原因', async () => {
    const result: any = await client.callTool({ name: 'read_note', arguments: { path: '../secret.md' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('工作目录之外');
  });

  test('资源：每篇笔记是一个 note:// 资源，可以列出、可以读取（TODO 4）', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('note://work/release.md');
    const { contents }: any = await client.readResource({ uri: 'note://work/release.md' });
    expect(contents[0].text).toContain('每周四下午三点');
  });

  test('提示词：summarize_note 把笔记放进一条 user 消息', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['summarize_note']);
    const { messages }: any = await client.getPrompt({ name: 'summarize_note', arguments: { path: 'work/oncall.md' } });
    expect(messages[0].role).toBe('user');
    expect(messages[0].content.text).toContain('老周');
  });

  test('stdout 里只有协议消息，日志都在 stderr', async () => {
    const child = spawn(process.execPath, [STDIO], { env: { ...process.env, NOTES_DIR: root } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    expect(stderr).toContain('已启动');
    const lines = stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line), `stdout 里有一行不是 JSON：${line}`).not.toThrow();
  });
});

describe('第 14 天：HTTP 部署', () => {
  let url: string;
  let close: () => void;
  beforeAll(async () => {
    const started = await startHttpServer({ root, port: 0 });
    url = started.url;
    close = () => started.server.close();
  });
  afterAll(() => close());

  test('用第 13 天的 host 连接自己写的服务器，Agent 可以直接用它的工具', async () => {
    const host = await connectMcpServers(parseMcpConfig({ mcpServers: { notes: { url } } }));
    try {
      expect(host.servers[0]).toMatchObject({ status: 'connected', protocolVersion: '2026-07-28' });
      const result = await runToolCall(host.tools, {
        id: 'c1',
        type: 'function',
        function: { name: 'notes__read_note', arguments: JSON.stringify({ path: 'work/release.md' }) },
      });
      expect(result.content).toContain('每周四下午三点');
    } finally {
      await host.close();
    }
  });

  test('防 DNS 重绑定：Origin 或 Host 不是本机的请求，返回 403（TODO 5）', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const evilOrigin = await fetch(url, { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } });
    expect(evilOrigin.status).toBe(403);
    // fetch 不让改 Host 请求头，用 node:http 发
    const evilHost = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(body);
    });
    expect(evilHost).toBe(403);
    const notFound = await fetch(url.replace('/mcp', '/other'));
    expect(notFound.status).toBe(404);
  });
});
