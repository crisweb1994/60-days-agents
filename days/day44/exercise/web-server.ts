// 第 44 天：研究助手的 Web 界面。一个 node:http 服务器：
//   GET  /             网页（public/index.html）
//   GET  /app.js       网页的脚本
//   GET  /timeline.js  timeline.ts 去掉类型以后发给浏览器：前后端用同一份归并逻辑
//   POST /api/research 跑一次研究，用 SSE 推送 UI 消息流（ui-stream.ts）
// 断开连接（用户点了停止、关了网页）就取消研究，不再花钱。长时间没有新的块时，每隔一会儿发一行注释保持连接。
// 鉴权、并发上限、额度见第 40 天的 service.ts，这里先不重复，第 46 天再换成登录。
// 第 44 天的练习：TODO 4 在这里。检查：npm run check 44
// 运行：node days/day44/exercise/web-server.ts，然后打开 http://localhost:8788
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import type { ResearchSetup } from './research.ts';
import { readJsonBody, HttpError } from './service.ts';
import type { Model } from './types.ts';
import { streamResearch, toSSE, UI_STREAM_HEADERS, type ResearchChunk } from './ui-stream.ts';

const here = import.meta.dirname;

export const WebRequestSchema = z.strictObject({
  question: z.string().trim().min(1, '问题不能是空的').max(4000, '问题太长了'),
  mode: z.enum(['quick', 'deep']).default('quick'),
});

export interface WebAppOptions {
  model: Model;
  makeSetup: () => Promise<ResearchSetup>;
  /** 多久没有新的块就发一行注释，默认 15 秒。代理和浏览器会断开长时间没有数据的连接 */
  heartbeatMs?: number;
  /** 每次研究结束时回调：completed、aborted、error。测试和日志用 */
  onRunEnd?: (info: { status: 'completed' | 'aborted' | 'error'; error?: unknown }) => void;
  now?: () => Date;
}

/** timeline.ts 去掉类型，变成浏览器能直接运行的 JavaScript。Node 22.13 起自带这个功能，不用打包工具 */
export async function browserTimeline(): Promise<string> {
  return stripTypeScriptTypes(await readFile(join(here, 'timeline.ts'), 'utf8'));
}

/**
 * 用 SSE 推送一次研究：
 * - 先写响应头（UI_STREAM_HEADERS）
 * - 每一块写成一个 SSE 事件；全部写完再写 [DONE]，然后结束响应
 * - 响应关闭了（res 的 close 事件，而且还没正常写完）：触发 AbortController，研究跟着停下
 * - 每隔 heartbeatMs 写一行「: ping」
 * - 研究结束（不管怎样结束）都要清掉定时器，回调 onRunEnd
 */
export async function pipeResearch(res: ServerResponse, question: string, mode: 'quick' | 'deep', options: WebAppOptions): Promise<void> {
  // TODO 4：按上面注释实现。要点：
  // - res.writeHead(200, UI_STREAM_HEADERS)
  // - 一个 AbortController；res.on('close')：还没写完（!res.writableFinished）就 abort
  // - setInterval 每 heartbeatMs 写「: ping\n\n」
  // - streamResearch(question, await options.makeSetup(), { model, mode, signal, now }, 每块 res.write(toSSE(块)), 出错记下来)
  // - finally：clearInterval；写 [DONE]；res.end()；onRunEnd：signal 触发过（或者发过 abort 块）是 aborted，有错误是 error，否则 completed
  // 写之前检查 res.writableEnded，连接断了就别再写
  void streamResearch; void toSSE; void UI_STREAM_HEADERS;
  void question; void mode; void options;
  res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('TODO 4：还没有实现 pipeResearch');
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
};

export function createWebApp(options: WebAppOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && STATIC[pathname]) {
        const { file, type } = STATIC[pathname];
        res.writeHead(200, { 'content-type': type });
        return void res.end(await readFile(join(here, file)));
      }
      if (req.method === 'GET' && pathname === '/timeline.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return void res.end(await browserTimeline());
      }
      if (pathname === '/api/research') {
        if (req.method !== 'POST') throw new HttpError(405, '只支持 POST', { allow: 'POST' });
        const parsed = WebRequestSchema.safeParse(await readJsonBody(req, 16 * 1024));
        if (!parsed.success) throw new HttpError(400, `参数不对：${parsed.error.issues[0].message}`);
        return await pipeResearch(res, parsed.data.question, parsed.data.mode, options);
      }
      throw new HttpError(404, `没有 ${pathname}`);
    } catch (error) {
      if (res.headersSent) return void res.end();
      const status = error instanceof HttpError ? error.status : 500;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(error instanceof HttpError ? error.headers : {}) });
      res.end(JSON.stringify({ error: error instanceof HttpError ? error.message : '服务出错了' }));
    }
  };
}

export async function startWebApp(options: WebAppOptions & { port?: number }): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => void createWebApp(options)(req, res));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve, join: joinPath } = await import('node:path');
  const { mkdir, mkdtemp } = await import('node:fs/promises');
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { loadDocs } = await import('./docs-setup.ts');
  const root = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  await mkdir(root, { recursive: true });
  const docs = await loadDocs(process.env.DOCS_DIR);
  const { url } = await startWebApp({
    port: Number(process.env.PORT ?? 8788),
    model: createModel(providerFromEnv()),
    makeSetup: async () => ({ workspace: await mkdtemp(joinPath(root, 'web-')), search: searchProviderFromEnv(), docs }),
    onRunEnd: (info) => console.error(`研究结束：${info.status}${info.error ? `（${(info.error as Error).message}）` : ''}`),
  });
  console.error(`研究助手的网页：${url.replace('127.0.0.1', 'localhost')}`);
}
