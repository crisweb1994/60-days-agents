// 第 47 天：文件的接口。
//   POST /v1/files              上传（multipart，字段 file），马上返回 202 和文件记录，后台建索引
//   GET  /v1/files              我的文件
//   GET  /v1/files/:id          一个文件的状态（uploaded / indexing / ready / failed）
//   GET  /v1/files/:id/content  下载原文件
// 鉴权用第 46 天的 API Key；所有查询都走 withTenant，别人的文件一律 404。
// 下载时的几个响应头：Content-Type 用我们自己认出来的类型，不用上传时写的；Content-Disposition: attachment 让浏览器下载而不是打开；
// X-Content-Type-Options: nosniff 不许浏览器自己猜类型。不然有人上传一个「图片」，里面其实是 HTML，你的域名下就多了一个钓鱼网页。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { findUserByApiKey } from './auth.ts';
import type { Db } from './db.ts';
import { getFile, ingestFile, listFiles, saveUpload, type IngestOptions } from './ingest.ts';
import { MIME, readUpload, UploadError, type ObjectStore } from './uploads.ts';

export interface FilesAppOptions extends Omit<IngestOptions, 'signal'> {
  db: Db;
  store: ObjectStore;
  /** 上传的总大小上限，默认 20MB */
  maxBytes?: number;
}

/** 下载时的文件名：RFC 5987 的 filename*，中文文件名也能正确显示 */
export function contentDisposition(name: string): string {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createFilesApp(options: FilesAppOptions) {
  const { db, store, maxBytes } = options;
  const pending = new Set<Promise<unknown>>();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const userId = await findUserByApiKey(db, key);
      if (!userId) return json(res, 401, { error: '缺少或者无效的 API Key' });
      if (pathname === '/v1/files' && req.method === 'POST') {
        const file = await saveUpload(db, store, userId, await readUpload(req, maxBytes));
        const task = ingestFile(db, store, userId, file.id, options);
        pending.add(task);
        void task.finally(() => pending.delete(task));
        return json(res, 202, file);
      }
      if (pathname === '/v1/files' && req.method === 'GET') return json(res, 200, await listFiles(db, userId));
      const match = /^\/v1\/files\/([\w-]+)(\/content)?$/.exec(pathname);
      if (!match || req.method !== 'GET') return json(res, 404, { error: `没有 ${pathname}` });
      const file = await getFile(db, userId, match[1]);
      if (!file) return json(res, 404, { error: '没有这个文件' });
      if (!match[2]) {
        const { objectKey: _key, ...record } = file;
        return json(res, 200, record);
      }
      const bytes = await store.get(file.objectKey);
      res.writeHead(200, {
        'content-type': MIME[file.kind],
        'content-length': String(bytes.byteLength),
        'content-disposition': contentDisposition(file.name),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      });
      res.end(bytes);
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof UploadError) return json(res, error.status, { error: error.message });
      json(res, 500, { error: '服务出错了' });
    }
  };
  return {
    handle,
    /** 等后台的索引任务都结束（测试用；线上用第 45 天的队列） */
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export async function startFilesApp(options: FilesAppOptions & { port?: number }) {
  const app = createFilesApp(options);
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    idle: app.idle,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
