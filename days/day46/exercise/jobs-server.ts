// 第 45 天：后台研究任务的 HTTP 接口。
//   POST   /v1/jobs             提交，马上返回 202 和任务编号
//   GET    /v1/jobs/:id         任务的状态和结果
//   GET    /v1/jobs/:id/events  SSE：先补发错过的块，再实时推送新的；带 Last-Event-ID 时只补发后面的
//   DELETE /v1/jobs/:id         取消
// 鉴权沿用第 40 天的 API Key；每个任务属于提交它的用户，别人一律 404。
// 运行：SERVICE_API_KEYS=dev-key:me node days/day45/solution/jobs-server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FINAL_STATUSES, TERMINAL_CHUNKS, type JobEvent, type JobQueue, type JobRecord, type JobStore } from './jobs.ts';
import { authenticate, hashApiKeys, HttpError, readJsonBody, type ServiceUser } from './service.ts';
import { UI_STREAM_HEADERS } from './ui-stream.ts';
import { WebRequestSchema } from './web-server.ts';

/** 一块写成带 id 的 SSE 事件：浏览器的 EventSource 重连时会把最后收到的 id 放进 Last-Event-ID */
export function toSSEWithId(event: JobEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event.chunk)}\n\n`;
}

/** 从哪个序号之后开始补发：Last-Event-ID 头优先，其次是 ?after=，都没有就是 0。不是非负整数的当作 0 */
export function resumeFrom(req: IncomingMessage): number {
  const header = req.headers['last-event-id'];
  const raw = (Array.isArray(header) ? header[0] : header) ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('after') ?? '0';
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * 推送一个任务的块：
 * 1. 先订阅，再补发已经存下的块（seq > after）。顺序反过来，会漏掉「读完、订阅之前」存进来的块
 * 2. 所有的发送排成一条链：补发在前，实时的块在后；按 seq 去重。实时的块和已发的之间有空档（比如 Redis 的订阅晚生效了），先从存储里补上空档
 * 3. 补发完看一眼任务：已经结束了就把剩下的块补齐、结束。worker 先存结束的块、后改状态，所以这时结束的块一定已经存下了
 * 4. 发出了结束的块（finish、abort）就写 [DONE]、结束响应；每隔 heartbeatMs 写一行注释；连接断开时取消订阅、清掉定时器
 */
export async function streamJobEvents(res: ServerResponse, store: JobStore, jobId: string, after: number, heartbeatMs = 15_000): Promise<void> {
  res.writeHead(200, UI_STREAM_HEADERS);
  let last = after;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const end = () => {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    done();
  };
  const send = (event: JobEvent) => {
    if (event.seq <= last || res.writableEnded) return;
    last = event.seq;
    res.write(toSSEWithId(event));
    if (TERMINAL_CHUNKS.has(event.chunk.type)) end();
  };
  const catchUp = async () => {
    for (const event of await store.events(jobId, last)) send(event);
  };
  let chain = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    chain = chain.then(step).catch(() => end());
  };
  const unsubscribe = store.subscribe(jobId, (event) =>
    enqueue(async () => {
      if (event.seq > last + 1) await catchUp();
      send(event);
    }),
  );
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), heartbeatMs);
  res.on('close', () => done());
  enqueue(catchUp);
  enqueue(async () => {
    const job = await store.get(jobId);
    if (!job || FINAL_STATUSES.has(job.status)) {
      await catchUp();
      end();
    }
  });
  try {
    await finished;
  } finally {
    unsubscribe();
    clearInterval(heartbeat);
  }
}

/** 给用户看的任务：去掉内部的错误和取消标记 */
export function publicJob({ error: _error, cancelRequested: _cancel, userId: _user, ...rest }: JobRecord) {
  return rest;
}

export interface JobsAppOptions {
  store: JobStore;
  queue: JobQueue;
  apiKeys: Record<string, ServiceUser>;
  heartbeatMs?: number;
}

export function createJobsApp(options: JobsAppOptions) {
  const { store, queue, heartbeatMs } = options;
  const keys = hashApiKeys(options.apiKeys);
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  /** 找到这个用户的任务。别人的也说没有 */
  const own = async (id: string, user: ServiceUser) => {
    const job = await store.get(id);
    if (!job || job.userId !== user.id) throw new HttpError(404, '没有这个任务');
    return job;
  };

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      const user = authenticate(req.headers.authorization, keys);
      if (!user) throw new HttpError(401, '缺少或者无效的 API Key', { 'www-authenticate': 'Bearer' });
      if (pathname === '/v1/jobs' && method === 'POST') {
        const parsed = WebRequestSchema.safeParse(await readJsonBody(req, 16 * 1024));
        if (!parsed.success) throw new HttpError(400, `参数不对：${parsed.error.issues[0].message}`);
        const job = await store.create({ userId: user.id, ...parsed.data });
        await queue.enqueue(job.id);
        return json(res, 202, { id: job.id, status: job.status }, { location: `/v1/jobs/${job.id}` });
      }
      const match = /^\/v1\/jobs\/([^/]+)(\/events)?$/.exec(pathname);
      if (!match) throw new HttpError(404, `没有 ${pathname} 这个接口`);
      const job = await own(match[1], user);
      if (match[2] && method === 'GET') return await streamJobEvents(res, store, job.id, resumeFrom(req), heartbeatMs);
      if (!match[2] && method === 'GET') return json(res, 200, publicJob(job));
      if (!match[2] && method === 'DELETE') {
        if (FINAL_STATUSES.has(job.status)) throw new HttpError(409, `任务已经结束了（${job.status}）`);
        await queue.cancel(job.id);
        return json(res, 202, { id: job.id, status: 'cancelling' });
      }
      throw new HttpError(405, '不支持这个方法');
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) return json(res, error.status, { error: error.message }, error.headers);
      json(res, 500, { error: '服务出错了' });
    }
  };
}

export async function startJobsApp(options: JobsAppOptions & { port?: number }): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => void createJobsApp(options)(req, res));
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
  const { resolve, join } = await import('node:path');
  const { mkdir, mkdtemp } = await import('node:fs/promises');
  const { createModel, providerFromEnv } = await import('./providers.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { loadDocs } = await import('./docs-setup.ts');
  const { parseApiKeys } = await import('./service.ts');
  const { createMemoryJobStore, createMemoryQueue, recoverJobs } = await import('./jobs.ts');
  const { createResearchRunner } = await import('./worker.ts');
  const root = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  await mkdir(root, { recursive: true });
  const docs = await loadDocs(process.env.DOCS_DIR);
  const runnerOptions = {
    model: createModel(providerFromEnv()),
    checkpointDir: join(root, 'checkpoints'),
    makeSetup: async () => ({ workspace: await mkdtemp(join(root, 'job-')), search: searchProviderFromEnv(), docs }),
  };
  let store: JobStore;
  let queue: JobQueue;
  if (process.env.REDIS_URL) {
    const { createBullQueue, createRedisJobStore } = await import('./jobs-bullmq.ts');
    store = createRedisJobStore(process.env.REDIS_URL);
    queue = createBullQueue({ redisUrl: process.env.REDIS_URL, store, run: createResearchRunner({ store, ...runnerOptions }) });
  } else {
    store = createMemoryJobStore();
    queue = createMemoryQueue({ store, run: createResearchRunner({ store, ...runnerOptions }) });
    await recoverJobs(store, queue);
  }
  const { url } = await startJobsApp({ port: Number(process.env.PORT ?? 8789), store, queue, apiKeys: parseApiKeys(process.env.SERVICE_API_KEYS) });
  console.error(`后台研究任务的接口：${url}（${process.env.REDIS_URL ? 'Redis + BullMQ' : '内存队列'}）`);
}
