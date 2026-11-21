import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const p = await loadTarget<typeof import('../solution/product.ts')>(import.meta.url, 'product.ts');
const { resolveUser, assignPrompt, withOps, createProductApp, startAlertLoop, PROMPT_NAME, EXPERIMENT } = p;
const pi = await loadTarget<typeof import('../solution/pilot.ts')>(import.meta.url, 'pilot.ts');
const { parsePilotNotes, triagePilot, renderPilotReport, pilotCaseId } = pi;
const { createPgliteDb, migrate } = await loadTarget<typeof import('../solution/db.ts')>(import.meta.url, 'db.ts');
const { createUser, createSessionToken, sessionCookie, issueApiKey } = await loadTarget<typeof import('../solution/auth.ts')>(import.meta.url, 'auth.ts');
const { createRateLimiter, checkQuota } = await loadTarget<typeof import('../solution/quota.ts')>(import.meta.url, 'quota.ts');
const { openPromptRegistry } = await loadTarget<typeof import('../solution/prompt-registry.ts')>(import.meta.url, 'prompt-registry.ts');
const { bucket } = await loadTarget<typeof import('../solution/rollout.ts')>(import.meta.url, 'rollout.ts');
const { createMetrics } = await loadTarget<typeof import('../solution/metrics.ts')>(import.meta.url, 'metrics.ts');
const { createMemoryFeedbackStore, createFileFeedbackStore } = await loadTarget<typeof import('../solution/feedback.ts')>(import.meta.url, 'feedback.ts');
const { createMemoryJobStore, createMemoryQueue } = await loadTarget<typeof import('../solution/jobs.ts')>(import.meta.url, 'jobs.ts');
const { createResearchRunner } = await loadTarget<typeof import('../solution/worker.ts')>(import.meta.url, 'worker.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { parseDataset } = await loadTarget<typeof import('../solution/eval/dataset.ts')>(import.meta.url, 'eval/dataset.ts');
const { loadConfig } = await loadTarget<typeof import('../solution/config.ts')>(import.meta.url, 'config.ts');
const { emptyUsage } = await loadTarget<typeof import('../solution/usage.ts')>(import.meta.url, 'usage.ts');

const FAST = { N: 1024, r: 8, p: 1 };
const SECRET = 'test-secret-0123456789-0123456789';
const PRICE = { input: 2, output: 8 };
const tmp = () => mkdtemp(join(tmpdir(), 'day50-'));
const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const cookieOf = (userId: string, now = Date.now()) => sessionCookie(createSessionToken(userId, SECRET, { now: () => now })).split(';')[0];

/** 注册表：发布 v1 上线；next 给了就再发布一版打上 canary */
async function registry(next?: string) {
  const reg = await openPromptRegistry(join(await tmp(), 'prompts.json'));
  const v1 = await reg.publish(PROMPT_NAME, '你是研究助手（稳定版）。先查资料再回答，引用写成 [编号]。');
  await reg.setLabel(PROMPT_NAME, 'production', v1.id);
  if (next) await reg.setLabel(PROMPT_NAME, 'canary', (await reg.publish(PROMPT_NAME, next)).id);
  return reg;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** 整个产品：数据库里有 alice 和 bob（alice 是管理员），内存队列，worker 外面包着 withOps */
async function startProduct(over: { canaryPercent?: number; limiter?: { capacity: number; refillPerSecond: number }; maxRequests?: number; next?: string; inviteCodes?: string[] } = {}) {
  const db = await createPgliteDb();
  await migrate(db);
  const alice = (await createUser(db, 'alice@example.com', 'alice-password', FAST)).id;
  const bob = (await createUser(db, 'bob@example.com', 'bob-password', FAST)).id;
  const prompts = await registry(over.next);
  const store = createMemoryJobStore();
  const metrics = createMetrics();
  const feedback = createMemoryFeedbackStore();
  const pendingFile = join(await tmp(), 'feedback-pending.jsonl');
  const run = withOps(
    createResearchRunner({ store, model: createModel('openai'), makeSetup: () => makeSetup(import.meta.url, fixture), systemFor: (job) => (job.promptVersion ? prompts.byId(job.promptVersion)?.content : undefined) }),
    { store, metrics, db, price: PRICE },
  );
  const queue = createMemoryQueue({ store, run, maxAttempts: 1, sleep: async () => {} });
  const quota = { maxRequests: over.maxRequests ?? 50, maxCost: 100 };
  const handle = createProductApp({
    db, store, queue, sessionSecret: SECRET, prompts, canaryPercent: over.canaryPercent ?? 0, feedback, pendingFile, metrics,
    limiter: createRateLimiter(over.limiter ?? { capacity: 100, refillPerSecond: 100 }), quota, admins: [alice], inviteCodes: over.inviteCodes,
    heartbeatMs: 50, scrypt: FAST, secureCookie: false,
  });
  const server = createServer((rq, rs) =>
    void handle(rq, rs).catch(() => {
      rs.writeHead(500).end();
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await queue.close();
    await db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  return { db, alice, bob, prompts, store, queue, metrics, feedback, pendingFile, quota, call, aliceCookie: cookieOf(alice), bobCookie: cookieOf(bob) };
}

describe('第 50 天：认出用户（TODO 1）', { timeout: 15_000 }, () => {
  test('Cookie、API Key；带了不对的 Authorization 不再看 Cookie；过期的令牌不认', async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const alice = (await createUser(db, 'alice@example.com', 'alice-password', FAST)).id;
    const key = await issueApiKey(db, alice, 'cli');
    expect(await resolveUser(req({ cookie: `theme=dark; ${cookieOf(alice)}` }), db, SECRET)).toBe(alice);
    expect(await resolveUser(req({ authorization: `Bearer ${key}` }), db, SECRET)).toBe(alice);
    expect(await resolveUser(req({ authorization: `bearer ${key} ` }), db, SECRET), 'Bearer 不分大小写').toBe(alice);
    expect(await resolveUser(req({ authorization: 'Bearer ra_wrong', cookie: cookieOf(alice) }), db, SECRET), '带了不对的 Key 就是认不出，不能退回去用 Cookie').toBeUndefined();
    expect(await resolveUser(req({ cookie: cookieOf(alice) }), db, 'another-secret-0123456789-0123456789')).toBeUndefined();
    const old = cookieOf(alice, Date.parse('2026-01-01T00:00:00Z'));
    expect(await resolveUser(req({ cookie: old }), db, SECRET, () => new Date('2026-11-07T00:00:00Z')), '七天前的令牌过期了').toBeUndefined();
    expect(await resolveUser(req({}), db, SECRET)).toBeUndefined();
    await db.close();
  });
});

describe('第 50 天：按灰度选 prompt（TODO 2）', () => {
  test('没有上线的版本就报错；没有 canary、比例是 0 都用稳定版', async () => {
    const empty = await openPromptRegistry(join(await tmp(), 'p.json'));
    expect(() => assignPrompt(empty, 'u1', 10)).toThrow('还没有上线的 prompt');
    const reg = await registry();
    const stable = reg.get(PROMPT_NAME)!;
    expect(assignPrompt(reg, 'u1', 50)).toEqual({ promptVersion: stable.id, variant: 'stable', content: stable.content });
    const withNext = await registry('你是研究助手（新版）。结论先行。');
    expect(assignPrompt(withNext, 'u1', 0).variant, '比例是 0 不灰度').toBe('stable');
  });

  test('10% 的用户拿到新版：按用户和实验名分桶，同一个人每次一样', async () => {
    const reg = await registry('你是研究助手（新版）。结论先行。');
    const next = reg.get(PROMPT_NAME, 'canary')!;
    const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const picked = users.map((u) => ({ u, a: assignPrompt(reg, u, 10) }));
    const inCanary = picked.filter((x) => x.a.variant === 'canary');
    expect(inCanary.length).toBeGreaterThan(60);
    expect(inCanary.length).toBeLessThan(140);
    expect(inCanary.every((x) => bucket(x.u, EXPERIMENT) < 10), '分桶要用 EXPERIMENT 这个实验名').toBe(true);
    expect(inCanary.every((x) => x.a.promptVersion === next.id && x.a.content === next.content)).toBe(true);
    expect(assignPrompt(reg, 'user-7', 10)).toEqual(assignPrompt(reg, 'user-7', 10));
    expect(assignPrompt(reg, 'user-7', 100).variant).toBe('canary');
  });
});

describe('第 50 天：任务结束时记账（TODO 5）', { timeout: 15_000 }, () => {
  const setup = async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const userId = (await createUser(db, 'alice@example.com', 'alice-password', FAST)).id;
    const store = createMemoryJobStore(() => new Date('2026-11-07T00:00:00Z'));
    const metrics = createMetrics({ now: () => Date.parse('2026-11-07T00:01:00Z') });
    const usage = { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 100_000 };
    return { db, userId, store, metrics, usage, now: () => new Date('2026-11-07T00:01:00Z') };
  };
  const ctx = { attempt: 1, maxAttempts: 2, signal: new AbortController().signal };

  test('完成：记指标（延迟从提交算起）和用量；回答没正常完成的算失败', async () => {
    const { db, userId, store, metrics, usage, now } = await setup();
    const fake = (status: string) => async (id: string) => void (await store.update(id, { status: 'completed', usage, result: { text: '…', status } }));
    const a = await store.create({ userId, question: 'q1', mode: 'quick', variant: 'canary' });
    await withOps(fake('completed'), { store, metrics, db, price: PRICE, now })(a.id, ctx);
    expect(metrics.snapshot('canary')).toMatchObject({ count: 1, errorRate: 0, p50Ms: 60_000 });
    const b = await store.create({ userId, question: 'q2', mode: 'quick', variant: 'canary' });
    await withOps(fake('max_steps'), { store, metrics, db, price: PRICE, now })(b.id, ctx);
    expect(metrics.snapshot('canary').errorRate, '停在最大步数也是没答好').toBe(0.5);
    const quota = await checkQuota(db, userId, { maxRequests: 10, maxCost: 100 }, now());
    expect(quota.requests).toBe(2);
    expect(quota.cost, '每次 2 + 0.8 = 2.8 元').toBeCloseTo(5.6, 6);
    await db.close();
  });

  test('抛错：照样记账、照样抛出；改回排队的不记；取消的只记用量', async () => {
    const { db, userId, store, metrics, usage, now } = await setup();
    const failed = await store.create({ userId, question: 'q', mode: 'quick' });
    const boom = async (id: string) => {
      await store.update(id, { status: 'failed', usage, error: '模型挂了' });
      throw new Error('模型挂了');
    };
    await expect(withOps(boom, { store, metrics, db, price: PRICE, now })(failed.id, ctx)).rejects.toThrow('模型挂了');
    expect(metrics.snapshot()).toMatchObject({ count: 1, errorRate: 1 });
    const retry = await store.create({ userId, question: 'q', mode: 'quick' });
    const requeue = async (id: string) => {
      await store.update(id, { status: 'queued', usage });
      throw new Error('稍后重试');
    };
    await expect(withOps(requeue, { store, metrics, db, price: PRICE, now })(retry.id, ctx)).rejects.toThrow('稍后重试');
    expect(metrics.snapshot().count, '还没结束的不记').toBe(1);
    const cancelled = await store.create({ userId, question: 'q', mode: 'quick' });
    await withOps(async (id) => void (await store.update(id, { status: 'cancelled', usage })), { store, metrics, db, price: PRICE, now })(cancelled.id, ctx);
    expect(metrics.snapshot().count, '用户取消的不算进指标').toBe(1);
    const quota = await checkQuota(db, userId, { maxRequests: 10, maxCost: 100 }, now());
    expect(quota.requests, '失败和取消都花了钱，都要记').toBe(2);
    await db.close();
  });
});

describeMock('第 50 天：整个产品（TODO 3、4、6）', { timeout: 15_000 }, () => {
  test('登录 → 提问 → 后台跑完 → 看结果；用的是分到的那一版 prompt；内部字段不给用户看', async () => {
    const app = await startProduct({ canaryPercent: 100, next: '你是研究助手（新版）。结论先行，引用写成 [编号]。' });
    expect((await app.call('/api/research', { body: { question: '你好' } })).status, '没登录').toBe(401);
    const login = await app.call('/api/login', { body: { email: 'alice@example.com', password: 'alice-password' } });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect(await (await app.call('/api/me', { cookie })).json()).toEqual({ id: app.alice, admin: true });

    llm.reply({ content: '你好！有什么要查的？' }).reply({ content: '多余的一轮' });
    const submitted = await app.call('/api/research', { body: { question: '你好' }, cookie });
    expect(submitted.status).toBe(202);
    const { id, status } = (await submitted.json()) as any;
    expect(status).toBe('queued');
    await app.queue.idle();
    expect(llm.requests[0].messages[0], '用 canary 那一版 prompt').toMatchObject({ role: 'system', content: '你是研究助手（新版）。结论先行，引用写成 [编号]。' });
    const job = await (await app.call(`/api/jobs/${id}`, { cookie })).json() as any;
    expect(job).toMatchObject({ id, status: 'completed', result: { status: 'completed' } });
    expect(job.result.text).toContain('你好！有什么要查的？');
    for (const hidden of ['userId', 'promptVersion', 'variant', 'usage', 'error']) expect(job, `不给用户看 ${hidden}`).not.toHaveProperty(hidden);
    const stored = await app.store.get(id);
    expect(stored).toMatchObject({ variant: 'canary', promptVersion: app.prompts.get(PROMPT_NAME, 'canary')!.id });
    expect(stored!.usage!.inputTokens, 'worker 要把用量记在任务上').toBeGreaterThan(0);
    const events = await (await app.call(`/api/jobs/${id}/events`, { cookie })).text();
    expect(events).toContain('"type":"data-answer"');
    expect(events.trim().endsWith('data: [DONE]')).toBe(true);
    expect((await app.call(`/api/jobs/${id}`, { cookie: app.bobCookie })).status, '别人的任务说没有').toBe(404);
    expect(app.metrics.snapshot('canary').count, '完成以后记了指标').toBe(1);
    expect((await checkQuota(app.db, app.alice, app.quota)).cost).toBeGreaterThan(0);
  });

  test('注册要邀请码；同一个邮箱不能注册两次；参数不对 400', async () => {
    const app = await startProduct({ inviteCodes: ['pilot-2026'] });
    expect((await app.call('/api/signup', { body: { email: 'carol@example.com', password: 'carol-password' } })).status).toBe(403);
    const ok = await app.call('/api/signup', { body: { email: 'carol@example.com', password: 'carol-password', invite: 'pilot-2026' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/^sid=.+HttpOnly/);
    expect((await app.call('/api/signup', { body: { email: 'Carol@example.com', password: 'carol-password', invite: 'pilot-2026' } })).status).toBe(409);
    expect((await app.call('/api/signup', { body: { email: 'not-an-email', password: 'x', invite: 'pilot-2026' } })).status).toBe(400);
    expect((await app.call('/api/login', { body: { email: 'carol@example.com', password: 'wrong-password' } })).status).toBe(401);
  });

  test('限流：429 带 Retry-After，每个人一个桶', async () => {
    const app = await startProduct({ limiter: { capacity: 2, refillPerSecond: 0.1 } });
    llm.reply({ content: '好的。' }).reply({ content: '好的。' }).reply({ content: '好的。' }).reply({ content: '多余的一轮' });
    expect((await app.call('/api/research', { body: { question: '一' }, cookie: app.aliceCookie })).status).toBe(202);
    expect((await app.call('/api/research', { body: { question: '二' }, cookie: app.aliceCookie })).status).toBe(202);
    const limited = await app.call('/api/research', { body: { question: '三' }, cookie: app.aliceCookie });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('10');
    expect((await app.call('/api/research', { body: { question: '三' }, cookie: app.bobCookie })).status, '每个人一个桶').not.toBe(429);
    await app.queue.idle();
  });

  test('每日配额：参数不对 400 不占配额，跑满后 429', async () => {
    const capped = await startProduct({ maxRequests: 1 });
    llm.reply({ content: '好的。' }).reply({ content: '多余的一轮' });
    expect((await capped.call('/api/research', { body: { question: '' }, cookie: capped.aliceCookie })).status).toBe(400);
    expect((await capped.call('/api/research', { body: { question: '一' }, cookie: capped.aliceCookie })).status).toBe(202);
    await capped.queue.idle();
    const over = await capped.call('/api/research', { body: { question: '二' }, cookie: capped.aliceCookie });
    expect(over.status, '配额是在任务结束时记的（withOps），跑完一个以后就满了').toBe(429);
    expect(((await over.json()) as any).error).toContain('今天的次数用完了');
  });

  test('反馈：没完成 409；差评进待审核的文件，带着版本和变体，打了码；同一个问题只进一次', async () => {
    const app = await startProduct({ canaryPercent: 100, next: '新版的 prompt。' });
    const pending = await app.store.create({ userId: app.alice, question: '还在排队', mode: 'quick' });
    expect((await app.call(`/api/jobs/${pending.id}/feedback`, { body: { rating: 'down' }, cookie: app.aliceCookie })).status).toBe(409);

    llm
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 默认端口' } }] })
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/article.html` } }] })
      .reply({ content: '默认端口是 8443 [1]。' })
      .reply({ content: '多余的一轮' });
    const { id } = await (await app.call('/api/research', { body: { question: '潮汐协议 3.0 的默认端口是多少？' }, cookie: app.aliceCookie })).json() as any;
    await app.queue.idle();
    expect((await app.call(`/api/jobs/${id}/feedback`, { body: { rating: 'down', comment: '端口错了' }, cookie: app.bobCookie })).status, '别人的任务不能评').toBe(404);
    expect((await app.call(`/api/jobs/${id}/feedback`, { body: { rating: 'meh' }, cookie: app.aliceCookie })).status).toBe(400);
    const res = await app.call(`/api/jobs/${id}/feedback`, { body: { rating: 'down', comment: '端口错了，打我电话 13812345678' }, cookie: app.aliceCookie });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ queuedForReview: true });
    const [item] = await app.feedback.list();
    expect(item).toMatchObject({ runId: id, userId: app.alice, rating: 'down', question: '潮汐协议 3.0 的默认端口是多少？', variant: 'canary', promptVersion: app.prompts.get(PROMPT_NAME, 'canary')!.id });
    expect(item.answer).toContain('8443');
    expect(item.sources, '来源从任务存下的 source-url 块里找').toEqual([`${fixture.base}/article.html`]);
    const cases = parseDataset(await readFile(app.pendingFile, 'utf8'));
    expect(cases).toHaveLength(1);
    expect(cases[0].tags).toEqual(['feedback', `prompt:${item.promptVersion}`, 'variant:canary']);
    expect(cases[0].notes).not.toContain('13812345678');
    const again = await app.call(`/api/jobs/${id}/feedback`, { body: { rating: 'down' }, cookie: app.aliceCookie });
    expect(await again.json()).toEqual({ queuedForReview: false });
  });

  test('管理统计：只给管理员，别人说没有；按变体分开，带上灰度的对比', async () => {
    const app = await startProduct({ canaryPercent: 50, next: '新版的 prompt。' });
    expect((await app.call('/api/admin/stats', { cookie: app.bobCookie })).status).toBe(404);
    await app.feedback.add({ runId: 'r1', userId: 'u', rating: 'up', question: 'q', answer: 'a', sources: [], promptVersion: 'v', variant: 'canary', createdAt: '2026-11-07T00:00:00Z' });
    await app.feedback.add({ runId: 'r2', userId: 'u', rating: 'down', question: 'q', answer: 'a', sources: [], promptVersion: 'v', variant: 'stable', createdAt: '2026-11-07T00:00:00Z' });
    app.metrics.record({ ok: true, latencyMs: 1000, cost: 0.01, variant: 'stable' });
    const stats = await (await app.call('/api/admin/stats', { cookie: app.aliceCookie })).json() as any;
    expect(stats.overall.count).toBe(1);
    expect(stats.variants.stable.count).toBe(1);
    expect(stats.variants.canary.count).toBe(0);
    expect(stats.ratings).toEqual({ stable: { successes: 0, total: 1 }, canary: { successes: 1, total: 1 } });
    expect(stats.comparison.verdict).toBe('样本不够');
    expect(stats.prompts).toEqual({ production: app.prompts.get(PROMPT_NAME)!.id, canary: app.prompts.get(PROMPT_NAME, 'canary')!.id });
  });

  test('取消：DELETE 以后任务变成 cancelled；结束了的不能再取消', async () => {
    const app = await startProduct();
    llm.reply({ content: '慢慢来……', chunkDelayMs: 200 }).reply({ content: '多余的一轮' });
    const { id } = await (await app.call('/api/research', { body: { question: '慢问题' }, cookie: app.aliceCookie })).json() as any;
    await new Promise((r) => setTimeout(r, 50));
    expect((await app.call(`/api/jobs/${id}`, { method: 'DELETE', cookie: app.aliceCookie })).status).toBe(202);
    await app.queue.idle();
    expect((await app.store.get(id))!.status).toBe('cancelled');
    expect((await app.call(`/api/jobs/${id}`, { method: 'DELETE', cookie: app.aliceCookie })).status).toBe(409);
  });
});

describe('第 50 天：告警循环和反馈文件', () => {
  test('startAlertLoop：错误率超了发到 webhook；tick 可以手动触发', async () => {
    const metrics = createMetrics();
    for (let i = 0; i < 20; i++) metrics.record({ ok: i >= 4, latencyMs: 100, cost: 0 });
    const sent: string[] = [];
    const seen: string[] = [];
    const loop = startAlertLoop({ metrics, webhookUrl: 'https://hooks.example/x', onAlert: (a) => seen.push(a.rule), doFetch: async (_u, init) => (sent.push(String(init!.body)), new Response('ok')) });
    try {
      const alerts = await loop.tick();
      expect(alerts.map((a) => a.status)).toEqual(['firing']);
      expect(seen).toEqual([alerts[0].rule]);
      expect(sent[0]).toContain('错误率 20.0%');
      expect(await loop.tick(), '冷却期内不再发').toEqual([]);
    } finally {
      loop.stop();
    }
  });

  test('createFileFeedbackStore：同时写不乱，重新打开还在，可以按变体筛', async () => {
    const file = join(await tmp(), 'fb', 'feedback.jsonl');
    const store = createFileFeedbackStore(file);
    const item = (i: number) => ({ runId: `r${i}`, userId: 'u', rating: i % 2 ? ('up' as const) : ('down' as const), question: `q${i}`, answer: 'a', sources: [], promptVersion: 'v', variant: i % 2 ? 'canary' : 'stable', createdAt: '2026-11-07T00:00:00Z' });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.add(item(i))));
    expect((await createFileFeedbackStore(file).list()).map((f) => f.runId)).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
    expect(await store.list({ variant: 'canary' })).toHaveLength(5);
  });

  test('config：运营的配置有默认值，比例不能超过 100', () => {
    const base = { OPENAI_BASE_URL: 'https://api.example/v1', OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'm', SESSION_SECRET: 'x'.repeat(40) };
    const loaded = loadConfig(base);
    expect(loaded.ok && loaded.config).toMatchObject({ CANARY_PERCENT: 0, DAILY_MAX_REQUESTS: 30, ADMIN_EMAILS: '' });
    const bad = loadConfig({ ...base, CANARY_PERCENT: '150', ALERT_WEBHOOK_URL: 'not a url' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join('\n')).toMatch(/CANARY_PERCENT[\s\S]*ALERT_WEBHOOK_URL/);
  });
});

describe('第 50 天：试用记录（TODO 7）', () => {
  const NOTES = [
    { user: 'P2', date: '2026-11-08', task: '查竞品的定价', kind: 'ux', topic: '看不出在干什么', observation: '提问后盯着屏幕 40 秒，问「是卡住了吗」', severity: 2 },
    { user: 'P1', date: '2026-11-08', task: '查端口', kind: 'wrong-answer', topic: '端口', observation: '回答说 8443，实际是 7443', quote: '这个我们文档里写着呢，打 13812345678 问我', question: '潮汐协议 3.0 的默认端口是多少？' },
    { user: 'P1', date: '2026-11-08', task: '查竞品的定价', kind: 'ux', topic: '看不出在干什么', observation: '深度研究跑了 3 分钟，中途关掉了页面', severity: 3 },
    { user: 'P3', date: '2026-11-09', task: '导出报告', kind: 'feature', topic: '导出成 Word', observation: '想把报告发给老板', severity: 1 },
    { user: 'P3', date: '2026-11-09', task: '上传 PDF', kind: 'bug', topic: '大文件上传失败', observation: '30MB 的 PDF 一直转圈', severity: 2 },
    { user: 'P2', date: '2026-11-09', task: '查端口', kind: 'wrong-answer', topic: '端口', observation: '同样的错', question: ' 潮汐协议 3.0 的默认端口是多少？' },
    { user: 'P3', date: '2026-11-09', task: '查政策', kind: 'praise', topic: '引用', observation: '点开引用核对了两条', quote: '有来源我才敢用' },
  ];
  const jsonl = NOTES.map((n) => JSON.stringify(n)).join('\n\n');

  test('parsePilotNotes：严重程度默认 2；错误带行号；wrong-answer 要有问题', () => {
    const notes = parsePilotNotes(jsonl);
    expect(notes).toHaveLength(7);
    expect(notes[1].severity).toBe(2);
    expect(() => parsePilotNotes('{"user":"P1"}\nnot json')).toThrow('第 1 行');
    expect(() => parsePilotNotes(`${JSON.stringify(NOTES[0])}\nnot json`)).toThrow('第 2 行不是合法的 JSON');
    expect(() => parsePilotNotes(JSON.stringify({ ...NOTES[1], question: undefined }))).toThrow('question');
  });

  test('triagePilot：答错的进评估集（脱敏、去重），其余合并成待办并排序', () => {
    const t = triagePilot(parsePilotNotes(jsonl));
    expect(t.users).toEqual(['P1', 'P2', 'P3']);
    expect(t.counts).toEqual({ 'wrong-answer': 2, bug: 1, ux: 2, feature: 1, praise: 1 });
    expect(t.evalCandidates).toHaveLength(1);
    const [c] = t.evalCandidates;
    expect(c.id).toBe(pilotCaseId('潮汐协议 3.0 的默认端口是多少？'));
    expect(c.tags).toEqual(['pilot', 'user:P1']);
    expect(c.notes).toContain('试用观察：回答说 8443，实际是 7443');
    expect(c.notes).toContain('原话：');
    expect(c.notes, '原话要打码').not.toContain('13812345678');
    expect(c.notes!.endsWith('待审核：补上 expected 以后挪进正式的评估集')).toBe(true);
    expect(t.backlog.map((b) => [b.kind, b.topic, b.users, b.severity, b.score])).toEqual([
      ['ux', '看不出在干什么', ['P1', 'P2'], 3, 6],
      ['bug', '大文件上传失败', ['P3'], 2, 3],
      ['feature', '导出成 Word', ['P3'], 1, 1],
    ]);
    expect(t.backlog[0].observations).toHaveLength(2);
    expect(t.praise.map((n) => n.user)).toEqual(['P3']);
  });

  test('renderPilotReport：表格、评估集候选、好评；不到 3 个人提醒一句', () => {
    const report = renderPilotReport(triagePilot(parsePilotNotes(jsonl)));
    expect(report).toContain('3 位试用者（P1、P2、P3）');
    expect(report).toContain('| 1 | 体验 | 看不出在干什么 | P1、P2 | 3 |');
    expect(report).toContain('- P3：有来源我才敢用');
    expect(report).not.toContain('不到 3 位');
    expect(renderPilotReport(triagePilot(parsePilotNotes(JSON.stringify(NOTES[0]))))).toContain('不到 3 位');
  });
});

describeE2E('第 50 天：真实模型', () => {
  test('通过产品的接口问一个问题，后台跑完，用的是注册表里的 prompt', { timeout: 300_000 }, async () => {
    const app = await startProduct();
    const { id } = await (await app.call('/api/research', { body: { question: '潮汐协议 3.0 的默认端口是多少？' }, cookie: app.aliceCookie })).json() as any;
    await app.queue.idle();
    const job = await (await app.call(`/api/jobs/${id}`, { cookie: app.aliceCookie })).json() as any;
    expect(job.status).toBe('completed');
    expect(job.result.text).toContain('7443');
    expect(app.metrics.snapshot().count).toBe(1);
  });
});
