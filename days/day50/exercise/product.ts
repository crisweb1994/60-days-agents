// 第 50 天：研究助手上线。把第 41–49 天的部件装成一个给真人用的产品：
//   登录（第 46 天）→ 限流和每日配额（第 46 天）→ 按灰度选 prompt 的版本（第 49 天）→ 放进后台队列（第 45 天）
//   → 网页用 SSE 看进度、断线续传（第 44、45 天）→ 看完回答点赞或点踩（第 49 天）→ 差评进待审核的评估集
//   每个任务结束时记下指标（错误率、延迟、成本，按变体分开）和用户的用量；告警按规则发到群机器人；管理员看灰度的对比
//
// 接口（都在 /api 下，登录用 Cookie，程序调用用 API Key）：
//   POST   /api/signup  /api/login  /api/logout     GET /api/me
//   POST   /api/research                  提交一次研究，202 和任务编号
//   GET    /api/jobs/:id                  状态和结果       DELETE /api/jobs/:id  取消
//   GET    /api/jobs/:id/events           SSE，带 Last-Event-ID 续传
//   POST   /api/jobs/:id/feedback         赞或踩
//   GET    /api/admin/stats               管理员：指标、好评率、灰度的对比
// 网页：GET / 和 /app.js（public/），/timeline.js（第 44 天）。
// 第 50 天的练习：TODO 1–6 在这里，TODO 7 在 pilot.ts。检查：npm run check 50
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { createSessionToken, createUser, findUserByApiKey, login, readSessionCookie, sessionCookie, verifySessionToken, type ScryptParams } from './auth.ts';
import type { Db } from './db.ts';
import { handleFeedback, ratingStats, type Feedback, type FeedbackStore } from './feedback.ts';
import { FINAL_STATUSES, type JobQueue, type JobRecord, type JobRunner, type JobStore } from './jobs.ts';
import { publicJob, resumeFrom, streamJobEvents } from './jobs-server.ts';
import { evaluateAlerts, sendWebhook, DEFAULT_RULES, type Alert, type AlertRule, type AlertState, type Metrics } from './metrics.ts';
import type { PromptRegistry } from './prompt-registry.ts';
import { checkQuota, recordUsage, type DailyQuota, type RateLimiter } from './quota.ts';
import { canary, chooseVariant, compareRates } from './rollout.ts';
import { HttpError, readJsonBody } from './service.ts';
import { calcCost, emptyUsage, type Price } from './usage.ts';
import { browserTimeline, WebRequestSchema } from './web-server.ts';

/** 研究助手的 prompt 在注册表里的名字，和灰度实验的名字 */
export const PROMPT_NAME = 'research';
export const EXPERIMENT = 'research-prompt';

export interface ProductOptions {
  db: Db;
  store: JobStore;
  queue: JobQueue;
  /** 会话令牌的签名密钥（第 46 天） */
  sessionSecret: string;
  prompts: PromptRegistry;
  /** canary 标签的 prompt 给多少用户，0–100，默认 0（不灰度） */
  canaryPercent?: number;
  feedback: FeedbackStore;
  /** 差评转成的用例追加到哪个文件（第 49 天） */
  pendingFile: string;
  metrics: Metrics;
  limiter: RateLimiter;
  quota: DailyQuota;
  /** 管理员的用户编号 */
  admins?: string[];
  /** 注册要不要邀请码。试用阶段只给邀请的人用；不给就谁都能注册 */
  inviteCodes?: string[];
  heartbeatMs?: number;
  now?: () => Date;
  /** 密码哈希的参数，测试时调小 */
  scrypt?: ScryptParams;
  /** Cookie 带不带 Secure。本机用 http 调试时要关掉，不然浏览器不存 */
  secureCookie?: boolean;
}

/**
 * 认出这个请求是谁（TODO 1）：
 * - Authorization: Bearer ra_… → 用 API Key 找（findUserByApiKey）。带了 Authorization 却不对，就是认不出，不再看 Cookie
 * - 否则看 Cookie 里的 sid：verifySessionToken 通过就是它的 sub
 * - 都没有：undefined
 */
export async function resolveUser(req: IncomingMessage, db: Db, secret: string, now: () => Date = () => new Date()): Promise<string | undefined> {
  // TODO 1：先看 Authorization：有这个头就只按它认（用正则取出 Bearer 后面的 key，不分大小写，允许末尾空格），交给 findUserByApiKey；
  // 格式不对直接返回 undefined，不要再去看 Cookie。没有这个头时，用 readSessionCookie 取出 sid、verifySessionToken 验证（它的 now 要的是毫秒），返回 sub
  void findUserByApiKey; void readSessionCookie; void verifySessionToken; void req; void db; void secret; void now;
  throw new Error('TODO 1：还没有实现 resolveUser');
}

export interface PromptAssignment {
  promptVersion: string;
  variant: 'stable' | 'canary';
  content: string;
}

/**
 * 给用户选一版 prompt（TODO 2）：
 * - production 标签的版本是稳定版；没有就抛错（还没有上线的 prompt）
 * - canary 标签有版本、和稳定版不同、percent 大于 0：用 canary(EXPERIMENT, percent, 稳定版, 新版) 和 chooseVariant 按用户分桶
 * - 否则都用稳定版
 * 返回版本号、变体的名字（stable 或 canary）和 prompt 的内容
 */
export function assignPrompt(registry: PromptRegistry, userId: string, percent: number): PromptAssignment {
  // TODO 2：registry.get(PROMPT_NAME) 是稳定版，没有就抛错（错误信息里要有「还没有上线的 prompt」）；
  // registry.get(PROMPT_NAME, 'canary') 是新版。新版存在、和稳定版不是同一版、percent 大于 0 时，
  // 用 canary(EXPERIMENT, percent, 稳定版, 新版) 建实验、chooseVariant 按 userId 选；否则就是稳定版。
  // 返回 { promptVersion: 版本号, variant: 'stable' 或 'canary', content: prompt 的内容 }
  void canary; void chooseVariant; void registry; void userId; void percent;
  throw new Error('TODO 2：还没有实现 assignPrompt');
}

export interface OpsOptions {
  store: JobStore;
  metrics: Metrics;
  db: Db;
  /** 模型的单价。不给就按 0 算（只统计次数） */
  price?: Price;
  now?: () => Date;
}

/**
 * 包一层 JobRunner，在任务结束时记账（TODO 5）。不管 runner 正常返回还是抛错，都要：
 * - 重新读一次任务。还没结束（改回 queued 等重试、或者进程要退出）：什么都不记，等它真的结束
 * - 结束了：成本 = calcCost(job.usage ?? 空用量, price)，recordUsage 记进这个用户今天的用量（取消的也花了钱，也要记）
 * - completed 和 failed 还要 metrics.record：ok 是「completed 而且回答的 status 也是 completed」；
 *   latencyMs 是从提交（createdAt）到现在，用户等了多久；带上 cost 和 variant。用户自己取消的不算进指标
 * runner 抛出的错误照样抛出去（队列要靠它决定重试）
 */
export function withOps(runner: JobRunner, options: OpsOptions): JobRunner {
  // TODO 5：返回一个新的 JobRunner：先调用 runner，不管它正常返回还是抛错（try/finally），都重新读一次任务再记账：
  // 还没结束（FINAL_STATUSES 里没有它的状态）就什么都不记；结束了先用 calcCost 算成本（没有 price 按 0）、recordUsage 记进用户今天的用量；
  // 不是 cancelled 的再 metrics.record({ ok, latencyMs, cost, variant })。runner 的错误要照样抛出去
  const { store, metrics, db, price, now = () => new Date() } = options;
  void store; void metrics; void db; void price; void now; void calcCost; void emptyUsage; void recordUsage; void FINAL_STATUSES;
  return runner;
}

export interface AlertLoopOptions {
  metrics: Metrics;
  rules?: AlertRule[];
  /** 群机器人的地址。不给就只回调 onAlert（写日志） */
  webhookUrl?: string;
  intervalMs?: number;
  onAlert?: (alert: Alert) => void;
  doFetch?: typeof fetch;
  now?: () => number;
}

/** 每隔 intervalMs（默认 1 分钟）检查一次告警规则，有要发的就发。返回停止的函数，也可以手动 tick 一次 */
export function startAlertLoop(options: AlertLoopOptions): { tick(): Promise<Alert[]>; stop(): void } {
  const { metrics, rules = DEFAULT_RULES, webhookUrl, intervalMs = 60_000, onAlert, doFetch, now = () => Date.now() } = options;
  const state: AlertState = new Map();
  const tick = async () => {
    const alerts = evaluateAlerts(metrics.snapshot(), rules, state, now());
    for (const alert of alerts) onAlert?.(alert);
    if (alerts.length && webhookUrl) await sendWebhook(webhookUrl, alerts, doFetch);
    return alerts;
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

const CredentialsSchema = z.strictObject({
  email: z.email('邮箱的格式不对'),
  password: z.string().min(8, '密码至少 8 位').max(200),
  invite: z.string().optional(),
});

export const FeedbackRequestSchema = z.strictObject({
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(1000, '评论最多 1000 字').optional(),
});

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
};

export function createProductApp(options: ProductOptions) {
  const { db, store, queue, sessionSecret, prompts, canaryPercent = 0, feedback, pendingFile, metrics, limiter, quota, admins = [], inviteCodes, heartbeatMs, now = () => new Date(), scrypt, secureCookie = true } = options;
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const cookie = (token: string, maxAge?: number) => {
    const value = sessionCookie(token, maxAge);
    return secureCookie ? value : value.replace('; Secure', '');
  };
  const requireUser = async (req: IncomingMessage) => {
    const userId = await resolveUser(req, db, sessionSecret, now);
    if (!userId) throw new HttpError(401, '请先登录');
    return userId;
  };
  /** 这个用户的任务。别人的也说没有（第 40 天） */
  const own = async (id: string, userId: string) => {
    const job = await store.get(id);
    if (!job || job.userId !== userId) throw new HttpError(404, '没有这个任务');
    return job;
  };

  /**
   * 提交一次研究（TODO 3）：
   * 1. 限流：limiter.take(userId)，拿不到就 429，Retry-After 是秒数（向上取整）
   * 2. 每日配额：checkQuota，不 ok 就 429，错误信息是它的 reason
   * 3. 请求体用 WebRequestSchema 校验（第 44 天），不对就 400
   * 4. assignPrompt 选版本，创建任务时带上 promptVersion 和 variant，放进队列
   * 返回任务的 id 和 status（不返回版本和变体：用户不需要知道自己在哪个实验组）
   */
  async function submitResearch(req: IncomingMessage, userId: string): Promise<{ id: string; status: string }> {
    // TODO 3：按上面注释的四步做。限流的 Retry-After 用 Math.ceil(retryAfterMs / 1000) 转成秒；
    // 两种 429、400 都用 HttpError 抛出（第三个参数是响应头）。最后 store.create 时带上 promptVersion 和 variant，再 queue.enqueue
    void limiter; void checkQuota; void quota; void WebRequestSchema; void readJsonBody; void canaryPercent; void req; void userId;
    throw new HttpError(501, 'TODO 3：还没有实现提交研究');
}

  /**
   * 收下一条反馈（TODO 4）：
   * - 请求体用 FeedbackRequestSchema 校验，不对就 400
   * - 任务还没完成（不是 completed）：409
   * - 来源从任务存下的块里找：每个 source-url 块的 url
   * - 组装 Feedback（runId 是任务编号，回答是 result.text，promptVersion 没有就写 unknown），交给 handleFeedback
   * 返回 { queuedForReview }：这条差评有没有变成新的待审核用例
   */
  async function submitFeedback(req: IncomingMessage, job: JobRecord): Promise<{ queuedForReview: boolean }> {
    // TODO 4：校验请求体（readJsonBody 最多 8KB）；任务不是 completed 抛 409；
    // 用 store.events(job.id) 找出所有 source-url 块的 url；组装 Feedback（comment、variant 没有就不要这个字段），
    // createdAt 用 now()；交给 handleFeedback(feedback, 这条反馈, pendingFile)，返回 { queuedForReview: 它的结果 }
    void FeedbackRequestSchema; void handleFeedback; void pendingFile; void feedback; void req; void job;
    throw new HttpError(501, 'TODO 4：还没有实现反馈');
}

  /**
   * 管理员看的统计（TODO 6）：
   * - overall：metrics.snapshot()；variants：stable 和 canary 各自的 snapshot
   * - ratings：两个变体各自的 ratingStats
   * - comparison：compareRates(stable 的好评, canary 的好评)，B 是 canary
   * - prompts：production 和 canary 标签当前指向的版本号（没有就是 null）
   */
  async function adminStats() {
    // TODO 6：按上面注释组装返回的对象。ratingStats 和 compareRates 都是第 49 天写好的
    void ratingStats; void compareRates;
    throw new HttpError(501, 'TODO 6：还没有实现管理统计');
}

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && STATIC[pathname]) {
        const { file, type } = STATIC[pathname];
        res.writeHead(200, { 'content-type': type });
        return void res.end(await readFile(join(import.meta.dirname, file)));
      }
      if (method === 'GET' && pathname === '/timeline.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return void res.end(await browserTimeline());
      }
      if (method === 'POST' && (pathname === '/api/signup' || pathname === '/api/login')) {
        const parsed = CredentialsSchema.safeParse(await readJsonBody(req, 4 * 1024));
        if (!parsed.success) throw new HttpError(400, `参数不对：${parsed.error.issues[0].message}`);
        const { email, password, invite } = parsed.data;
        let userId: string | undefined;
        if (pathname === '/api/signup') {
          if (inviteCodes && !inviteCodes.includes(invite ?? '')) throw new HttpError(403, '现在是邀请试用，需要邀请码');
          userId = (await createUser(db, email, password, scrypt).catch(() => undefined))?.id;
          if (!userId) throw new HttpError(409, '这个邮箱已经注册过了');
        } else {
          userId = await login(db, email, password);
          if (!userId) throw new HttpError(401, '邮箱或密码不对');
        }
        const token = createSessionToken(userId, sessionSecret, { now: () => now().getTime() });
        return json(res, 200, { id: userId }, { 'set-cookie': cookie(token) });
      }
      if (method === 'POST' && pathname === '/api/logout') return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });

      const userId = await requireUser(req);
      if (method === 'GET' && pathname === '/api/me') return json(res, 200, { id: userId, admin: admins.includes(userId) });
      if (pathname === '/api/research') {
        if (method !== 'POST') throw new HttpError(405, '只支持 POST', { allow: 'POST' });
        const job = await submitResearch(req, userId);
        return json(res, 202, job, { location: `/api/jobs/${job.id}` });
      }
      if (pathname === '/api/admin/stats') {
        // 不是管理员也说没有这个接口：不告诉别人这里有个后台
        if (!admins.includes(userId)) throw new HttpError(404, `没有 ${pathname}`);
        return json(res, 200, await adminStats());
      }
      const match = /^\/api\/jobs\/([^/]+)(?:\/(events|feedback))?$/.exec(pathname);
      if (!match) throw new HttpError(404, `没有 ${pathname}`);
      const job = await own(match[1], userId);
      const sub = match[2];
      if (sub === 'events' && method === 'GET') return await streamJobEvents(res, store, job.id, resumeFrom(req), heartbeatMs);
      if (sub === 'feedback' && method === 'POST') return json(res, 201, await submitFeedback(req, job));
      if (!sub && method === 'GET') {
        const { promptVersion: _version, variant: _variant, usage: _usage, ...visible } = publicJob(job);
        return json(res, 200, visible);
      }
      if (!sub && method === 'DELETE') {
        if (FINAL_STATUSES.has(job.status)) throw new HttpError(409, `任务已经结束了（${job.status}）`);
        await queue.cancel(job.id);
        return json(res, 202, { id: job.id, status: 'cancelling' });
      }
      throw new HttpError(405, '不支持这个方法');
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) return json(res, error.status, { error: error.message }, error.headers);
      throw error; // 交给 server-main.ts 的 createApp：写日志、返回 500
    }
  };
}
