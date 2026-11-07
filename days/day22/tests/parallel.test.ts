import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import { API_KEY, startFixture } from './web-fixture.ts';

const fixture = await startFixture();
const { fulfilled, mapLimit, vote } = await loadTarget<typeof import('../solution/parallel.ts')>(import.meta.url, 'parallel.ts');
const { gatherMaterials } = await loadTarget<typeof import('../solution/workflow.ts')>(import.meta.url, 'workflow.ts');
const { createSourceRegistry } = await loadTarget<typeof import('../solution/web.ts')>(import.meta.url, 'web.ts');
const { createTavilySearch } = await loadTarget<typeof import('../solution/search.ts')>(import.meta.url, 'search.ts');

/** 记下同时有几个在跑，最多的时候是几个 */
function tracker() {
  const state = { active: 0, max: 0, started: [] as number[] };
  return {
    state,
    async run<T>(index: number, ms: number, value: T): Promise<T> {
      state.started.push(index);
      state.active++;
      state.max = Math.max(state.max, state.active);
      await sleep(ms);
      state.active--;
      return value;
    },
  };
}

describe('第 22 天：在并发上限内并行（TODO 1）', () => {
  test('同时最多 limit 个，结果的顺序和输入一致，不管谁先做完', async () => {
    const t = tracker();
    const delays = [40, 10, 30, 5, 20];
    const results = await mapLimit(delays, 2, (ms, i) => t.run(i, ms, `第 ${i} 个`));
    expect(t.state.max, '同时跑的不能超过 2 个').toBe(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual(['第 0 个', '第 1 个', '第 2 个', '第 3 个', '第 4 个']);
    expect(t.state.started, '按顺序开始').toEqual([0, 1, 2, 3, 4]);
  });

  test('真的是并行：5 个 100 毫秒的任务，并发 5 个时总共只要 100 多毫秒', async () => {
    const t = tracker();
    const start = performance.now();
    await mapLimit([1, 2, 3, 4, 5], 5, (n, i) => t.run(i, 100, n));
    expect(t.state.max).toBe(5);
    expect(performance.now() - start, '一个接一个地做要 500 毫秒').toBeLessThan(400);
  });

  test('一项失败不影响其他项；limit 比项数多也没关系', async () => {
    const results = await mapLimit(['好', '坏', '好'], 10, async (s) => {
      if (s === '坏') throw new Error('出错了');
      return s;
    });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('出错了') });
    expect(fulfilled(results)).toEqual(['好', '好']);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });

  test('signal 触发以后，还没开始的不再开始', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const results = await mapLimit([0, 1, 2, 3], 1, async (n) => {
      started.push(n);
      if (n === 1) controller.abort();
      return n;
    }, controller.signal);
    expect(started).toEqual([0, 1]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected']);
  });

  test('limit 不是正整数时报错', async () => {
    await expect(mapLimit([1], 0, async (n) => n)).rejects.toThrow('并发上限');
  });
});

describe('第 22 天：多数投票（TODO 2）', () => {
  test('取出现最多的；平票时取最先出现的；agreement 是得票的比例', () => {
    expect(vote(['docs', 'research', 'docs'])).toEqual({ winner: 'docs', count: 2, total: 3, agreement: 2 / 3 });
    expect(vote(['research', 'chat'])?.winner, '平票取先出现的').toBe('research');
    expect(vote(['chat', 'docs', 'docs', 'chat'])?.winner).toBe('chat');
    expect(vote(['chat'])).toEqual({ winner: 'chat', count: 1, total: 1, agreement: 1 });
    expect(vote([])).toBeUndefined();
  });
});

describe('第 22 天：固定流程里的并行搜索（TODO 6）', () => {
  test('几个搜索词同时搜，同时最多 concurrency 个；合并的顺序和串行时一样', async () => {
    const t = tracker();
    const real = createTavilySearch({ apiKey: API_KEY, baseURL: `${fixture.base}/tavily` });
    const queries = ['潮汐 性能', '潮汐 迁移', '潮汐 价格', '潮汐 端口'];
    // 第一个词最慢：串行时它也是第一个，合并以后的顺序不能因为它最后搜完就变
    const slow = { name: 'slow', search: async (q: string) => t.run(queries.indexOf(q), q === '潮汐 性能' ? 100 : 30, await real.search(q)) };
    const materials = await gatherMaterials(queries, { search: slow, sources: createSourceRegistry(), maxPages: 5, concurrency: 2, fetchOptions: { allowPrivate: true } });
    expect(t.state.max, '同时最多 2 个搜索，而且真的有 2 个同时在搜').toBe(2);
    expect(materials.map((m) => m.source.id)).toEqual([1, 2, 3, 4, 5]);
    expect(materials.map((m) => m.source.title)).toEqual([
      '潮汐协议 3.0 性能测试报告',
      '潮汐协议 3.0 发布说明',
      '从潮汐协议 2.x 迁移到 3.0',
      '潮汐云托管 价格',
      '很长的文章',
    ]);
  });
});
