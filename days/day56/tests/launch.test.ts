import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const wh = await loadTarget<typeof import('../solution/webhook.ts')>(import.meta.url, 'webhook.ts');
const { verifySignature, sign, parsePullRequestEvent, createDeliveryDedup } = wh;
const sg = await loadTarget<typeof import('../solution/spend-guard.ts')>(import.meta.url, 'spend-guard.ts');
const { openSpendGuard, guardedModel, SpendLimitError } = sg;
const pf = await loadTarget<typeof import('../solution/preflight.ts')>(import.meta.url, 'preflight.ts');
const { scanSecrets, checkEnvExample, parseEnvKeys, runChecklist, reviewBotChecklist, renderChecklist } = pf;
const { createReviewBot } = await loadTarget<typeof import('../solution/app.ts')>(import.meta.url, 'app.ts');
const { toReviewPayload } = await loadTarget<typeof import('../solution/github.ts')>(import.meta.url, 'github.ts');
const { createModel } = await loadTarget<typeof import('../solution/core/providers.ts')>(import.meta.url, 'core/providers.ts');

type Model = import('../solution/core/types.ts').Model;
type ReviewPayload = import('../solution/github.ts').ReviewPayload;
const SECRET = 'webhook-secret';
const SHA = 'a'.repeat(40);
const tmp = () => mkdtemp(join(tmpdir(), 'day56-'));
const REPO = fileURLToPath(new URL('../data/repo', import.meta.url));
const CASES = Object.fromEntries(
  (await readFile(new URL('../data/review.jsonl', import.meta.url), 'utf8'))
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('//'))
    .map((l) => JSON.parse(l))
    .map((c) => [c.id, c]),
) as Record<string, { input: { title: string; diff: string } }>;
/** 一个 pull_request 事件 */
const prEvent = (over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  action: 'opened',
  number: 42,
  pull_request: { draft: false, head: { sha: SHA }, title: '加上按标题搜索', ...pr },
  repository: { full_name: 'acme/todo-api' },
  sender: { login: 'alice', type: 'User' },
  ...over,
});
// 假的密钥拼出来，免得这个文件自己被扫描工具当成泄露
const FAKE = { openai: `sk-${'a1B2'.repeat(6)}`, github: `ghp_${'x'.repeat(36)}`, aws: `AKIA${'Q'.repeat(16)}`, key: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ') };

describe('第 56 天：webhook 的签名（TODO 1）', () => {
  test('对原始的字节算 HMAC；不对、没有、格式不对都是 false', () => {
    const body = JSON.stringify(prEvent());
    expect(sign(SECRET, body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(SECRET, body, sign(SECRET, body))).toBe(true);
    expect(verifySignature(SECRET, Buffer.from(body), sign(SECRET, body)), 'Buffer 和字符串一样').toBe(true);
    expect(verifySignature('another-secret', body, sign(SECRET, body))).toBe(false);
    expect(verifySignature(SECRET, JSON.stringify(JSON.parse(body), null, 2), sign(SECRET, body)), '重新序列化以后签名就对不上了').toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, sign(SECRET, body).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifySignature(SECRET, body, 'sha256=abc'), '长度不同直接 false，不抛错').toBe(false);
  });
});

describe('第 56 天：过滤和去重（TODO 2）', () => {
  test('parsePullRequestEvent：只处理该处理的', () => {
    expect(parsePullRequestEvent('pull_request', prEvent())).toEqual({ ok: true, pr: { repo: 'acme/todo-api', number: 42, headSha: SHA, title: '加上按标题搜索', action: 'opened' } });
    expect(parsePullRequestEvent('push', prEvent())).toEqual({ ok: false, reason: '不处理 push 事件' });
    expect(parsePullRequestEvent(undefined, prEvent())).toEqual({ ok: false, reason: '不处理 （没有） 事件' });
    expect(parsePullRequestEvent('pull_request', { action: 'opened' })).toEqual({ ok: false, reason: '事件的格式不对' });
    expect(parsePullRequestEvent('pull_request', prEvent({}, { head: { sha: 'not-a-sha' } })).ok).toBe(false);
    expect(parsePullRequestEvent('pull_request', prEvent({ action: 'closed' }))).toEqual({ ok: false, reason: '不处理 closed 动作' });
    expect(parsePullRequestEvent('pull_request', prEvent({}, { draft: true }))).toEqual({ ok: false, reason: '草稿 PR 不审' });
    expect(parsePullRequestEvent('pull_request', prEvent({ sender: { login: 'review-bot[bot]', type: 'Bot' } }))).toEqual({ ok: false, reason: '机器人触发的事件不处理' });
    expect(parsePullRequestEvent('pull_request', prEvent({ action: 'synchronize' })).ok).toBe(true);
  });

  test('createDeliveryDedup：过期以后可以再来；超过上限删掉最早的', () => {
    let now = 0;
    const d = createDeliveryDedup({ ttlMs: 1000, max: 2, now: () => now });
    expect(d.seen('a')).toBe(false);
    expect(d.seen('a')).toBe(true);
    now = 1500;
    expect(d.seen('a'), '过期了').toBe(false);
    expect(d.seen('b')).toBe(false);
    expect(d.seen('c')).toBe(false);
    expect(d.seen('b')).toBe(true);
    expect(d.seen('a'), 'a 最早，被挤掉了').toBe(false);
  });
});

describe('第 56 天：花费上限（TODO 3）', () => {
  test('到 80% 降级、到 100% 停下；重新打开还在', async () => {
    const file = join(await tmp(), 'spend', 'spend.json');
    const now = () => new Date('2026-11-07T10:00:00Z');
    const guard = await openSpendGuard(file, { daily: 1, monthly: 20 }, now);
    expect(guard.status()).toEqual({ mode: 'normal', day: { key: '2026-11-07', spent: 0, limit: 1 }, month: { key: '2026-11', spent: 0, limit: 20 } });
    await guard.record(0.5);
    await guard.record(0.3);
    expect(guard.status().mode).toBe('degraded');
    await guard.record(0.2);
    expect(guard.status().mode).toBe('stopped');
    const reopened = await openSpendGuard(file, { daily: 1, monthly: 20 }, now);
    expect(reopened.status().day.spent).toBeCloseTo(1, 9);
  });

  test('换了一天当天的清零，换了一个月当月的清零；月度先到也会停', async () => {
    const file = join(await tmp(), 'spend.json');
    let at = '2026-11-07T23:00:00Z';
    const guard = await openSpendGuard(file, { daily: 5, monthly: 6, degradeAt: 0.5 }, () => new Date(at));
    await guard.record(4);
    at = '2026-11-08T01:00:00Z';
    expect(guard.status()).toMatchObject({ day: { key: '2026-11-08', spent: 0 }, month: { spent: 4 } });
    expect(guard.status().mode, '当月 4/6 超过了一半').toBe('degraded');
    await guard.record(2);
    expect(guard.status().mode, '当天只花了 2，但当月满了').toBe('stopped');
    at = '2026-12-01T00:00:00Z';
    expect(guard.status()).toMatchObject({ mode: 'normal', day: { spent: 0 }, month: { key: '2026-12', spent: 0 } });
  });

  test('同时记几笔，一笔都不丢', async () => {
    const file = join(await tmp(), 'spend.json');
    const guard = await openSpendGuard(file, { daily: 100, monthly: 100 });
    await Promise.all(Array.from({ length: 20 }, () => guard.record(0.5)));
    expect(guard.status().day.spent).toBe(10);
    expect(JSON.parse(await readFile(file, 'utf8')).monthSpent).toBe(10);
  });
});

describe('第 56 天：带上限的模型（TODO 4）', () => {
  const fake = (name: string, calls: string[]): Model => ({
    name,
    async chat() {
      calls.push(name);
      return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
    },
  });

  test('正常用 primary，降级用 cheap，停了就抛错；按用的那个模型的单价记账', async () => {
    const calls: string[] = [];
    const guard = await openSpendGuard(join(await tmp(), 'spend.json'), { daily: 10, monthly: 100 });
    const model = guardedModel({ primary: fake('big', calls), cheap: fake('small', calls) }, { primary: { input: 8, output: 0 }, cheap: { input: 1, output: 0 } }, guard);
    const ask = () => model.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(model.name).toBe('guarded:big');
    await ask();
    expect(guard.status()).toMatchObject({ mode: 'degraded', day: { spent: 8 } });
    await ask();
    expect(guard.status().day.spent, '降级以后按便宜模型的单价记').toBe(9);
    await ask();
    expect(calls).toEqual(['big', 'small', 'small']);
    expect(guard.status().mode).toBe('stopped');
    await expect(ask()).rejects.toBeInstanceOf(SpendLimitError);
    expect(calls, '停了就不再调用').toHaveLength(3);
  });
});

describe('第 56 天：密钥扫描（TODO 5）', () => {
  test('常见的格式；一行只报一条；预览打码', () => {
    const findings = scanSecrets([
      { path: 'src/a.ts', content: `const key = '${FAKE.openai}';\nconst gh = "${FAKE.github}"; const aws = '${FAKE.aws}';` },
      { path: 'deploy/id_rsa', content: FAKE.key },
      { path: 'src/config.ts', content: `export const config = {\n  mailApiKey: 'mk_live_9f8e7d6c5b4a3928',\n  password: "correct-horse-battery",\n};` },
    ]);
    expect(findings).toEqual([
      { path: 'src/a.ts', line: 1, rule: 'openai-style-key', preview: 'sk-a…' },
      { path: 'src/a.ts', line: 2, rule: 'github-token', preview: 'ghp_…' },
      { path: 'deploy/id_rsa', line: 1, rule: 'private-key', preview: '----…' },
      { path: 'src/config.ts', line: 2, rule: 'assigned-secret', preview: 'mk_l…' },
      { path: 'src/config.ts', line: 3, rule: 'assigned-secret', preview: 'corr…' },
    ]);
  });

  test('占位符、环境变量、太短的、标了 preflight-ignore 的不算', () => {
    const content = [
      "apiKey: 'your-api-key-here'",
      "token = '<paste your token>'",
      "const secret = process.env.SECRET ?? '';",
      "password: 'short'",
      "API_KEY='xxxxxxxxxxxxxxxx'",
      "secret: 'changeme-in-production'",
      `const fixture = '${FAKE.openai}'; // preflight-ignore`,
      "token: 'test-token-for-unit-tests'",
    ].join('\n');
    expect(scanSecrets([{ path: 'x.ts', content }])).toEqual([]);
  });
});

describe('第 56 天：.env.example（TODO 6）', () => {
  test('缺的、多的、填了真密钥的', () => {
    const example = ['# 模型', 'OPENAI_API_KEY=', "OPENAI_MODEL='my-model'", 'GITHUB_TOKEN=your-github-token', `WEBHOOK_SECRET=${'s3cr3t'.repeat(3)}`, 'OLD_NAME=1', 'export SPEND_DAILY=2'].join('\n');
    expect(parseEnvKeys(example).get('OPENAI_MODEL')).toBe('my-model');
    expect(checkEnvExample(['OPENAI_API_KEY', 'OPENAI_MODEL', 'GITHUB_TOKEN', 'WEBHOOK_SECRET', 'SPEND_DAILY', 'SPEND_MONTHLY'], example)).toEqual({
      ok: false,
      missing: ['SPEND_MONTHLY'],
      unknown: ['OLD_NAME'],
      filled: ['WEBHOOK_SECRET'],
    });
    expect(checkEnvExample(['A_KEY', 'B'], 'A_KEY=\nB=3').ok).toBe(true);
  });

  test('上线清单：自动的跑，人工的列出来；有 fail 就不 ok', async () => {
    const root = await tmp();
    await writeFile(join(root, 'index.ts'), `const k = '${FAKE.openai}';`);
    await writeFile(join(root, '.env.example'), 'GITHUB_TOKEN=\n');
    const { ok, results } = await runChecklist(reviewBotChecklist(root, { requiredEnv: ['GITHUB_TOKEN'], spend: { daily: 1, monthly: 20 } }));
    expect(ok).toBe(false);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ['secrets', 'fail'],
      ['env-example', 'pass'],
      ['spend', 'pass'],
      ['permissions', 'manual'],
      ['eval', 'manual'],
      ['alerts', 'manual'],
      ['rollback', 'manual'],
      ['privacy', 'manual'],
    ]);
    expect(results[0].detail).toBe('index.ts:1（openai-style-key，sk-a…）');
    expect(renderChecklist(results).split('\n')[0]).toBe('❌ 提交里没有密钥：index.ts:1（openai-style-key，sk-a…）');
    const noSpend = await runChecklist(reviewBotChecklist(root, { requiredEnv: ['GITHUB_TOKEN'], envExample: 'GITHUB_TOKEN=' }));
    expect(noSpend.results.find((r) => r.id === 'spend')).toMatchObject({ status: 'fail', detail: '没有设置' });
  });
});

describeMock('第 56 天：上线的 review-bot（读懂即可）', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  async function startBot(over: Partial<Parameters<typeof createReviewBot>[0]> = {}) {
    const posted: { repo: string; number: number; payload: ReviewPayload }[] = [];
    const diffs: Record<number, string> = { 42: CASES['sql-injection'].input.diff, 43: CASES['lockfile-only'].input.diff };
    const logs: string[] = [];
    const bot = createReviewBot({
      secret: SECRET,
      github: { getDiff: async (_r, n) => diffs[n], createReview: async (repo, number, payload) => void posted.push({ repo, number, payload }) },
      checkout: async () => REPO,
      model: createModel('openai'),
      log: (event) => logs.push(event),
      ...over,
    });
    const server = createServer((req, res) => void bot.handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push({ close: () => (server.closeAllConnections(), server.close()) });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = (payload: unknown, { event = 'pull_request', delivery = crypto.randomUUID() as string, secret = SECRET } = {}) => {
      const body = JSON.stringify(payload);
      return fetch(`${url}/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sign(secret, body) } });
    };
    return { bot, posted, logs, send, url };
  }

  test('验签 → 202 → 后台审查 → 发一次 COMMENT 审查，评论落在 RIGHT 那一边', async () => {
    const { bot, posted, send, url, logs } = await startBot();
    llm
      .reply({ match: '审查这个文件：src/routes/search.ts', toolCalls: [{ name: 'add_comment', arguments: { file: 'src/routes/search.ts', line: 7, severity: 'high', kind: 'security', body: 'keyword 拼进了 SQL，有注入风险，改用参数化查询' } }] })
      .reply({ match: '审查这个文件：src/routes/search.ts', content: '发现 1 个问题。' })
      .reply({ match: '总结这个 PR', content: '加了按标题搜索待办的接口。' });
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await send(prEvent(), { secret: 'wrong' })).status).toBe(401);
    const res = await send(prEvent(), { delivery: 'd-1' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    expect(await (await send(prEvent(), { delivery: 'd-1' })).json(), 'GitHub 重发的同一个事件').toEqual({ duplicate: true });
    await bot.idle();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repo: 'acme/todo-api', number: 42, payload: { commit_id: SHA, event: 'COMMENT' } });
    expect(posted[0].payload.comments).toEqual([{ path: 'src/routes/search.ts', line: 7, side: 'RIGHT', body: '**🔴 严重**（security）\n\nkeyword 拼进了 SQL，有注入风险，改用参数化查询' }]);
    expect(posted[0].payload.body).toContain('加了按标题搜索待办的接口。');
    expect(logs).toEqual(['review.queued', 'review.posted']);
  });

  test('不处理的事件、不允许的仓库、花费到了上限、只改了 lock 文件', async () => {
    const guard = await openSpendGuard(join(await tmp(), 'spend.json'), { daily: 1, monthly: 10 });
    const { bot, posted, send } = await startBot({ allowedRepos: ['acme/todo-api'], guard });
    expect(await (await send(prEvent(), { event: 'issues' })).json()).toEqual({ ignored: '不处理 issues 事件' });
    expect((await send(prEvent({ repository: { full_name: 'evil/repo' } }))).status).toBe(403);
    await send(prEvent({ number: 43 }));
    await bot.idle();
    expect(posted, '只改了 lock 文件：不发评论，也不调用模型').toEqual([]);
    expect(llm.requests).toHaveLength(0);
    await guard.record(1);
    expect(await (await send(prEvent())).json()).toEqual({ skipped: '花费到了上限' });
  });

  test('toReviewPayload 不会批准 PR', () => {
    const payload = toReviewPayload({ status: 'completed', comments: [], summary: '没问题', files: [], skipped: [], dropped: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 } }, SHA);
    expect(payload.event).toBe('COMMENT');
    expect(payload.body).toContain('没有发现问题');
  });
});
