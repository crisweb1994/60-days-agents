// 第 56 天：review-bot 上线的样子。一个 HTTP 服务，只有两个地址：
//   POST /webhook  GitHub 发来的事件：验签 → 过滤 → 去重 → 允许的仓库 → 花费上限 → 马上回 202，审查放到后台
//   GET  /healthz  健康检查（第 48 天）
// 为什么马上回 202：GitHub 等 webhook 的响应只等 10 秒，审一个 PR 要几分钟。超时了它会当作失败、过一会儿重发。
// 后台这里用一条 Promise 链一个一个地审，小团队够用；PR 多了换成第 45 天的任务队列。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Model } from './core/types.ts';
import type { GitHubClient } from './github.ts';
import { toReviewPayload } from './github.ts';
import { createRepo } from './repo.ts';
import { review } from './review.ts';
import type { SpendGuard } from './spend-guard.ts';
import { createDeliveryDedup, parsePullRequestEvent, verifySignature, type DeliveryDedup, type PullRequestEvent } from './webhook.ts';

export interface BotOptions {
  /** webhook 的密钥：在 GitHub 上配置 webhook 时填的那个 */
  secret: string;
  github: GitHubClient;
  /** 把仓库检出到某个提交，返回目录。线上：git clone --depth 1 加 git checkout，或者下载 tarball 解压到临时目录 */
  checkout: (repo: string, sha: string) => Promise<string>;
  model: Model;
  dedup?: DeliveryDedup;
  /** 只审这些仓库；不给就都审 */
  allowedRepos?: string[];
  /** 花费上限；到了就不再审 */
  guard?: SpendGuard;
  /** 请求体最多多大，默认 1MB */
  maxBodyBytes?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createReviewBot(options: BotOptions) {
  const { secret, github, checkout, model, dedup = createDeliveryDedup(), allowedRepos, guard, maxBodyBytes = 1024 * 1024, log = () => {} } = options;
  let chain = Promise.resolve();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  /** 后台审一个 PR。出错只写日志：GitHub 那边已经收到 202 了，不会再重发 */
  async function process(pr: PullRequestEvent, delivery: string): Promise<void> {
    const started = Date.now();
    try {
      const diff = await github.getDiff(pr.repo, pr.number);
      const dir = await checkout(pr.repo, pr.headSha);
      const result = await review({ title: pr.title, diff }, { model, repo: createRepo(dir) });
      // 只改了生成的文件、空的 PR：不发评论，免得刷屏
      if (!result.files.length) return log('review.skipped', { delivery, repo: pr.repo, number: pr.number, reason: result.summary });
      await github.createReview(pr.repo, pr.number, toReviewPayload(result, pr.headSha));
      log('review.posted', { delivery, repo: pr.repo, number: pr.number, comments: result.comments.length, status: result.status, ms: Date.now() - started });
    } catch (error) {
      log('review.failed', { delivery, repo: pr.repo, number: pr.number, error: (error as Error).message });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || path !== '/webhook') return json(res, 404, { error: '只有 POST /webhook' });
    const raw = await readRaw(req, maxBodyBytes);
    if (!raw) return json(res, 413, { error: '请求体太大了' });
    // 先验签，再做任何别的事：没通过验签的请求，连 JSON 都不解析
    if (!verifySignature(secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) return json(res, 401, { error: '签名不对' });
    const delivery = String(req.headers['x-github-delivery'] ?? '');
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { error: '请求体不是 JSON' });
    }
    const parsed = parsePullRequestEvent(req.headers['x-github-event'] as string | undefined, payload);
    if (!parsed.ok) return json(res, 202, { ignored: parsed.reason });
    if (delivery && dedup.seen(delivery)) return json(res, 202, { duplicate: true });
    if (allowedRepos && !allowedRepos.includes(parsed.pr.repo)) return json(res, 403, { error: `不审 ${parsed.pr.repo}` });
    const spend = guard?.status();
    if (spend?.mode === 'stopped') {
      log('review.budget', { delivery, repo: parsed.pr.repo, number: parsed.pr.number, spent: spend.month.spent });
      return json(res, 202, { skipped: '花费到了上限' });
    }
    chain = chain.then(() => process(parsed.pr, delivery));
    log('review.queued', { delivery, repo: parsed.pr.repo, number: parsed.pr.number, action: parsed.pr.action });
    return json(res, 202, { queued: true });
  }

  return {
    handle,
    /** 等后台的审查都做完（测试和优雅退出用） */
    idle: () => chain,
  };
}

// 运行：node days/day56/exercise/app.ts（配置见 README 的「上线」一节）
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 生产上由平台注入环境变量
  }
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  const { createGitHubClient } = await import('./github.ts');
  const { createOpenAIModel, openAIConfigFromEnv } = await import('./core/openai.ts');
  const { withRetry } = await import('./core/retry.ts');
  const { parsePrice } = await import('./core/usage.ts');
  const { guardedModel, openSpendGuard } = await import('./spend-guard.ts');
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`缺少配置 ${name}`);
    return value;
  };
  const token = env('GITHUB_TOKEN');
  const config = openAIConfigFromEnv();
  const primary = withRetry(createOpenAIModel(config));
  const cheap = withRetry(createOpenAIModel({ ...config, model: process.env.CHEAP_MODEL || config.model }));
  const guard = await openSpendGuard(process.env.SPEND_FILE ?? '/data/spend.json', { daily: Number(env('SPEND_DAILY')), monthly: Number(env('SPEND_MONTHLY')) });
  const price = parsePrice(env('OPENAI_PRICE'))!;
  const run = promisify(execFile);
  const checkouts: string[] = [];
  const bot = createReviewBot({
    secret: env('WEBHOOK_SECRET'),
    github: createGitHubClient({ token }),
    model: guardedModel({ primary, cheap }, { primary: price, cheap: parsePrice(process.env.CHEAP_PRICE) ?? price }, guard),
    guard,
    allowedRepos: process.env.ALLOWED_REPOS?.split(',').map((r) => r.trim()).filter(Boolean),
    // 浅克隆到临时目录。令牌放在请求头里，不拼进网址（网址会出现在 git 的错误信息和进程列表里）
    checkout: async (repo, sha) => {
      for (const old of checkouts.splice(0)) await rm(old, { recursive: true, force: true });
      const dir = await mkdtemp(join(tmpdir(), 'review-'));
      checkouts.push(dir);
      const auth = ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`];
      await run('git', ['init', '-q', dir]);
      await run('git', [...auth, '-C', dir, 'fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, sha]);
      await run('git', ['-C', dir, '-c', 'core.symlinks=false', 'checkout', '-q', 'FETCH_HEAD']);
      return dir;
    },
    log: (event, fields) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })),
  });
  const server = createServer((req, res) => void bot.handle(req, res));
  server.listen(Number(process.env.PORT ?? 8080), () => console.log(`review-bot 在 ${process.env.PORT ?? 8080} 端口等 webhook`));
  process.once('SIGTERM', () => server.close(() => void bot.idle().then(() => process.exit(0))));
}
