// 第 13 天测试用的 MCP 服务器：一个虚构的「团队笔记」服务。用官方 SDK 写的，第 14 天你会自己写一个。
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const NOTES = [
  { id: 'n1', title: '发布流程', text: '每周四下午三点发布，发布前要在 #release 频道里说一声。' },
  { id: 'n2', title: '值班表', text: '十一月的值班负责人是蓝鲸组的老周。' },
];

export function createNotesServer(name = 'team-notes'): McpServer {
  const server = new McpServer({ name, version: '1.2.0' });
  server.registerTool(
    'search_notes',
    {
      description: '按关键词搜索团队笔记，返回匹配的笔记',
      inputSchema: z.object({ query: z.string().describe('关键词') }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const hits = NOTES.filter((n) => n.title.includes(query) || n.text.includes(query));
      return { content: [{ type: 'text', text: hits.length ? hits.map((n) => `${n.title}：${n.text}`).join('\n') : '没有找到' }] };
    },
  );
  server.registerTool(
    'add_note',
    { description: '新建一条笔记', inputSchema: z.object({ title: z.string(), text: z.string() }) },
    async ({ title }) => ({ content: [{ type: 'text', text: `已新建笔记「${title}」` }] }),
  );
  server.registerTool('broken', { description: '总是出错的工具' }, async () => ({
    content: [{ type: 'text', text: '数据库连接失败' }],
    isError: true,
  }));
  server.registerTool('chart', { description: '返回一张图和一个资源链接' }, async () => ({
    content: [
      { type: 'text', text: '本周的发布次数：3' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'resource_link', name: '原始数据', uri: 'notes://stats/week' },
    ],
  }));
  server.registerTool(
    'stats',
    { description: '只返回结构化结果', outputSchema: z.object({ notes: z.number() }) },
    async () => ({ content: [], structuredContent: { notes: NOTES.length } }),
  );
  return server;
}

/** 在本进程里启动一个 Streamable HTTP 的 MCP 服务器，返回它的地址 */
export async function startHttpNotesServer(name = 'remote-notes') {
  const handler = createMcpHandler(() => createNotesServer(name));
  const headers: Record<string, string | undefined>[] = [];
  const server = createServer(async (req, res) => {
    headers.push({ authorization: req.headers.authorization, version: req.headers['mcp-protocol-version'] as string | undefined });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    headers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
