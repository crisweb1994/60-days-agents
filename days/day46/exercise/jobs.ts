// 第 45 天：长任务放进后台。一次研究要跑好几分钟，不能跟着一个 HTTP 连接走：
//   提交：POST 只把任务存下来、放进队列，马上返回编号（第 40 天的异步运行，这次是真的队列）
//   执行：worker 从队列里取任务来跑（worker.ts），过程中的每一块（第 44 天的 UI 消息流）都存下来，带一个递增的序号
//   观看：客户端用 SSE 订阅；断线重连时带上最后收到的序号（Last-Event-ID），只补发后面的
//   取消：标记一下，正在跑的 worker 收到信号就停
//   恢复：进程崩了，重启时把「还在跑」的任务重新放回队列；深度研究有检查点（第 35 天），做过的步骤不再做
// 这个文件是内存里的实现：任务记录、事件和队列都在一个进程里，测试和单机开发用。
// 多进程、多机器时换成 Redis 和 BullMQ（jobs-bullmq.ts），接口不变。
import { randomUUID } from 'node:crypto';
import type { ResearchChunk, AnswerData } from './ui-stream.ts';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  userId: string;
  question: string;
  mode: 'quick' | 'deep';
  status: JobStatus;
  /** 执行过几次（重试会加一） */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** 完成时的回答 */
  result?: AnswerData;
  /** 失败的原因。只进日志和管理后台，不给用户看 */
  error?: string;
  /** 用户要求取消了 */
  cancelRequested?: boolean;
}

/** 存下来的一块，seq 从 1 开始，同一个任务里递增 */
export interface JobEvent {
  seq: number;
  chunk: ResearchChunk;
}

/** 这几块出现，说明这次执行结束了 */
export const TERMINAL_CHUNKS = new Set(['finish', 'abort']);
export const FINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'cancelled']);

export interface JobStore {
  create(input: Pick<JobRecord, 'userId' | 'question' | 'mode'>): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  update(id: string, patch: Partial<Omit<JobRecord, 'id' | 'userId' | 'createdAt'>>): Promise<JobRecord>;
  /** 存一块，返回它的序号，并通知订阅者 */
  appendEvent(id: string, chunk: ResearchChunk): Promise<number>;
  /** 序号大于 after 的所有块，按序号排好 */
  events(id: string, after?: number): Promise<JobEvent[]>;
  /** 订阅之后新存的块。返回取消订阅的函数 */
  subscribe(id: string, listener: (event: JobEvent) => void): () => void;
  /** 某种状态的所有任务（恢复时找 running 的） */
  list(status: JobStatus): Promise<JobRecord[]>;
}

/**
 * 内存里的任务存储：
 * - create：新的编号，status 是 queued，attempts 是 0，两个时间都是现在
 * - update：合并字段，updatedAt 改成现在；没有这个任务就抛出错误
 * - appendEvent：序号是这个任务已有的块数加一；存下以后同步通知这个任务的每个订阅者
 * - events：返回 seq > after 的块（after 默认 0）
 * - subscribe：返回的函数调用以后不再通知
 * 返回的记录都是副本，外面改了不影响存着的
 */
export function createMemoryJobStore(now: () => Date = () => new Date()): JobStore {
  const jobs = new Map<string, JobRecord>();
  const events = new Map<string, JobEvent[]>();
  const listeners = new Map<string, Set<(event: JobEvent) => void>>();
  const copy = (job: JobRecord): JobRecord => structuredClone(job);
  return {
    async create(input) {
      const time = now().toISOString();
      const job: JobRecord = { id: randomUUID(), ...input, status: 'queued', attempts: 0, createdAt: time, updatedAt: time };
      jobs.set(job.id, job);
      events.set(job.id, []);
      return copy(job);
    },
    async get(id) {
      const job = jobs.get(id);
      return job && copy(job);
    },
    async update(id, patch) {
      const job = jobs.get(id);
      if (!job) throw new Error(`没有任务 ${id}`);
      Object.assign(job, patch, { updatedAt: now().toISOString() });
      return copy(job);
    },
    async appendEvent(id, chunk) {
      const list = events.get(id);
      if (!list) throw new Error(`没有任务 ${id}`);
      const event = { seq: list.length + 1, chunk };
      list.push(event);
      for (const listener of listeners.get(id) ?? []) listener(event);
      return event.seq;
    },
    async events(id, after = 0) {
      return (events.get(id) ?? []).filter((e) => e.seq > after);
    },
    subscribe(id, listener) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id)!.add(listener);
      return () => listeners.get(id)?.delete(listener);
    },
    async list(status) {
      return [...jobs.values()].filter((j) => j.status === status).map(copy);
    },
  };
}

/** 执行一个任务。attempt 从 1 开始；signal 是取消信号。抛出错误表示这次失败了，队列决定要不要重试 */
export type JobRunner = (jobId: string, ctx: { attempt: number; maxAttempts: number; signal: AbortSignal }) => Promise<void>;

export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
  /** 取消：还在排队的直接拿掉；正在跑的发出取消信号 */
  cancel(jobId: string): Promise<void>;
  /** 等现在排着的、跑着的都结束（测试和优雅退出用） */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface MemoryQueueOptions {
  store: JobStore;
  run: JobRunner;
  /** 同时跑几个，默认 2 */
  concurrency?: number;
  /** 最多执行几次（含第一次），默认 3 */
  maxAttempts?: number;
  /** 第 attempt 次失败以后，等多久再重试，默认 1 秒、2 秒、4 秒…… */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 进程内的队列：
 * - enqueue：放进等待的队列，有空位就开始跑（最多 concurrency 个同时跑）
 * - 跑一个任务：给它一个 AbortController（存起来，cancel 要用），attempt 是这个任务第几次执行；
 *   run 抛出错误、又没有被取消、attempt 还小于 maxAttempts：等 backoffMs(attempt) 以后再放回队列；否则就结束了
 * - cancel：在等待的队列里就拿掉（先存一块 abort，再改成 cancelled）；正在跑的就记下 cancelRequested，再 abort
 * - idle：等待的队列和正在跑的都空了才返回
 */
export function createMemoryQueue(options: MemoryQueueOptions): JobQueue {
  const { store, run, concurrency = 2, maxAttempts = 3, backoffMs = (n) => 1000 * 2 ** (n - 1), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  const waiting: string[] = [];
  const running = new Map<string, AbortController>();
  const attempts = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  let closed = false;

  const pump = () => {
    while (!closed && running.size < concurrency && waiting.length) {
      const id = waiting.shift()!;
      const controller = new AbortController();
      running.set(id, controller);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const task = (async () => {
        try {
          await run(id, { attempt, maxAttempts, signal: controller.signal });
        } catch {
          if (!controller.signal.aborted && attempt < maxAttempts) {
            await sleep(backoffMs(attempt));
            waiting.push(id);
          }
        } finally {
          running.delete(id);
          pump();
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  };

  return {
    async enqueue(jobId) {
      waiting.push(jobId);
      pump();
    },
    async cancel(jobId) {
      const index = waiting.indexOf(jobId);
      if (index >= 0) {
        waiting.splice(index, 1);
        await store.appendEvent(jobId, { type: 'abort', reason: '用户取消了' });
        await store.update(jobId, { status: 'cancelled', cancelRequested: true });
        return;
      }
      await store.update(jobId, { cancelRequested: true });
      running.get(jobId)?.abort();
    },
    async idle() {
      while (pending.size || waiting.length) await Promise.allSettled([...pending]);
    },
    async close() {
      closed = true;
      for (const controller of running.values()) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}

/**
 * 进程重启以后调用：上次没跑完的任务（status 还是 running：进程在跑的时候崩了）改回 queued，重新放进队列；
 * 还在排队的（queued）也放回去：内存里的队列随着进程没了。返回放回去的任务编号
 */
export async function recoverJobs(store: JobStore, queue: JobQueue): Promise<string[]> {
  const ids: string[] = [];
  for (const job of [...(await store.list('running')), ...(await store.list('queued'))]) {
    if (job.status === 'running') await store.update(job.id, { status: 'queued' });
    await queue.enqueue(job.id);
    ids.push(job.id);
  }
  return ids;
}
