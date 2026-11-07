// 第 14 天：用 Streamable HTTP 部署笔记服务器。运行：NOTES_DIR=/path/to/notes node days/day14/solution/server/http.ts
// 默认只监听 127.0.0.1。要给别人用，得放在有认证的反向代理后面（第 48 天部署时再讲）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { createNotesServer, log, notesRootFromEnv } from './notes.ts';

/** 请求体最多 1 MB，免得有人发一个超大的请求把内存撑爆 */
const MAX_BODY = 1_000_000;

/** node:http 的请求转成标准的 Request */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

/** 标准的 Response 写回 node:http。SSE 的回复是流式的，边收边写 */
async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

export interface HttpServerOptions {
  root: string;
  port?: number;
  host?: string;
}

/** 启动 HTTP 服务器，只在 /mcp 上提供 MCP。返回实际的地址，方便测试用随机端口 */
export async function startHttpServer({ root, port = 3014, host = '127.0.0.1' }: HttpServerOptions): Promise<{ url: string; server: Server }> {
  const handler = createMcpHandler(() => createNotesServer(root));
  const server = createServer(async (req, res) => {
    try {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('MCP 服务在 /mcp');
        return;
      }
      const request = await toRequest(req);
      // 防 DNS 重绑定：恶意网页可以让浏览器把它的域名解析到 127.0.0.1，再用 JavaScript 访问你本机的服务。
      // 检查 Host 和 Origin 请求头，只接受本机的地址
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
      await sendResponse(rejected ?? (await handler.fetch(request)), res);
    } catch (error) {
      log(`请求出错：${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((error as Error).message);
    }
  });
  await new Promise<void>((done) => server.listen(port, host, done));
  const address = server.address() as AddressInfo;
  return { url: `http://${host}:${address.port}/mcp`, server };
}

if (import.meta.main) {
  const root = resolve(notesRootFromEnv());
  const { url } = await startHttpServer({ root, port: Number(process.env.PORT ?? 3014) });
  log(`已启动：${url}，笔记目录 ${root}`);
}
