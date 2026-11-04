import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { startHttpNotesServer } from './fixtures/notes.ts';

const mcp = await loadTarget<typeof import('../solution/mcp.ts')>(import.meta.url, 'mcp.ts');
const { runToolCall, toToolDefinition } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { connectMcpServers, expandEnv, formatToolResult, loadMcpConfig, parseMcpConfig, toolName } = mcp;

const STDIO_SERVER = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));
const stdio = (extra: object = {}) => ({ command: process.execPath, args: [STDIO_SERVER], ...extra });
const http = await startHttpNotesServer();
afterAll(() => http.close());

let nextId = 1;
const call = (name: string, args: object) => ({ id: `call_${nextId++}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('第 13 天：读取配置（TODO 1）', () => {
  test('expandEnv：${VAR} 换成环境变量；没有设置就报错，说明是哪个变量', () => {
    expect(expandEnv('Bearer ${TOKEN}', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(() => expandEnv('${MISSING_TOKEN}', {})).toThrow('MISSING_TOKEN');
  });

  test('parseMcpConfig：嵌套在 args、env、headers 里的 ${VAR} 都要展开', () => {
    const config = parseMcpConfig(
      {
        mcpServers: {
          local: { command: 'node', args: ['server.js', '--key=${KEY}'], env: { API_KEY: '${KEY}' } },
          remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${KEY}' } },
        },
      },
      { KEY: 'k-1' },
    );
    expect(config.mcpServers.local).toMatchObject({ args: ['server.js', '--key=k-1'], env: { API_KEY: 'k-1' } });
    expect(config.mcpServers.remote).toMatchObject({ headers: { Authorization: 'Bearer k-1' } });
  });

  test('格式不对：说明是哪个字段', () => {
    expect(() => parseMcpConfig({ mcpServers: { 'bad name': { command: 'x' } } })).toThrow('名字');
    expect(() => parseMcpConfig({ servers: {} })).toThrow('mcpServers');
  });

  test('loadMcpConfig：文件不存在返回 undefined；不是 JSON 时报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'day13-config-'));
    expect(await loadMcpConfig(join(dir, 'mcp.json'))).toBeUndefined();
    await writeFile(join(dir, 'broken.json'), '{ mcpServers: ');
    await expect(loadMcpConfig(join(dir, 'broken.json'))).rejects.toThrow('不是合法的 JSON');
  });
});

describe('第 13 天：MCP 工具转换成我们的工具（TODO 2、3）', () => {
  test('toolName：加上服务器名做前缀，不允许的字符换成 _，最长 64 个字符', () => {
    expect(toolName('github', 'create_issue')).toBe('github__create_issue');
    expect(toolName('notes', 'search.notes v2')).toBe('notes__search_notes_v2');
    expect(toolName('s', 'x'.repeat(100))).toHaveLength(64);
  });

  test('formatToolResult：文字拼起来，图片和资源链接写成占位说明；只有结构化结果时转成 JSON', () => {
    expect(
      formatToolResult({
        content: [
          { type: 'text', text: '第一段' },
          { type: 'image', data: 'xx', mimeType: 'image/png' },
          { type: 'resource_link', name: '数据', uri: 'notes://a' },
          { type: 'resource', resource: { uri: 'notes://b', text: '嵌入的文字' } },
        ],
      }),
    ).toBe('第一段\n[图片：image/png，没有显示]\n[资源链接：数据 notes://a]\n嵌入的文字');
    expect(formatToolResult({ content: [], structuredContent: { notes: 2 } })).toBe('{"notes":2}');
  });

  test('wrapMcpTool：参数用服务器给的 JSON Schema；只读的工具不用确认，其他的要确认，信任的服务器都不用', () => {
    const client = { callTool: async () => ({ content: [] }) };
    const definition = { name: 'search', description: '搜索', inputSchema: { type: 'object' as const, properties: { q: { type: 'string' } } } };
    const tool = mcp.wrapMcpTool(client as never, 'notes', definition);
    expect(tool.name).toBe('notes__search');
    expect(tool.description).toContain('notes');
    expect(toToolDefinition(tool).function.parameters).toEqual(definition.inputSchema);
    expect(tool.requiresApproval, '服务器没说是只读的，就要确认').toBe(true);
    expect(mcp.wrapMcpTool(client as never, 'notes', { ...definition, annotations: { readOnlyHint: true } }).requiresApproval).toBe(false);
    expect(mcp.wrapMcpTool(client as never, 'notes', definition, true).requiresApproval).toBe(false);
  });
});

describe('第 13 天：连接服务器（TODO 4）', () => {
  test('stdio：用 2026-07-28 协议连上，列出工具，调用工具', async () => {
    const host = await connectMcpServers(parseMcpConfig({ mcpServers: { notes: stdio() } }));
    try {
      expect(host.servers[0]).toMatchObject({ name: 'notes', status: 'connected', protocolVersion: '2026-07-28', serverInfo: 'team-notes 1.2.0' });
      expect(host.tools.map((t) => t.name)).toEqual(['notes__search_notes', 'notes__add_note', 'notes__broken', 'notes__chart', 'notes__stats']);
      const result = await runToolCall(host.tools, call('notes__search_notes', { query: '值班' }));
      expect(result).toEqual({ content: '值班表：十一月的值班负责人是蓝鲸组的老周。', isError: false });
    } finally {
      await host.close();
    }
  });

  test('服务器返回 isError：作为出错的结果交回模型', async () => {
    const host = await connectMcpServers(parseMcpConfig({ mcpServers: { notes: stdio() } }));
    try {
      const result = await runToolCall(host.tools, call('notes__broken', {}), { confirm: async () => true });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('数据库连接失败');
      const invalid = await runToolCall(host.tools, call('notes__search_notes', { query: 42 }));
      expect(invalid.isError, '参数不对时服务器会报错').toBe(true);
    } finally {
      await host.close();
    }
  });

  test('Streamable HTTP：带上配置里的请求头；protocol: legacy 时用老版本的握手', async () => {
    const host = await connectMcpServers(
      parseMcpConfig({
        mcpServers: {
          modern: { url: http.url, headers: { Authorization: 'Bearer ${NOTES_TOKEN}' } },
          old: { url: http.url, protocol: 'legacy' },
        },
      }, { NOTES_TOKEN: 'secret' }),
    );
    try {
      expect(host.servers.map((s) => [s.name, s.protocolVersion])).toEqual([
        ['modern', '2026-07-28'],
        ['old', '2025-11-25'],
      ]);
      expect(http.headers.some((h) => h.authorization === 'Bearer secret')).toBe(true);
      const result = await runToolCall(host.tools, call('old__chart', {}), { confirm: async () => true });
      expect(result.content).toContain('[图片：image/png');
    } finally {
      await host.close();
    }
  });

  test('一个服务器连不上，不影响其他的；连不上的原因记下来', async () => {
    const host = await connectMcpServers(
      parseMcpConfig({ mcpServers: { good: stdio(), missing: { command: join(tmpdir(), 'no-such-command-day13') } } }),
      { timeoutMs: 10_000 },
    );
    try {
      const missing = host.servers.find((s) => s.name === 'missing');
      expect(missing?.status).toBe('failed');
      expect(missing?.error).toBeTruthy();
      expect(host.servers.find((s) => s.name === 'good')?.status).toBe('connected');
      expect(host.tools.length).toBe(5);
    } finally {
      await host.close();
    }
  });
});
