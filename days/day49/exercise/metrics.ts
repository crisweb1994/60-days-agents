// 第 49 天：监控和告警。上线以后要第一时间知道三件事出了问题：错误率、成本、延迟。
//   指标：最近一段时间（滑动窗口）里每次研究的结果，算出错误率、延迟的 p50 / p95、每小时的花费，可以按变体分开看（A/B 测试要用）
//   告警：规则是「某个指标 大于/小于 阈值」，样本太少不告警（半夜只有 2 个请求、错了 1 个，错误率 50% 不代表出事了）；
//        告过一次以后冷却一段时间，免得每分钟响一次；恢复正常时再发一条「已恢复」
// 线上可以把这些指标导出到 Prometheus、云监控，用它们的告警；这里自己实现一遍，弄清楚每个数字是怎么来的。
// 第 49 天的练习：TODO 3、4 在这里。检查：npm run check 49
import { percentile } from './eval/regression.ts';

export interface RunRecord {
  /** 毫秒时间戳 */
  time: number;
  ok: boolean;
  latencyMs: number;
  /** 这次花了多少元 */
  cost: number;
  /** A/B 测试的变体 */
  variant?: string;
}

export interface Snapshot {
  count: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  /** 按窗口里的花费折算到每小时 */
  costPerHour: number;
}

export interface Metrics {
  record(run: Omit<RunRecord, 'time'>): void;
  /** 窗口里的指标；给了 variant 就只算这个变体 */
  snapshot(variant?: string): Snapshot;
}

/**
 * 滑动窗口的指标：只保留最近 windowMs 毫秒的记录（每次 record 和 snapshot 时把过期的删掉）。
 * snapshot：count、errorRate（没有记录时是 0）、p50 / p95（用第 33 天的 percentile）、costPerHour = 窗口里的花费 × (1 小时 / windowMs)
 */
export function createMetrics({ windowMs = 5 * 60_000, now = () => Date.now() }: { windowMs?: number; now?: () => number } = {}): Metrics {
  let runs: RunRecord[] = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    runs = runs.filter((r) => r.time > cutoff);
  };
  return {
    record(run) {
      prune();
      runs.push({ ...run, time: now() });
    },
    snapshot(variant) {
      // TODO 3：先 prune()；给了 variant 就只看这个变体的记录；按上面注释算出五个数
      void variant; void percentile;
      return { count: runs.length, errorRate: 0, p50Ms: 0, p95Ms: 0, costPerHour: 0 };
    },
  };
}

export interface AlertRule {
  name: string;
  metric: keyof Omit<Snapshot, 'count'>;
  op: '>' | '<';
  threshold: number;
  /** 窗口里少于这么多次就不判断，默认 20 */
  minCount?: number;
  /** 告过以后多久之内不再告，默认 15 分钟 */
  cooldownMs?: number;
}

export interface Alert {
  rule: string;
  /** firing：出问题了；resolved：恢复了 */
  status: 'firing' | 'resolved';
  value: number;
  threshold: number;
  message: string;
}

/** 告警的状态：每条规则在不在告警中、上次告警的时间。在两次检查之间保留 */
export type AlertState = Map<string, { firing: boolean; lastSent: number }>;

const LABELS: Record<AlertRule['metric'], string> = { errorRate: '错误率', p50Ms: '延迟 p50', p95Ms: '延迟 p95', costPerHour: '每小时花费' };
const format = (metric: AlertRule['metric'], value: number) => (metric === 'errorRate' ? `${(value * 100).toFixed(1)}%` : metric === 'costPerHour' ? `${value.toFixed(2)} 元` : `${Math.round(value)} 毫秒`);

/**
 * 检查一遍规则，返回这次要发的告警：
 * - 样本少于 minCount：跳过（不告警，也不算恢复）
 * - 超过阈值：没在告警中，或者在告警中但距离上次发送超过了 cooldownMs，就发一条 firing，记下时间
 * - 没超过：如果之前在告警中，发一条 resolved，改成不在告警中
 * message 写成「错误率 12.5%，超过了 5.0%」「错误率恢复到 1.0%」这样给人看的话
 */
export function evaluateAlerts(snapshot: Snapshot, rules: AlertRule[], state: AlertState, now = Date.now()): Alert[] {
  // TODO 4：按上面注释，逐条规则处理。state 里没有这条规则时，当作 { firing: false, lastSent: -Infinity }。
  // message 用 LABELS[metric] 和 format(metric, 值) 拼：firing 是「错误率 12.5%，超过了 5.0%」（op 是 < 时写「低于」），resolved 是「错误率恢复到 1.0%」
  void LABELS; void format; void snapshot; void rules; void state; void now;
  return [];
}

/** 研究助手常用的几条规则，阈值按自己的情况调 */
export const DEFAULT_RULES: AlertRule[] = [
  { name: 'high-error-rate', metric: 'errorRate', op: '>', threshold: 0.05 },
  { name: 'slow-p95', metric: 'p95Ms', op: '>', threshold: 120_000 },
  { name: 'cost-spike', metric: 'costPerHour', op: '>', threshold: 50 },
];

/**
 * 把告警发到一个 webhook（企业微信、飞书、钉钉的群机器人都是「POST 一段 JSON」，格式略有不同，这里用最通用的文字消息）。
 * 发送失败只记日志，不能让告警本身变成故障
 */
export async function sendWebhook(url: string, alerts: Alert[], doFetch: typeof fetch = fetch): Promise<boolean> {
  if (!alerts.length) return true;
  const text = alerts.map((a) => `${a.status === 'firing' ? '🔴' : '✅'} [研究助手] ${a.message}`).join('\n');
  try {
    const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', msgtype: 'text', text: { content: text } }) });
    return res.ok;
  } catch {
    return false;
  }
}
