// 第 48 天：上线用的入口。把第 44–47 天的几个接口装进一个进程，加上部署平台需要的三样东西：
//   健康检查：/healthz（活着吗：进程能响应就是 200）和 /readyz（能接活吗：数据库、Redis 都通、没在退出）
//   结构化日志：每个请求一行（logger.ts）
//   优雅退出：收到 SIGTERM（部署新版本、缩容时平台发的）以后，先让 /readyz 变成 503（负载均衡不再派新请求），
//            不再接受新连接，等正在处理的请求做完（SSE 连接通知它们重连），再关闭队列（正在跑的任务改回排队，第 45 天）和数据库，最后退出。
//            超过 SHUTDOWN_TIMEOUT_MS 还没做完就强制关闭
// 运行：ROLE=all node days/day48/solution/server-main.ts（先配好 .env，见 README）
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './logger.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface Route {
  /** 路径前缀，比如 /v1/jobs。最长的前缀优先 */
  prefix: string;
  handle: Handler;
}

/** 一项就绪检查：名字和一个函数，抛错或者返回 false 就是没就绪 */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean | void>;
}

export interface AppOptions {
  routes: Route[];
  checks?: ReadinessCheck[];
  logger: Logger;
  /** 每项就绪检查最多等多久，默认 2 秒：检查本身卡住，也要能回答「没就绪」 */
  checkTimeoutMs?: number;
}

/** 在 ms 毫秒内跑完 fn，超时就抛错 */
async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([fn(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`超时（${ms} 毫秒）`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 应用：路由、健康检查和请求日志。
 * - GET /healthz：200 { status: 'ok' }。只要进程能响应就是活的，不检查依赖：数据库挂了重启进程也没用，反而会让所有实例一起重启
 * - GET /readyz：正在退出就 503 { status: 'shutting_down' }；否则同时跑所有检查（各自带超时），都通过 200 { status: 'ready' }，
 *   有没通过的 503 { status: 'not_ready', failed: [名字…] }（只给名字，不给错误详情）
 * - 其他请求按最长前缀找路由，找不到 404；路由抛出错误时，还没写响应头就返回 500
 * - 每个请求结束时写一条日志：method、path、status、ms
 */
export function createApp(options: AppOptions) {
  const { routes, checks = [], logger, checkTimeoutMs = 2000 } = options;
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  let shuttingDown = false;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const handle: Handler = async (req, res) => {
    const started = performance.now();
    const path = (req.url ?? '/').split('?')[0];
    res.on('finish', () => logger.info('request', { method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - started) }));
    if (path === '/healthz') return json(res, 200, { status: 'ok' });
    if (path === '/readyz') {
      if (shuttingDown) return json(res, 503, { status: 'shutting_down' });
      const results = await Promise.all(checks.map(async ({ name, check }) => ({ name, ok: await withTimeout(check, checkTimeoutMs).then((r) => r !== false, () => false) })));
      const failed = results.filter((r) => !r.ok).map((r) => r.name);
      return failed.length ? json(res, 503, { status: 'not_ready', failed }) : json(res, 200, { status: 'ready' });
    }
    const route = sorted.find((r) => path === r.prefix || path.startsWith(r.prefix.endsWith('/') ? r.prefix : `${r.prefix}/`) || r.prefix === '/');
    if (!route) return json(res, 404, { error: `没有 ${path}` });
    try {
      await route.handle(req, res);
    } catch (error) {
      logger.error('unhandled', { path, error });
      if (!res.headersSent) json(res, 500, { error: '服务出错了' });
      else res.end();
    }
  };
  return {
    handle,
    /** 标记为正在退出：/readyz 从此返回 503 */
    markShuttingDown() {
      shuttingDown = true;
    },
    get shuttingDown() {
      return shuttingDown;
    },
  };
}

export interface RunningApp {
  url: string;
  server: Server;
  /** 优雅退出。返回 'clean'（都做完了）或 'forced'（超时，强制关了） */
  shutdown(reason?: string): Promise<'clean' | 'forced'>;
}

export interface StartOptions extends AppOptions {
  port?: number;
  host?: string;
  /** 退出时依次调用：先关队列、再关数据库……按传入的顺序，一个出错不影响后面的 */
  onShutdown?: { name: string; close: () => Promise<void> }[];
  /** 最多等多久，默认 25 秒（Docker 默认 10 秒后发 SIGKILL，compose 里要把 stop_grace_period 调到比它长） */
  shutdownTimeoutMs?: number;
  /** 退出前先等一会儿，让负载均衡发现 /readyz 变成了 503，不再派新请求过来，默认 0 */
  drainDelayMs?: number;
}

/**
 * 启动，并返回 shutdown：
 * 1. markShuttingDown；等 drainDelayMs
 * 2. server.close()：不再接受新连接，已有的请求做完后连接关闭；空闲的 keep-alive 连接要主动关掉（closeIdleConnections），
 *    请求做完以后变成空闲的连接也要关，所以退出期间每隔 100 毫秒关一次
 * 3. 等 server 关闭，最多 shutdownTimeoutMs；超时就 closeAllConnections，结果是 forced
 * 4. 依次调用 onShutdown（出错写日志，接着关下一个）
 * shutdown 调用多次，只执行一次（返回同一个 Promise）
 */
export async function startApp(options: StartOptions): Promise<RunningApp> {
  const { port = 0, host = '127.0.0.1', onShutdown = [], shutdownTimeoutMs = 25_000, drainDelayMs = 0, logger } = options;
  const app = createApp(options);
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as { port: number };
  let shutting: Promise<'clean' | 'forced'> | undefined;
  const shutdown = (reason = 'shutdown') => {
    shutting ??= (async () => {
      logger.info('shutting down', { reason });
      app.markShuttingDown();
      if (drainDelayMs) await new Promise((r) => setTimeout(r, drainDelayMs));
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // 正在处理的请求做完以后，keep-alive 的连接会变成空闲的，不关掉它 server 就一直关不上：每隔 100 毫秒关一次空闲的连接
      server.closeIdleConnections();
      const idle = setInterval(() => server.closeIdleConnections(), 100);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([closed.then(() => 'clean' as const), new Promise<'forced'>((resolve) => (timer = setTimeout(() => resolve('forced'), shutdownTimeoutMs)))]);
      clearTimeout(timer);
      clearInterval(idle);
      if (outcome === 'forced') {
        logger.warn('shutdown timed out, closing connections');
        server.closeAllConnections();
      }
      for (const { name, close } of onShutdown) {
        try {
          await close();
        } catch (error) {
          logger.error('close failed', { name, error });
        }
      }
      logger.info('stopped', { outcome });
      return outcome;
    })();
    return shutting;
  };
  return { url: `http://${host}:${address.port}`, server, shutdown };
}

/** 组装线上的进程：按配置创建依赖，按 ROLE 决定跑哪些部分，接上信号 */
async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // 生产上由平台注入环境变量，没有 .env 文件
  }
  const { loadConfig, describeConfig } = await import('./config.ts');
  const { createLogger } = await import('./logger.ts');
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(`配置有问题：\n${loaded.problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  const config = loaded.config;
  const logger = createLogger({ level: config.LOG_LEVEL, base: { role: config.ROLE } });
  logger.info('config', describeConfig(config));

  const { join } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const { createPgDb, createPgliteDb, migrate } = await import('./db.ts');
  const { migrateFiles } = await import('./ingest.ts');
  const { createFsObjectStore } = await import('./uploads.ts');
  const { createFilesApp } = await import('./files-server.ts');
  const { createJobsApp } = await import('./jobs-server.ts');
  const { createWebApp } = await import('./web-server.ts');
  const { createResearchRunner } = await import('./worker.ts');
  const { createMemoryJobStore, createMemoryQueue, recoverJobs } = await import('./jobs.ts');
  const { createModel } = await import('./providers.ts');
  const { createOpenAIEmbedder, embeddingConfigFromEnv } = await import('./rag/embeddings.ts');
  const { searchProviderFromEnv } = await import('./search.ts');
  const { parseApiKeys } = await import('./service.ts');
  const { visionConfigFromEnv } = await import('./vision.ts');

  const db = config.DATABASE_URL ? createPgDb(config.DATABASE_URL) : await createPgliteDb();
  await migrate(db);
  await migrateFiles(db);
  await mkdir(config.OBJECT_DIR, { recursive: true });
  const workspaceRoot = join(config.OBJECT_DIR, '..', 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const model = createModel('openai');
  const search = searchProviderFromEnv();
  const makeSetup = async (job?: { userId?: string }) => {
    const dir = join(workspaceRoot, 'users', (job?.userId ?? 'anonymous').replace(/[^\w.-]/g, '_'));
    await mkdir(dir, { recursive: true });
    return { workspace: dir, search };
  };
  const runner = (store: import('./jobs.ts').JobStore) => createResearchRunner({ store, model, makeSetup, checkpointDir: join(workspaceRoot, 'checkpoints') });

  let store: import('./jobs.ts').JobStore;
  let queue: import('./jobs.ts').JobQueue | undefined;
  const closers: StartOptions['onShutdown'] = [];
  const checks: ReadinessCheck[] = [{ name: 'database', check: async () => void (await db.query('select 1')) }];
  if (config.REDIS_URL) {
    const { createRedisJobStore, createBullQueue } = await import('./jobs-bullmq.ts');
    const redisStore = createRedisJobStore(config.REDIS_URL);
    store = redisStore;
    // web 也要能提交任务：BullMQ 的 Queue 只负责放任务，worker 角色的进程才真正执行
    queue = createBullQueue({ redisUrl: config.REDIS_URL, store, run: runner(store), worker: config.ROLE !== 'web' });
    checks.push({ name: 'redis', check: async () => (await redisStore.list('running'), true) });
    closers.push({ name: 'queue', close: () => queue!.close() }, { name: 'redis', close: () => redisStore.close() });
  } else {
    store = createMemoryJobStore();
    queue = createMemoryQueue({ store, run: runner(store) });
    await recoverJobs(store, queue);
    closers.push({ name: 'queue', close: () => queue!.close() });
  }
  closers.push({ name: 'database', close: () => db.close() });

  let embedder;
  try {
    embedder = createOpenAIEmbedder(embeddingConfigFromEnv());
  } catch {
    embedder = undefined;
    logger.info('files route disabled', { reason: 'EMBEDDING_MODEL not configured' });
  }
  let vision;
  try {
    vision = visionConfigFromEnv();
  } catch {
    vision = undefined;
  }
  const routes: Route[] =
    config.ROLE === 'worker'
      ? []
      : [
          { prefix: '/v1/jobs', handle: createJobsApp({ store, queue, apiKeys: parseApiKeys(process.env.SERVICE_API_KEYS) }) },
          ...(embedder ? [{ prefix: '/v1/files', handle: createFilesApp({ db, store: createFsObjectStore(config.OBJECT_DIR), embedder, vision }).handle }] : []),
          { prefix: '/', handle: createWebApp({ model, makeSetup }) },
        ];
  const app = await startApp({ routes, checks, logger, port: config.PORT, host: '0.0.0.0', onShutdown: closers, shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS, drainDelayMs: config.NODE_ENV === 'production' ? 5000 : 0 });
  logger.info('listening', { url: app.url });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void app.shutdown(signal).then((outcome) => process.exit(outcome === 'clean' ? 0 : 1)));
  }
}

if (import.meta.main) await main();
