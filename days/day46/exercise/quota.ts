// 第 46 天：配额与限流。多用户以后，一个用户（或者一个被盗的 Key）不能把整个服务的模型额度用光。
//   限流：短时间内的请求速率，用令牌桶：桶里最多 capacity 个令牌，每秒补 refillPerSecond 个，每个请求拿一个，拿不到就 429
//   配额：每天能提交多少次、花多少钱，记在数据库的 usage_daily 里（第 36 天的账本存进了数据库），按用户隔离
// 第 46 天的练习：TODO 5 在这里。检查：npm run check 46
// 限流放在内存里（单机够用；多机用 Redis），配额放在数据库里（要准、要能跨进程、要能给用户看）。
import { withTenant, type Db } from './db.ts';

export interface RateLimiter {
  /** 拿一个令牌。拿到了 ok 是 true；拿不到 retryAfterMs 是还要等多久才有下一个 */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number };
}

/**
 * 令牌桶。每个 key 一个桶，第一次见到时是满的。拿令牌之前，先按距离上次过去的时间补令牌（不超过 capacity）；
 * 够一个就拿走；不够就算出还差多少、要等多久（向上取整到毫秒）
 */
export function createRateLimiter({ capacity, refillPerSecond, now = () => Date.now() }: { capacity: number; refillPerSecond: number; now?: () => number }): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key) {
      // TODO 5：取出这个 key 的桶（没有就是满的：tokens = capacity，at = 现在）；按过去的时间补令牌（不超过 capacity），更新 at；
      // 够一个就减一返回 ok；不够就返回 retryAfterMs：还差的令牌 / refillPerSecond，换成毫秒向上取整
      void buckets; void now; void capacity; void refillPerSecond; void key;
      return { ok: true };
    },
  };
}

export interface DailyQuota {
  /** 每天最多几次请求 */
  maxRequests: number;
  /** 每天最多花多少元 */
  maxCost: number;
}

export interface QuotaStatus {
  requests: number;
  cost: number;
  /** 还能不能再提交 */
  ok: boolean;
  /** 不能时的原因，给用户看 */
  reason?: string;
}

/** 今天（按 UTC）的日期，YYYY-MM-DD */
export const today = (now: Date) => now.toISOString().slice(0, 10);

/** 查这个用户今天用了多少、还能不能再提交 */
export async function checkQuota(db: Db, userId: string, quota: DailyQuota, now = new Date()): Promise<QuotaStatus> {
  const { rows } = await withTenant(db, userId, (tx) => tx.query<{ requests: number; cost: number }>('select requests, cost from usage_daily where user_id = $1 and day = $2', [userId, today(now)]));
  const requests = Number(rows[0]?.requests ?? 0);
  const cost = Number(rows[0]?.cost ?? 0);
  if (requests >= quota.maxRequests) return { requests, cost, ok: false, reason: `今天的次数用完了（${quota.maxRequests} 次），明天再来吧` };
  if (cost >= quota.maxCost) return { requests, cost, ok: false, reason: '今天的额度用完了，明天再来吧' };
  return { requests, cost, ok: true };
}

/**
 * 记下一次请求：次数加一，花费加上 cost。今天还没有记录就插入一行（insert … on conflict do update，一条语句，几个请求同时来也不会少算）
 */
export async function recordUsage(db: Db, userId: string, cost: number, now = new Date()): Promise<void> {
  await withTenant(db, userId, (tx) =>
    tx.query(
      `insert into usage_daily (user_id, day, requests, cost) values ($1, $2, 1, $3)
       on conflict (user_id, day) do update set requests = usage_daily.requests + 1, cost = usage_daily.cost + excluded.cost`,
      [userId, today(now), cost],
    ),
  );
}
