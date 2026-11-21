// 第 45 天：多进程、多机器时的实现：任务记录和事件存在 Redis 里，队列用 BullMQ。接口和 jobs.ts 的内存实现一样，
// worker.ts、jobs-server.ts 一行都不用改。
//   任务记录：research:job:<id>（JSON）；按状态分的集合 research:status:<状态>，恢复和管理后台用
//   事件：research:events:<id> 是一个列表，RPUSH 返回的长度就是序号（原子操作，几个进程同时写也不会重号）；
//         写完再 PUBLISH 到同名的频道，订阅的 SSE 连接马上收到
//   取消：还在排队的直接从 BullMQ 里删掉；正在跑的，往 research:cancel 频道发消息，每个 worker 都订阅了，持有这个任务的那个调用 cancelJob
//   崩溃恢复：BullMQ 自己会发现「停滞」的任务（持有它的 worker 不再续租），重新放回队列，不需要 recoverJobs
// 第 48 天：worker: false 时只放任务、不执行（web 角色）。
// 需要 Redis：docker run -d -p 6379:6379 redis:7，然后设 REDIS_URL=redis://localhost:6379
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Redis, type RedisOptions } from 'ioredis';
import { FINAL_STATUSES, type JobEvent, type JobQueue, type JobRecord, type JobRunner, type JobStatus, type JobStore } from './jobs.ts';

const PREFIX = 'research';
const jobKey = (id: string) => `${PREFIX}:job:${id}`;
const statusKey = (status: JobStatus) => `${PREFIX}:status:${status}`;
const eventsKey = (id: string) => `${PREFIX}:events:${id}`;
const CANCEL_CHANNEL = `${PREFIX}:cancel`;

function connectRedis(redisUrl: string, options?: RedisOptions) {
  const client = options ? new Redis(redisUrl, options) : new Redis(redisUrl);
  // 避免短暂断连触发 Node 未捕获的 error 事件导致进程崩溃
  client.on('error', () => {});
  return client;
}

const DEFAULT_JOB_TTL_SECONDS = 7 * 86_400;

export function createRedisJobStore(redisUrl: string, now: () => Date = () => new Date(), ttlSeconds = DEFAULT_JOB_TTL_SECONDS): JobStore & { close(): Promise<void> } {
  const redis = connectRedis(redisUrl);
  const sub = connectRedis(redisUrl);
  const listeners = new Map<string, Set<(event: JobEvent) => void>>();
  sub.on('message', (channel: string, message: string) => {
    const id = channel.slice(eventsKey('').length);
    const event = JSON.parse(message) as JobEvent;
    for (const listener of listeners.get(id) ?? []) listener(event);
  });
  const read = async (id: string) => {
    const text = await redis.get(jobKey(id));
    return text ? (JSON.parse(text) as JobRecord) : undefined;
  };
  return {
    async create(input) {
      const time = now().toISOString();
      const job: JobRecord = { id: randomUUID(), ...input, status: 'queued', attempts: 0, createdAt: time, updatedAt: time };
      await redis.multi().set(jobKey(job.id), JSON.stringify(job)).sadd(statusKey('queued'), job.id).exec();
      return job;
    },
    get: read,
    async update(id, patch) {
      const job = await read(id);
      if (!job) throw new Error(`没有任务 ${id}`);
      const next: JobRecord = { ...job, ...patch, updatedAt: now().toISOString() };
      const tx = redis.multi().set(jobKey(id), JSON.stringify(next));
      if (next.status !== job.status) tx.srem(statusKey(job.status), id).sadd(statusKey(next.status), id);
      if (FINAL_STATUSES.has(next.status) && ttlSeconds > 0) tx.expire(jobKey(id), ttlSeconds).expire(eventsKey(id), ttlSeconds);
      await tx.exec();
      return next;
    },
    async appendEvent(id, chunk) {
      const seq = await redis.rpush(eventsKey(id), JSON.stringify(chunk));
      await redis.publish(eventsKey(id), JSON.stringify({ seq, chunk }));
      return seq;
    },
    async events(id, after = 0) {
      const items = await redis.lrange(eventsKey(id), after, -1);
      return items.map((text, i) => ({ seq: after + i + 1, chunk: JSON.parse(text) }));
    },
    subscribe(id, listener) {
      if (!listeners.has(id)) {
        listeners.set(id, new Set());
        void sub.subscribe(eventsKey(id));
      }
      listeners.get(id)!.add(listener);
      return () => {
        const set = listeners.get(id);
        set?.delete(listener);
        if (set && !set.size) {
          listeners.delete(id);
          void sub.unsubscribe(eventsKey(id));
        }
      };
    },
    async list(status) {
      const ids = await redis.smembers(statusKey(status));
      return (await Promise.all(ids.map(read))).filter((j): j is JobRecord => j !== undefined);
    },
    async close() {
      await Promise.all([redis.quit(), sub.quit()]);
    },
  };
}

export interface BullQueueOptions {
  redisUrl: string;
  store: JobStore;
  run: JobRunner;
  concurrency?: number;
  maxAttempts?: number;
  queueName?: string;
  /** 这个进程要不要执行任务。web 角色只放任务、不执行，设成 false（第 48 天） */
  worker?: boolean;
}

export function createBullQueue(options: BullQueueOptions): JobQueue {
  const { redisUrl, store, run, concurrency = 2, maxAttempts = 3, queueName = 'research', worker: startWorker = true } = options;
  // BullMQ 要求 worker 的连接不限制重试次数：worker 要一直阻塞地等新任务
  const connection = () => connectRedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection: connection() });
  const worker = startWorker
    ? new Worker(
        queueName,
        async (job, _token, signal) => run(job.data.jobId as string, { attempt: job.attemptsMade + 1, maxAttempts, signal: signal ?? new AbortController().signal }),
        { connection: connection(), concurrency },
      )
    : undefined;
  const pub = connectRedis(redisUrl);
  const sub = startWorker ? connectRedis(redisUrl) : undefined;
  if (sub) {
    void sub.subscribe(CANCEL_CHANNEL);
    sub.on('message', (_channel: string, jobId: string) => worker?.cancelJob(jobId, '用户取消了'));
  }
  return {
    async enqueue(jobId) {
      await queue.add('research', { jobId }, { jobId, attempts: maxAttempts, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    },
    async cancel(jobId) {
      await store.update(jobId, { cancelRequested: true });
      const job = await queue.getJob(jobId);
      if (job && ((await job.isWaiting()) || (await job.isDelayed()))) {
        await job.remove();
        await store.appendEvent(jobId, { type: 'abort', reason: '用户取消了' });
        await store.update(jobId, { status: 'cancelled' });
        return;
      }
      await pub.publish(CANCEL_CHANNEL, jobId);
    },
    async idle() {
      for (;;) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        if (!counts.waiting && !counts.active && !counts.delayed) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async close() {
      await worker?.close();
      await queue.close();
      await Promise.all([pub.quit(), ...(sub ? [sub.quit()] : [])]);
    },
  };
}
