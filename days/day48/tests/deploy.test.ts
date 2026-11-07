import { readFile } from 'node:fs/promises';
import { Agent, get } from 'node:http';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const c = await loadTarget<typeof import('../solution/config.ts')>(import.meta.url, 'config.ts');
const { loadConfig, describeConfig } = c;
const l = await loadTarget<typeof import('../solution/logger.ts')>(import.meta.url, 'logger.ts');
const { createLogger, redactFields } = l;
const s = await loadTarget<typeof import('../solution/server-main.ts')>(import.meta.url, 'server-main.ts');
const { startApp } = s;

const deploy = (file: string) => readFile(new URL(`../deploy/${file}`, import.meta.url), 'utf8');
const BASE = { OPENAI_BASE_URL: 'https://api.example.com/v1', OPENAI_API_KEY: 'sk-test-1234567890', OPENAI_MODEL: 'my-model', SESSION_SECRET: 'x'.repeat(40) };
/** 收集日志的 logger */
function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)), now: () => new Date('2026-11-07T00:00:00Z') }) };
}

describe('第 48 天：配置（TODO 1）', () => {
  test('默认值和类型转换', () => {
    const r = loadConfig({ ...BASE, PORT: '9000', DATABASE_URL: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toMatchObject({ NODE_ENV: 'development', ROLE: 'all', PORT: 9000, SHUTDOWN_TIMEOUT_MS: 25_000, LOG_LEVEL: 'info' });
    expect(r.config.DATABASE_URL, '空字符串当作没填').toBeUndefined();
  });

  test('所有问题一起列出来', () => {
    const r = loadConfig({ OPENAI_BASE_URL: 'not a url', PORT: '99999', ROLE: 'admin', SESSION_SECRET: 'short' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const fields = r.problems.map((p) => p.split('：')[0]).sort();
    expect(fields).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'PORT', 'ROLE', 'SESSION_SECRET']);
    expect(r.problems.find((p) => p.startsWith('SESSION_SECRET'))).toContain('openssl rand');
  });

  test('生产环境必须有数据库和 Redis', () => {
    const r = loadConfig({ ...BASE, NODE_ENV: 'production' });
    expect(r).toEqual({ ok: false, problems: ['DATABASE_URL：生产环境必须配置数据库', 'REDIS_URL：生产环境必须配置 Redis'] });
    expect(loadConfig({ ...BASE, NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db:5432/x', REDIS_URL: 'redis://redis:6379' }).ok).toBe(true);
  });

  test('describeConfig：密钥打码，网址里的密码隐藏', () => {
    expect(describeConfig({ OPENAI_API_KEY: 'sk-test-1234567890', SESSION_SECRET: 'abcdefgh', DATABASE_URL: 'postgres://research:hunter2@db:5432/research', PORT: 8080, OPENAI_MODEL: 'my-model' })).toEqual({
      OPENAI_API_KEY: 'sk-t…（18 位）',
      SESSION_SECRET: 'abcd…（8 位）',
      DATABASE_URL: 'postgres://research:***@db:5432/research',
      PORT: 8080,
      OPENAI_MODEL: 'my-model',
    });
  });
});

describe('第 48 天：结构化日志（TODO 2）', () => {
  test('一行一条 JSON；低于级别的不写；子日志带上固定字段', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (l) => lines.push(l), base: { role: 'web' }, now: () => new Date('2026-11-07T00:00:00Z') });
    logger.debug('看不到');
    logger.child({ requestId: 'r1' }).info('request', { status: 200 });
    expect(lines).toEqual(['{"time":"2026-11-07T00:00:00.000Z","level":"info","msg":"request","role":"web","requestId":"r1","status":200}']);
  });

  test('redactFields：密钥隐藏，敏感信息打码，错误只留 name 和 message', () => {
    expect(redactFields({ headers: { authorization: 'Bearer sk-xyz', Cookie: 'sid=abc' }, apiKey: 'k', question: '我的电话 13812345678', error: new Error('连接 13812345678 失败') })).toEqual({
      headers: { authorization: '[已隐藏]', Cookie: '[已隐藏]' },
      apiKey: '[已隐藏]',
      question: '我的电话 138****5678',
      error: { name: 'Error', message: '连接 138****5678 失败' },
    });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 7; i++) deep = { next: deep };
    expect(JSON.stringify(redactFields(deep))).toContain('[太深了]');
  });
});

describe('第 48 天：健康检查和路由（TODO 3）', () => {
  test('/healthz 不看依赖；/readyz 看依赖，只给名字；最长前缀优先', async () => {
    let dbOk = true;
    const { logger, lines } = memoryLogger();
    const app = await startApp({
      logger,
      routes: [
        { prefix: '/', handle: (_req, res) => void res.end('home') },
        { prefix: '/v1/jobs', handle: (_req, res) => void res.end('jobs') },
        { prefix: '/v1/boom', handle: () => Promise.reject(new Error('坏了')) },
      ],
      checks: [
        { name: 'database', check: async () => { if (!dbOk) throw new Error('ECONNREFUSED 10.0.0.5'); } },
        { name: 'slow', check: () => new Promise(() => {}) },
      ],
      checkTimeoutMs: 50,
    });
    try {
      expect(await (await fetch(`${app.url}/healthz`)).json()).toEqual({ status: 'ok' });
      const notReady = await fetch(`${app.url}/readyz`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json(), '卡住的检查也要按时回答').toEqual({ status: 'not_ready', failed: ['slow'] });
      dbOk = false;
      const text = await (await fetch(`${app.url}/readyz`)).text();
      expect(JSON.parse(text)).toEqual({ status: 'not_ready', failed: ['database', 'slow'] });
      expect(text, '不给错误详情').not.toContain('10.0.0.5');
      expect(await (await fetch(`${app.url}/v1/jobs/123`)).text()).toBe('jobs');
      expect(await (await fetch(`${app.url}/v1/jobsx`)).text(), '前缀要按路径段匹配').toBe('home');
      expect(await (await fetch(`${app.url}/anything`)).text()).toBe('home');
      expect((await fetch(`${app.url}/v1/boom`)).status).toBe(500);
      await new Promise((r) => setTimeout(r, 20));
      expect(lines.filter((l) => l.msg === 'request').map((l) => [l.path, l.status]).slice(0, 2)).toEqual([
        ['/healthz', 200],
        ['/readyz', 503],
      ]);
      expect(lines.find((l) => l.msg === 'unhandled')).toMatchObject({ path: '/v1/boom', error: { message: '坏了' } });
    } finally {
      await app.shutdown();
    }
  });
});

describe('第 48 天：优雅退出（TODO 4）', () => {
  test('退出时：readyz 变 503，不接新请求，等正在处理的做完，再按顺序关闭依赖', async () => {
    const { logger } = memoryLogger();
    const closed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = await startApp({
      logger,
      routes: [{ prefix: '/slow', handle: async (_req, res) => { await gate; res.end('做完了'); } }],
      onShutdown: [
        { name: 'queue', close: async () => void closed.push('queue') },
        { name: 'broken', close: async () => { throw new Error('关不掉'); } },
        { name: 'database', close: async () => void closed.push('database') },
      ],
      shutdownTimeoutMs: 2000,
    });
    const slow = fetch(`${app.url}/slow`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    const outcome = app.shutdown('SIGTERM');
    expect(app.shutdown(), '多次调用只执行一次').toBe(outcome);
    await expect(fetch(`${app.url}/healthz`), '不再接受新连接').rejects.toThrow();
    expect(closed, '请求还没做完，依赖不能先关').toEqual([]);
    release();
    expect(await slow).toBe('做完了');
    expect(await outcome).toBe('clean');
    expect(closed, '一个关不掉，不影响后面的').toEqual(['queue', 'database']);
  });

  test('超时就强制关闭', async () => {
    const { logger, lines } = memoryLogger();
    const app = await startApp({ logger, routes: [{ prefix: '/hang', handle: () => new Promise(() => {}) }], shutdownTimeoutMs: 100 });
    const hanging = fetch(`${app.url}/hang`).catch(() => 'closed');
    await new Promise((r) => setTimeout(r, 50));
    expect(await app.shutdown()).toBe('forced');
    expect(await hanging).toBe('closed');
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  test('readyz 在排空期间返回 shutting_down', async () => {
    const { logger } = memoryLogger();
    const app = await startApp({ logger, routes: [], drainDelayMs: 200 });
    const keepAlive = new Agent({ keepAlive: true });
    void app.shutdown();
    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = get(`${app.url}/readyz`, { agent: keepAlive }, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode!, body }));
      });
      req.end();
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'shutting_down' });
    keepAlive.destroy();
  });
});

describe('第 48 天：部署文件', () => {
  test('Dockerfile：多阶段、只装生产依赖、不用 root、有健康检查、用 exec 形式启动', async () => {
    const file = await deploy('Dockerfile');
    expect(file.match(/^FROM .+ AS \w+/gm)?.length, '多阶段构建').toBeGreaterThanOrEqual(2);
    expect(file).toMatch(/npm ci --omit=dev/);
    expect(file).toMatch(/^USER node$/m);
    expect(file).toMatch(/^HEALTHCHECK /m);
    expect(file).toMatch(/NODE_ENV=production/);
    expect(file).toMatch(/^CMD \["node", /m);
    expect(file, '不把 .env 打进镜像').not.toMatch(/COPY .*\.env/);
    const ignore = await deploy('Dockerfile.dockerignore');
    for (const entry of ['**/.env', 'node_modules', 'workspace', '.git']) expect(ignore).toContain(entry);
  });

  test('docker-compose：依赖健康了才启动；退出的宽限期比应用的超时长；数据有卷', async () => {
    const file = await deploy('docker-compose.yml');
    expect(file).toContain('condition: service_healthy');
    expect(file).toMatch(/stop_grace_period: (\d+)s/);
    expect(Number(/stop_grace_period: (\d+)s/.exec(file)![1]) * 1000).toBeGreaterThan(25_000);
    for (const v of ['pg-data:', 'redis-data:', 'app-data:']) expect(file).toContain(v);
    expect(file).toMatch(/ROLE: web/);
    expect(file).toMatch(/ROLE: worker/);
  });

  test('nginx：SSE 不缓冲、连接可以开很久；上传上限一致', async () => {
    const file = await deploy('nginx.conf');
    expect(file).toContain('proxy_buffering off');
    expect(file).toMatch(/proxy_read_timeout \d+h/);
    expect(file).toContain('client_max_body_size 20m');
  });
});
