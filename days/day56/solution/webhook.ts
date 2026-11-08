// 第 56 天：接 GitHub 的 webhook。PR 打开、推了新提交，GitHub 就 POST 一个事件过来。三件事：
//   签名：谁都能往你的地址 POST，只有带着正确签名的才是 GitHub 发的（X-Hub-Signature-256，HMAC-SHA256）
//   过滤：只处理该处理的事件。草稿 PR 不审；机器人自己触发的事件不处理，免得两个机器人互相触发、无限循环
//   去重：GitHub 收不到 2xx 会重发，同一个事件（X-GitHub-Delivery 一样）只处理一次，否则同一个 PR 会被评论两遍
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * 校验签名（TODO 1）。header 的格式是「sha256=十六进制」：
 * - 没有 header、不是 sha256= 开头：false
 * - 用 secret 对原始的请求体算 HMAC-SHA256，和 header 里的比较：用 timingSafeEqual（长度不同直接 false，第 40 天）
 * 一定要对**原始的字节**算：先 JSON.parse 再 JSON.stringify，空格和键的顺序一变，签名就对不上了
 */
export function verifySignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const actual = Buffer.from(header.slice('sha256='.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 给测试和本机调试用：算出 GitHub 会发的签名 */
export function sign(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** 会触发审查的动作：打开、推了新提交、重新打开、从草稿变成可以审查 */
export const REVIEW_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const;

const PullRequestPayload = z.object({
  action: z.string(),
  number: z.int().positive(),
  pull_request: z.object({
    draft: z.boolean().default(false),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    title: z.string().default(''),
  }),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  sender: z.object({ login: z.string(), type: z.string().default('User') }),
});

export interface PullRequestEvent {
  repo: string;
  number: number;
  headSha: string;
  title: string;
  action: (typeof REVIEW_ACTIONS)[number];
}

/**
 * 判断一个事件要不要处理（TODO 2（一））。按顺序检查，第一条不满足的就是理由：
 * 1. event 不是 pull_request：{ ok: false, reason: '不处理 x 事件' }
 * 2. payload 不符合 PullRequestPayload：「事件的格式不对」
 * 3. action 不在 REVIEW_ACTIONS 里：「不处理 x 动作」
 * 4. 是草稿（draft）：「草稿 PR 不审」
 * 5. sender.type 是 Bot：「机器人触发的事件不处理」
 * 都满足：{ ok: true, pr: { repo, number, headSha, title, action } }
 */
export function parsePullRequestEvent(event: string | undefined, payload: unknown): { ok: true; pr: PullRequestEvent } | { ok: false; reason: string } {
  if (event !== 'pull_request') return { ok: false, reason: `不处理 ${event ?? '（没有）'} 事件` };
  const parsed = PullRequestPayload.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: '事件的格式不对' };
  const p = parsed.data;
  if (!(REVIEW_ACTIONS as readonly string[]).includes(p.action)) return { ok: false, reason: `不处理 ${p.action} 动作` };
  if (p.pull_request.draft) return { ok: false, reason: '草稿 PR 不审' };
  if (p.sender.type === 'Bot') return { ok: false, reason: '机器人触发的事件不处理' };
  return { ok: true, pr: { repo: p.repository.full_name, number: p.number, headSha: p.pull_request.head.sha, title: p.pull_request.title, action: p.action as PullRequestEvent['action'] } };
}

export interface DeliveryDedup {
  /** 第一次见到返回 false 并记下；见过（而且还没过期）返回 true */
  seen(id: string): boolean;
}

/**
 * 记住处理过的 X-GitHub-Delivery（TODO 2（二））：
 * - 见过、而且距离第一次见到不超过 ttlMs（默认 24 小时）：true
 * - 否则记下现在的时间，返回 false
 * - 记的数量超过 max（默认 10000）时，删掉最早记下的（Map 按插入的顺序遍历），内存不会无限长
 * 只在一个进程的内存里：多台机器、重启以后要换成 Redis 的 SET NX EX（第 45 天）
 */
export function createDeliveryDedup({ ttlMs = 24 * 3_600_000, max = 10_000, now = () => Date.now() } = {}): DeliveryDedup {
  const seenAt = new Map<string, number>();
  return {
    seen(id) {
      const t = now();
      const first = seenAt.get(id);
      if (first !== undefined && t - first <= ttlMs) return true;
      seenAt.delete(id);
      seenAt.set(id, t);
      while (seenAt.size > max) seenAt.delete(seenAt.keys().next().value!);
      return false;
    },
  };
}
