import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const d = await loadTarget<typeof import('../solution/db.ts')>(import.meta.url, 'db.ts');
const { createPgliteDb, createPgDb, migrate, withTenant, findUnprotectedTables, APP_ROLE } = d;
const a = await loadTarget<typeof import('../solution/auth.ts')>(import.meta.url, 'auth.ts');
const { hashPassword, verifyPassword, createSessionToken, verifySessionToken, sessionCookie, readSessionCookie, createUser, login, issueApiKey, findUserByApiKey } = a;
const t = await loadTarget<typeof import('../solution/tenant-store.ts')>(import.meta.url, 'tenant-store.ts');
const { createTenantMemoryStore, addDocument, createTenantRetriever, saveSession, loadSession, listSessions } = t;
const q = await loadTarget<typeof import('../solution/quota.ts')>(import.meta.url, 'quota.ts');
const { createRateLimiter, checkQuota, recordUsage } = q;
const { createOpenAIEmbedder, embeddingConfigFromEnv } = await loadTarget<typeof import('../solution/rag/embeddings.ts')>(import.meta.url, 'rag/embeddings.ts');
const { research } = await loadTarget<typeof import('../solution/research.ts')>(import.meta.url, 'research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const FAST = { N: 1024, r: 8, p: 1 };
const SECRET = 'test-secret-0123456789';
const embedder = () => createOpenAIEmbedder(embeddingConfigFromEnv());
/** 一个新的数据库，建好表，注册 alice 和 bob */
async function freshDb() {
  const db = await createPgliteDb();
  await migrate(db);
  const alice = await createUser(db, 'Alice@Example.com', 'alice-password', FAST);
  const bob = await createUser(db, 'bob@example.com', 'bob-password', FAST);
  return { db, alice: alice.id, bob: bob.id };
}

describe('第 46 天：密码和令牌（TODO 1）', () => {
  test('hashPassword 和 verifyPassword', async () => {
    const stored = await hashPassword('正确的密码', FAST);
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await hashPassword('正确的密码', FAST), '每次的盐都不一样').not.toBe(stored);
    expect(await verifyPassword('正确的密码', stored)).toBe(true);
    expect(await verifyPassword('错误的密码', stored)).toBe(false);
    expect(await verifyPassword('正确的密码', 'md5$abc')).toBe(false);
  });

  test('会话令牌：签名、过期、篡改', () => {
    let now = Date.UTC(2026, 10, 7);
    const token = createSessionToken('u1', SECRET, { ttlSeconds: 60, now: () => now });
    expect(verifySessionToken(token, SECRET, () => now)).toEqual({ sub: 'u1', exp: now / 1000 + 60 });
    expect(verifySessionToken(token, 'other-secret', () => now), '密钥不对').toBeUndefined();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: now / 1000 + 60 })).toString('base64url');
    expect(verifySessionToken(`${forged}.${sig}`, SECRET, () => now), '改了载荷').toBeUndefined();
    expect(verifySessionToken(`${payload}.x`, SECRET, () => now)).toBeUndefined();
    expect(verifySessionToken('abc', SECRET, () => now)).toBeUndefined();
    expect(verifySessionToken(undefined, SECRET)).toBeUndefined();
    now += 61_000;
    expect(verifySessionToken(token, SECRET, () => now), '过期了').toBeUndefined();
  });

  test('Cookie', () => {
    const cookie = sessionCookie('abc.def', 3600);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=3600']) expect(cookie).toContain(flag);
    expect(readSessionCookie('theme=dark; sid=abc.def==; x=1')).toBe('abc.def==');
    expect(readSessionCookie(undefined)).toBeUndefined();
  });
});

describe('第 46 天：表结构和 RLS（TODO 2）', { timeout: 15_000 }, () => {
  test('migrate 可以重复执行；每张带 user_id 的表都开了 RLS', async () => {
    const { db } = await freshDb();
    await migrate(db);
    expect(await findUnprotectedTables(db)).toEqual([]);
    await db.query('create table notes (id text primary key, user_id text not null, body text)');
    expect(await findUnprotectedTables(db), '新表忘了开 RLS，检查会发现').toEqual(['notes']);
    await db.close();
  });

  test('withTenant：切换到应用角色、设置当前用户，只在事务里有效', async () => {
    const { db, alice } = await freshDb();
    const inside = await withTenant(db, alice, async (tx) => (await tx.query<{ role: string; uid: string }>(`select current_user as role, current_setting('app.user_id', true) as uid`)).rows[0]);
    expect(inside).toEqual({ role: APP_ROLE, uid: alice });
    const after = (await db.query<{ uid: string | null }>(`select current_setting('app.user_id', true) as uid`)).rows[0].uid;
    expect(after || '', '事务结束以后不会漏给下一个请求').toBe('');
    await expect(withTenant(db, '', async () => 1)).rejects.toThrow();
    await db.close();
  });
});

describe('第 46 天：跨用户越权（TODO 3、4）', { timeout: 15_000 }, () => {
  test('记忆：bob 看不到、找不到、删不掉 alice 的', async () => {
    const { db, alice, bob } = await freshDb();
    const aliceMemory = createTenantMemoryStore(db, alice);
    const bobMemory = createTenantMemoryStore(db, bob);
    expect(await aliceMemory.remember({ name: 'deploy-env', type: 'project', content: '生产环境在杭州机房' })).toMatchObject({ updated: false });
    expect((await aliceMemory.remember({ name: 'deploy-env', type: 'project', content: '生产环境在上海机房' })).updated).toBe(true);
    await bobMemory.remember({ name: 'likes-short', type: 'user', content: '回答要简短' });
    expect((await aliceMemory.list()).map((m) => m.content)).toEqual(['生产环境在上海机房']);
    expect((await bobMemory.list()).map((m) => m.name)).toEqual(['likes-short']);
    expect(await bobMemory.search('机房')).toEqual([]);
    expect(await bobMemory.forget('deploy-env'), '删不掉别人的').toBe(false);
    expect(await aliceMemory.list()).toHaveLength(1);
    await expect(aliceMemory.remember({ name: 'phone', type: 'user', content: '电话 13812345678' })).rejects.toThrow(/敏感信息/);
    await db.close();
  });

  test('检索：bob 的结果里永远没有 alice 的文档，哪怕问的就是它', async () => {
    const { db, alice, bob } = await freshDb();
    await addDocument(db, alice, { path: 'internal.md', markdown: '# 内部手册\n\n潮汐内部集群的管理端口是 9443，只对运维开放。' }, embedder());
    expect(await addDocument(db, bob, { path: 'notes.md', markdown: '# 笔记\n\n周末去爬山。' }, embedder())).toBe(1);
    for (const mode of ['vector', 'keyword', 'hybrid'] as const) {
      const hits = await createTenantRetriever(db, bob, embedder()).search('潮汐内部集群的管理端口', { mode, k: 5 });
      expect(hits.map((h) => h.chunk.path), `${mode}：只有 bob 自己的`).not.toContain('internal.md');
    }
    const aliceHits = await createTenantRetriever(db, alice, embedder()).search('管理端口', { mode: 'hybrid' });
    expect(aliceHits[0].chunk.text).toContain('9443');
    await db.close();
  });

  test('数据库这一道：漏写了 where，也只看到自己的；插入、修改别人的会失败；没设用户一行都看不到', async () => {
    const { db, alice, bob } = await freshDb();
    await createTenantMemoryStore(db, alice).remember({ name: 'secret-plan', type: 'project', content: '下季度要收购潮汐公司' });
    const leaked = await withTenant(db, bob, async (tx) => (await tx.query('select * from memories')).rows);
    expect(leaked, '漏写了 where').toEqual([]);
    await expect(withTenant(db, bob, (tx) => tx.query(`insert into memories (user_id, name, type, content, created, updated) values ($1, 'x', 'user', '冒充', now(), now())`, [alice])), '冒充别人插入').rejects.toThrow(/row-level security/);
    const updated = await withTenant(db, bob, async (tx) => (await tx.query(`update memories set content = '改掉' where name = 'secret-plan' returning name`)).rows);
    expect(updated).toEqual([]);
    const anonymous = await db.transaction(async (tx) => {
      await tx.query(`set local role ${APP_ROLE}`);
      return (await tx.query<{ n: number }>('select count(*)::int as n from memories')).rows[0].n;
    });
    expect(anonymous, '没设用户：默认拒绝').toBe(0);
    await db.close();
  });

  test('会话：同一个编号，bob 覆盖不了 alice 的，也读不到', async () => {
    const { db, alice, bob } = await freshDb();
    await saveSession(db, alice, { id: 's1', title: '收购计划', messages: [{ role: 'user', content: '帮我查潮汐公司' }] });
    await expect(saveSession(db, bob, { id: 's1', title: '覆盖', messages: [] })).rejects.toThrow();
    expect(await loadSession(db, bob, 's1')).toBeUndefined();
    expect(await loadSession(db, alice, 's1')).toMatchObject({ title: '收购计划', messages: [{ role: 'user', content: '帮我查潮汐公司' }] });
    expect(await listSessions(db, bob)).toEqual([]);
    await saveSession(db, alice, { id: 's1', title: '收购计划 v2', messages: [] });
    expect((await listSessions(db, alice)).map((s) => s.title)).toEqual(['收购计划 v2']);
    await db.close();
  });

  test('登录和 API Key', async () => {
    const { db, alice } = await freshDb();
    expect(await login(db, 'alice@example.com', 'alice-password'), '邮箱不分大小写').toBe(alice);
    expect(await login(db, 'alice@example.com', 'wrong')).toBeUndefined();
    expect(await login(db, 'nobody@example.com', 'x')).toBeUndefined();
    const key = await issueApiKey(db, alice, 'cli');
    expect(key).toMatch(/^ra_/);
    expect(await findUserByApiKey(db, key)).toBe(alice);
    expect(await findUserByApiKey(db, 'ra_wrong')).toBeUndefined();
    expect(await findUserByApiKey(db, undefined)).toBeUndefined();
    const stored = (await db.query<{ hash: string }>('select hash from api_keys')).rows[0].hash;
    expect(stored, '只存哈希').not.toContain(key.slice(3));
    await db.close();
  });
});

describe('第 46 天：配额和限流（TODO 5）', { timeout: 15_000 }, () => {
  test('令牌桶：用完了要等，过一会儿补回来', () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
    expect([limiter.take('a').ok, limiter.take('a').ok]).toEqual([true, true]);
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(limiter.take('b').ok, '每个人一个桶').toBe(true);
    now = 500;
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: 500 });
    now = 1000;
    expect(limiter.take('a').ok).toBe(true);
    now = 100_000;
    expect([limiter.take('a').ok, limiter.take('a').ok, limiter.take('a').ok], '最多攒 capacity 个').toEqual([true, true, false]);
  });

  test('每天的配额：按用户记账，同时记也不会少算', async () => {
    const { db, alice, bob } = await freshDb();
    const quota = { maxRequests: 3, maxCost: 1 };
    const now = new Date('2026-11-07T08:00:00Z');
    await Promise.all([1, 2, 3].map(() => recordUsage(db, alice, 0.1, now)));
    expect(await checkQuota(db, alice, quota, now)).toEqual({ requests: 3, cost: expect.closeTo(0.3, 6), ok: false, reason: '今天的次数用完了（3 次），明天再来吧' });
    expect((await checkQuota(db, bob, quota, now)).ok, 'bob 不受影响').toBe(true);
    expect((await checkQuota(db, alice, quota, new Date('2026-11-08T08:00:00Z'))).ok, '第二天重新算').toBe(true);
    await recordUsage(db, bob, 1.5, now);
    expect((await checkQuota(db, bob, quota, now)).reason).toBe('今天的额度用完了，明天再来吧');
    await db.close();
  });
});

describe.runIf(Boolean(process.env.DATABASE_URL) && process.env.CHECK_MODE !== 'e2e')('第 46 天：真正的 PostgreSQL', () => {
  test('同样的表结构和隔离', { timeout: 30_000 }, async () => {
    const db = createPgDb(process.env.DATABASE_URL!);
    try {
      await migrate(db);
      expect(await findUnprotectedTables(db)).toEqual([]);
      const suffix = Date.now();
      const alice = await createUser(db, `alice-${suffix}@example.com`, 'pw', FAST);
      const bob = await createUser(db, `bob-${suffix}@example.com`, 'pw', FAST);
      await createTenantMemoryStore(db, alice.id).remember({ name: 'plan', type: 'project', content: '机密计划' });
      expect(await withTenant(db, bob.id, async (tx) => (await tx.query('select * from memories')).rows)).toEqual([]);
      expect(await findUserByApiKey(db, await issueApiKey(db, alice.id))).toBe(alice.id);
    } finally {
      await db.close();
    }
  });
});

describeMock('第 46 天：研究助手按用户隔离', { timeout: 15_000 }, () => {
  test('同一个问题：alice 查得到自己的内部文档，bob 查不到', async () => {
    const { db, alice, bob } = await freshDb();
    await addDocument(db, alice, { path: 'internal.md', markdown: '# 内部手册\n\n潮汐内部集群的管理端口是 9443。' }, embedder());
    const ask = async (userId: string) => {
      llm.reply({ toolCalls: [{ name: 'search_docs', arguments: { query: '内部集群 管理端口' } }] }).reply({ content: '回答。' });
      const setup = await makeSetup(import.meta.url, fixture);
      await research('内部集群的管理端口是多少？', { ...setup, docs: { root: '/nonexistent', retriever: createTenantRetriever(db, userId, embedder()) }, memory: createTenantMemoryStore(db, userId) }, { model: createModel('openai') });
      return String(llm.requests.at(-1)!.messages.at(-1)!.content);
    };
    expect(await ask(alice)).toContain('9443');
    expect(await ask(bob)).not.toContain('9443');
    await db.close();
  });
});

describeE2E('第 46 天：真实模型', () => {
  test('bob 问 alice 的内部端口，答不出来', { timeout: 300_000 }, async () => {
    const { db, alice, bob } = await freshDb();
    await addDocument(db, alice, { path: 'internal.md', markdown: '# 内部手册\n\n潮汐内部集群的管理端口是 9443。' }, embedder());
    const setup = await makeSetup(import.meta.url, fixture);
    const r = await research('查一下本地文档：潮汐内部集群的管理端口是多少？', { ...setup, search: undefined, docs: { root: '/nonexistent', retriever: createTenantRetriever(db, bob, embedder()) } }, { model: createModel('openai') });
    console.log(r.answer);
    expect(r.answer).not.toContain('9443');
    await db.close();
  });
});
