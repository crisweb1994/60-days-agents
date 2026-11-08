import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const e = await loadTarget<typeof import('../solution/estimate.ts')>(import.meta.url, 'estimate.ts');
const { peakRate, concurrency, capacityPlan, monthlyCost, latency, renderPlan } = e;

describe('第 58 天：峰值和并发（TODO 1）', () => {
  test('peakRate：集中在工作时间，峰值是平均的几倍', () => {
    expect(peakRate({ perDay: 28_800 })).toBeCloseTo(3, 9);
    expect(peakRate({ perDay: 86_400, activeHours: 24, peakFactor: 1 })).toBeCloseTo(1, 9);
    expect(peakRate({ perDay: 100_000, activeHours: 10, peakFactor: 2 })).toBeCloseTo(5.5556, 3);
  });

  test('concurrency：利特尔法则', () => {
    expect(concurrency(3, 120)).toBe(360);
    expect(concurrency(0.5, 10)).toBe(5);
  });
});

describe('第 58 天：容量规划（TODO 2）', () => {
  test('代码审查机器人：每天十万个 PR', () => {
    const plan = capacityPlan({ perDay: 100_000, activeHours: 10, peakFactor: 2, avgSeconds: 120, callsPerTask: 12, tokensPerTask: 60_000, limits: { rpm: 10_000, tpm: 5_000_000 }, perWorker: 20 });
    expect(plan.peakPerSecond).toBeCloseTo(5.5556, 3);
    expect(plan.concurrentTasks).toBeCloseTo(666.67, 1);
    expect(plan.rpm).toBeCloseTo(4000, 6);
    expect(plan.tpm).toBeCloseTo(20_000_000, 3);
    expect(plan.rpmUsage).toBeCloseTo(0.4, 9);
    expect(plan.tpmUsage).toBeCloseTo(4, 9);
    expect(plan).toMatchObject({ keysNeeded: 6, workers: 34, bottleneck: 'tpm' });
    expect(renderPlan(plan).split('\n')).toEqual(['峰值 5.56 个任务/秒，同时在跑 667 个', '峰值每分钟 4,000 次调用（一个 Key 的 40%）、20,000,000 个 token（400%）', '先撞上 TPM：要 6 个 Key 的额度，34 个 worker']);
  });

  test('小流量：至少 1 个 Key、1 个 worker；调用多 token 少时先撞 RPM', () => {
    const plan = capacityPlan({ perDay: 1000, avgSeconds: 30, callsPerTask: 50, tokensPerTask: 1000, limits: { rpm: 60, tpm: 1_000_000 }, perWorker: 10, headroom: 0.5 });
    expect(plan.bottleneck).toBe('rpm');
    expect(plan.rpmUsage).toBeCloseTo(312.5 / 60, 6);
    expect(plan.keysNeeded).toBe(11);
    expect(plan.workers).toBe(1);
    expect(capacityPlan({ perDay: 10, avgSeconds: 1, callsPerTask: 1, tokensPerTask: 1, limits: { rpm: 1000, tpm: 1000 }, perWorker: 1 })).toMatchObject({ keysNeeded: 1, workers: 1 });
  });

  test('monthlyCost', () => {
    expect(monthlyCost(100_000, 0.09)).toBeCloseTo(270_000, 6);
    expect(monthlyCost(10, 1, 31)).toBe(310);
  });
});

describe('第 58 天：延迟和关键路径（TODO 3）', () => {
  test('并行的一步取最慢的；关键路径列出名字', () => {
    const r = latency([
      { name: '取 diff', ms: 800 },
      { parallel: [{ name: '审 a.ts', ms: 40_000 }, { name: '审 b.ts', ms: 65_000 }, { name: '写总结', ms: 9_000 }] },
      { name: '汇总', ms: 5 },
      { name: '发评论', ms: 600 },
    ]);
    expect(r).toEqual({ totalMs: 66_405, critical: ['取 diff', '审 b.ts', '汇总', '发评论'] });
  });

  test('空的并行不算；一样慢取前面的', () => {
    expect(latency([{ parallel: [] }, { parallel: [{ name: 'a', ms: 5 }, { name: 'b', ms: 5 }] }])).toEqual({ totalMs: 5, critical: ['a'] });
    expect(latency([])).toEqual({ totalMs: 0, critical: [] });
  });
});
