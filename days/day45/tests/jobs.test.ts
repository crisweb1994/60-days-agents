import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const j = await loadTarget<typeof import('../solution/jobs.ts')>(import.meta.url, 'jobs.ts');
const { createMemoryJobStore, createMemoryQueue, recoverJobs } = j;
const { createResearchRunner } = await loadTarget<typeof import('../solution/worker.ts')>(import.meta.url, 'worker.ts');
const srv = await loadTarget<typeof import('../solution/jobs-server.ts')>(import.meta.url, 'jobs-server.ts');
const { startJobsApp, toSSEWithId, resumeFrom } = srv;
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { DEEP_PLAN_PROMPT } = await loadTarget<typeof import('../solution/deep-research.ts')>(import.meta.url, 'deep-research.ts');
const { FALLBACK_REPLY } = await loadTarget<typeof import('../solution/guardrails.ts')>(import.meta.url, 'guardrails.ts');

type Store = import('../solution/jobs.ts').JobStore;
const noSleep = async () => {};
const tmp = () => mkdtemp(join(tmpdir(), 'day45-'));
const types = async (store: Store, id: string) => (await store.events(id)).map((e) => e.chunk.type);
/** 一套研究任务的执行环境：store、worker、队列 */
async function setupJobs(options: { maxAttempts?: number; store?: Store; checkpointDir?: string } = {}) {
  const store = options.store ?? createMemoryJobStore();
  const run = createResearchRunner({ store, model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture), checkpointDir: options.checkpointDir });
  const queue = createMemoryQueue({ store, run, maxAttempts: options.maxAttempts ?? 3, sleep: noSleep });
  return { store, queue };
}

describe('第 45 天：任务存储（TODO 1）', () => {
  test('create、update、list；返回的是副本', async () => {
    const store = createMemoryJobStore(() => new Date('2026-11-07T00:00:00Z'));
    const job = await store.create({ userId: 'u1', question: '问题', mode: 'quick' });
    expect(job).toMatchObject({ userId: 'u1', status: 'queued', attempts: 0, createdAt: '2026-11-07T00:00:00.000Z' });
    job.status = 'failed';
    expect((await store.get(job.id))!.status, '外面改了不影响存着的').toBe('queued');
    await store.update(job.id, { status: 'running', attempts: 1 });
    expect((await store.list('running')).map((x) => x.id)).toEqual([job.id]);
    await expect(store.update('nope', {})).rejects.toThrow();
  });

  test('事件：序号递增，按序号补发，订阅收到新的', async () => {
    const store = createMemoryJobStore();
    const { id } = await store.create({ userId: 'u', question: 'q', mode: 'quick' });
    const seen: number[] = [];
    const off = store.subscribe(id, (e) => seen.push(e.seq));
    expect(await store.appendEvent(id, { type: 'start' })).toBe(1);
    expect(await store.appendEvent(id, { type: 'text-start', id: 't' })).toBe(2);
    off();
    await store.appendEvent(id, { type: 'finish' });
    expect(seen, '取消订阅以后不再通知').toEqual([1, 2]);
    expect((await store.events(id, 1)).map((e) => e.seq)).toEqual([2, 3]);
    expect(await store.events(id)).toHaveLength(3);
  });
});

describe('第 45 天：队列（TODO 3、4）', () => {
  test('同时最多跑 concurrency 个', async () => {
    const store = createMemoryJobStore();
    let running = 0;
    let peak = 0;
    const queue = createMemoryQueue({
      store,
      concurrency: 2,
      run: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      },
    });
    for (let i = 0; i < 5; i++) await queue.enqueue(`job-${i}`);
    await queue.idle();
    expect(peak).toBe(2);
  });

  test('失败了按退避重试，最多 maxAttempts 次', async () => {
    const store = createMemoryJobStore();
    const attempts: number[] = [];
    const waits: number[] = [];
    const queue = createMemoryQueue({
      store,
      maxAttempts: 3,
      sleep: async (ms) => void waits.push(ms),
      run: async (_id, { attempt, maxAttempts }) => {
        attempts.push(attempt);
        expect(maxAttempts).toBe(3);
        throw new Error('坏了');
      },
    });
    await queue.enqueue('a');
    await queue.idle();
    expect(attempts).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000, 2000]);
  });

  test('取消：排队的直接拿掉；跑着的收到信号，不再重试', async () => {
    const store = createMemoryJobStore();
    const a = await store.create({ userId: 'u', question: 'a', mode: 'quick' });
    const b = await store.create({ userId: 'u', question: 'b', mode: 'quick' });
    let aborted = false;
    let runsOfA = 0;
    const queue = createMemoryQueue({
      store,
      concurrency: 1,
      run: async (id, { signal }) => {
        if (id !== a.id) throw new Error('b 不应该跑');
        runsOfA++;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        aborted = true;
        throw new Error('被取消了');
      },
    });
    await queue.enqueue(a.id);
    await queue.enqueue(b.id);
    await queue.cancel(b.id);
    expect(await store.get(b.id)).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(await types(store, b.id)).toEqual(['abort']);
    await queue.cancel(a.id);
    await queue.idle();
    expect(aborted).toBe(true);
    expect(runsOfA, '被取消的不重试').toBe(1);
    expect((await store.get(a.id))!.cancelRequested).toBe(true);
  });

  test('recoverJobs：上次没跑完的、还在排队的放回队列', async () => {
    const store = createMemoryJobStore();
    const crashed = await store.create({ userId: 'u', question: 'a', mode: 'quick' });
    await store.update(crashed.id, { status: 'running', attempts: 1 });
    const waiting = await store.create({ userId: 'u', question: 'b', mode: 'quick' });
    const done = await store.create({ userId: 'u', question: 'c', mode: 'quick' });
    await store.update(done.id, { status: 'completed' });
    const ran: string[] = [];
    const queue = createMemoryQueue({ store, run: async (id) => void ran.push(id) });
    expect(await recoverJobs(store, queue)).toEqual([crashed.id, waiting.id]);
    await queue.idle();
    expect(ran.sort()).toEqual([crashed.id, waiting.id].sort());
    expect((await store.get(crashed.id))!.status).toBe('queued');
  });
});

describeMock('第 45 天：worker（TODO 2）', () => {
  test('正常完成：过程存下来，最后是 finish；任务 completed，回答存下', async () => {
    const { store, queue } = await setupJobs();
    llm.reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 默认端口' } }] }).reply({ content: '默认端口是 7443 [1]。' });
    const job = await store.create({ userId: 'u', question: '默认端口？', mode: 'quick' });
    await queue.enqueue(job.id);
    await queue.idle();
    const done = await store.get(job.id);
    expect(done).toMatchObject({ status: 'completed', attempts: 1, result: { status: 'completed' } });
    expect(done!.result!.text).toContain('7443 [1]');
    const t = await types(store, job.id);
    expect(t[0]).toBe('start');
    expect(t.slice(-3)).toEqual(['source-url', 'data-answer', 'finish']);
    expect((await store.events(job.id)).map((e) => e.seq), '序号连续').toEqual(t.map((_, i) => i + 1));
  });

  test('出错了重试：中间是一块 retry 的进度，不是 error；第二次成功', async () => {
    const { store, queue } = await setupJobs();
    llm.fail({ status: 400, message: '偶尔的错误' }).reply({ content: '你好。' });
    const job = await store.create({ userId: 'u', question: '你好', mode: 'quick' });
    await queue.enqueue(job.id);
    await queue.idle();
    expect(await store.get(job.id)).toMatchObject({ status: 'completed', attempts: 2 });
    const events = await store.events(job.id);
    expect(events.map((e) => e.chunk.type)).not.toContain('error');
    expect(events.find((e) => e.chunk.type === 'data-progress')!.chunk).toEqual({ type: 'data-progress', data: { stage: 'retry', attempt: 1 } });
    expect(events.at(-1)!.chunk.type).toBe('finish');
  });

  test('重试也不行：error 和 finish，任务 failed，错误只记在任务里', async () => {
    const { store, queue } = await setupJobs({ maxAttempts: 1 });
    llm.fail({ status: 400, message: '内部错误 10.0.0.5' });
    const job = await store.create({ userId: 'u', question: '你好', mode: 'quick' });
    await queue.enqueue(job.id);
    await queue.idle();
    expect(await store.get(job.id)).toMatchObject({ status: 'failed' });
    expect((await store.get(job.id))!.error).toContain('10.0.0.5');
    const events = await store.events(job.id);
    expect(events.slice(-2).map((e) => e.chunk)).toEqual([{ type: 'error', errorText: FALLBACK_REPLY }, { type: 'finish' }]);
    expect(JSON.stringify(events)).not.toContain('10.0.0.5');
  });

  test('进程退出（队列关闭）以后重启：深度研究从检查点接着做，不再规划、不再调研', async () => {
    const checkpointDir = await tmp();
    const store = createMemoryJobStore();
    const first = await setupJobs({ store, checkpointDir });
    llm
      .reply({ content: '{"steps": ["查甲", "查乙"]}' })
      .reply({ content: '甲的结论。', match: '子问题：查甲' })
      .reply({ content: '乙的结论。', match: '子问题：查乙' })
      .reply({ content: '# 报告（写到一半）', delayMs: 500 });
    const job = await store.create({ userId: 'u', question: '3.0 值得升级吗？', mode: 'deep' });
    const reporting = new Promise<void>((resolve) => store.subscribe(job.id, (e) => e.chunk.type === 'data-progress' && (e.chunk.data as { stage: string }).stage === 'report' && resolve()));
    await first.queue.enqueue(job.id);
    await reporting;
    await first.queue.close();
    expect((await store.get(job.id))!.status, '退出时没跑完的改回 queued').toBe('queued');
    llm.reset(); // 清掉被打断的那次请求没用上的回复，重新记录请求

    llm.reply({ content: '# 报告\n\n甲和乙。' }).reply({ content: '{"verdicts": []}' }).reply({ content: '{"verdicts": []}' });
    const second = await setupJobs({ store, checkpointDir });
    expect(await recoverJobs(store, second.queue)).toEqual([job.id]);
    await second.queue.idle();
    const later = llm.requests;
    expect(later.some((r) => r.messages[0].content === DEEP_PLAN_PROMPT), '不再规划').toBe(false);
    expect(later.some((r) => JSON.stringify(r.messages).includes('子问题：查甲')), '不再调研').toBe(false);
    expect(await store.get(job.id)).toMatchObject({ status: 'completed', attempts: 1 });
    expect((await store.get(job.id))!.result!.text).toContain('甲和乙');
  });
});

describe('第 45 天：SSE 的工具函数', () => {
  test('toSSEWithId 和 resumeFrom', () => {
    expect(toSSEWithId({ seq: 7, chunk: { type: 'finish' } })).toBe('id: 7\ndata: {"type":"finish"}\n\n');
    const req = (headers: Record<string, string>, url = '/v1/jobs/x/events') => ({ headers, url }) as never;
    expect(resumeFrom(req({ 'last-event-id': '5' }))).toBe(5);
    expect(resumeFrom(req({}, '/v1/jobs/x/events?after=3'))).toBe(3);
    expect(resumeFrom(req({ 'last-event-id': 'abc' }))).toBe(0);
    expect(resumeFrom(req({}))).toBe(0);
  });
});

describeMock('第 45 天：任务接口（TODO 5）', () => {
  const KEYS = { 'key-a': { id: 'alice' }, 'key-b': { id: 'bob' } };
  async function start() {
    const { store, queue } = await setupJobs();
    const app = await startJobsApp({ store, queue, apiKeys: KEYS, heartbeatMs: 50 });
    const call = (path: string, init: { method?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
      fetch(`${app.url}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { authorization: `Bearer ${init.key ?? 'key-a'}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
    return { store, queue, app, call };
  }
  const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

  test('提交、查询；完成以后订阅：全部补发，最后是 [DONE]；带 Last-Event-ID 只补发后面的', async () => {
    const { queue, app, call } = await start();
    try {
      llm.reply({ content: '你好。' });
      const res = await call('/v1/jobs', { body: { question: '你好' } });
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      expect(res.headers.get('location')).toBe(`/v1/jobs/${id}`);
      await queue.idle();
      const job = (await (await call(`/v1/jobs/${id}`)).json()) as Record<string, unknown>;
      expect(job).toMatchObject({ id, status: 'completed', question: '你好' });
      expect(job.userId, '不把内部字段交出去').toBeUndefined();
      const all = await (await call(`/v1/jobs/${id}/events`)).text();
      const seqs = ids(all);
      expect(seqs[0]).toBe(1);
      expect(all.trimEnd().endsWith('data: [DONE]')).toBe(true);
      const resumed = await (await call(`/v1/jobs/${id}/events`, { headers: { 'last-event-id': String(seqs.at(-3)) } })).text();
      expect(ids(resumed)).toEqual(seqs.slice(-2));
      expect((await call(`/v1/jobs/${id}`, { key: 'key-b' })).status, '别人的任务说没有').toBe(404);
      expect((await call(`/v1/jobs/${id}/events`, { key: 'key-b' })).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  test('边跑边看：先补发已有的，再实时推送，直到结束', async () => {
    const { app, call } = await start();
    try {
      llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '1+1' } }] }).reply({ content: '答案是 2。', delayMs: 300 });
      const { id } = (await (await call('/v1/jobs', { body: { question: '1+1' } })).json()) as { id: string };
      await new Promise((r) => setTimeout(r, 100));
      const text = await (await call(`/v1/jobs/${id}/events`)).text();
      expect(ids(text)).toEqual(ids(text).map((_, i) => i + 1));
      expect(text).toContain('"type":"tool-input-available"');
      expect(text).toContain('答案是 2');
      expect(text).toContain('"type":"finish"');
    } finally {
      await app.close();
    }
  });

  test('取消正在跑的任务；结束了的不能取消', async () => {
    const { store, queue, app, call } = await start();
    try {
      llm.reply({ content: '很慢的回答', delayMs: 2000 }).reply({ content: '不应该用到' });
      const { id } = (await (await call('/v1/jobs', { body: { question: '慢问题' } })).json()) as { id: string };
      await new Promise((r) => setTimeout(r, 100));
      const res = await call(`/v1/jobs/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(202);
      await queue.idle();
      expect((await store.get(id))!.status).toBe('cancelled');
      expect((await types(store, id)).at(-1)).toBe('abort');
      expect(await (await call(`/v1/jobs/${id}/events`)).text()).toContain('"type":"abort"');
      expect((await call(`/v1/jobs/${id}`, { method: 'DELETE' })).status).toBe(409);
      expect(llm.requests).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe.runIf(Boolean(process.env.REDIS_URL) && process.env.CHECK_MODE !== 'e2e')('第 45 天：Redis + BullMQ', () => {
  test('同样的流程跑在 Redis 和 BullMQ 上', { timeout: 30_000 }, async () => {
    const { createRedisJobStore, createBullQueue } = await loadTarget<typeof import('../solution/jobs-bullmq.ts')>(import.meta.url, 'jobs-bullmq.ts');
    const store = createRedisJobStore(process.env.REDIS_URL!);
    const run = createResearchRunner({ store, model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture) });
    const queue = createBullQueue({ redisUrl: process.env.REDIS_URL!, store, run, queueName: `research-test-${Date.now()}` });
    try {
      llm.reply({ content: '你好。' });
      const job = await store.create({ userId: 'u', question: '你好', mode: 'quick' });
      const seen: number[] = [];
      const off = store.subscribe(job.id, (e) => seen.push(e.seq));
      await new Promise((r) => setTimeout(r, 100));
      await queue.enqueue(job.id);
      await queue.idle();
      await new Promise((r) => setTimeout(r, 100));
      off();
      expect(await store.get(job.id)).toMatchObject({ status: 'completed' });
      const events = await store.events(job.id);
      expect(events.at(-1)!.chunk.type).toBe('finish');
      expect(seen).toEqual(events.map((e) => e.seq));
    } finally {
      await queue.close();
      await store.close();
    }
  });
});

describeE2E('第 45 天：真实模型跑后台任务', () => {
  test('提交一个快速研究，等它完成', { timeout: 300_000 }, async () => {
    const { store, queue } = await setupJobs();
    const job = await store.create({ userId: 'u', question: '潮汐协议 3.0 的默认端口是多少？', mode: 'quick' });
    await queue.enqueue(job.id);
    await queue.idle();
    const done = await store.get(job.id);
    console.log(done?.status, done?.result?.text);
    expect(done?.status).toBe('completed');
    expect(done?.result?.text).toContain('7443');
  });
});
