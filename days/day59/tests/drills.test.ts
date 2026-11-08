import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { runLoop } = await loadTarget<typeof import('../solution/drills/agent-loop.ts')>(import.meta.url, 'drills/agent-loop.ts');
const { createSSEParser } = await loadTarget<typeof import('../solution/drills/sse.ts')>(import.meta.url, 'drills/sse.ts');
const { mapLimit } = await loadTarget<typeof import('../solution/drills/map-limit.ts')>(import.meta.url, 'drills/map-limit.ts');
const { retry } = await loadTarget<typeof import('../solution/drills/retry.ts')>(import.meta.url, 'drills/retry.ts');
const { trimHistory } = await loadTarget<typeof import('../solution/drills/trim-history.ts')>(import.meta.url, 'drills/trim-history.ts');

type Msg = import('../solution/drills/agent-loop.ts').Msg;
type Reply = import('../solution/drills/agent-loop.ts').Reply;
/** 按顺序返回脚本里的回复，记下每次收到的消息 */
const scripted = (replies: Reply[]) => {
  const seen: Msg[][] = [];
  return { seen, chat: async (messages: Msg[]) => (seen.push(structuredClone(messages)), replies.shift() ?? { content: '脚本用完了' }) };
};

describe('第 59 天：Agent 循环', () => {
  test('工具并行执行，结果按调用的顺序交回；出错、叫错名字、参数坏了都是结果', async () => {
    const order: string[] = [];
    const { chat, seen } = scripted([
      {
        content: null,
        tool_calls: [
          { id: 'c1', name: 'slow', arguments: '{"x":1}' },
          { id: 'c2', name: 'fast', arguments: '{}' },
          { id: 'c3', name: 'boom', arguments: '{}' },
          { id: 'c4', name: 'nope', arguments: '{}' },
          { id: 'c5', name: 'fast', arguments: '{oops' },
        ],
      },
      { content: '好了' },
    ]);
    const tools = {
      slow: async ({ x }: { x: number }) => (await new Promise((r) => setTimeout(r, 30)), order.push('slow'), { x }),
      fast: () => (order.push('fast'), 'quick'),
      boom: () => {
        throw new Error('坏了');
      },
    };
    const r = await runLoop('问题', { chat, tools, system: '你是助手' });
    expect(r).toMatchObject({ status: 'completed', answer: '好了', steps: 2 });
    expect(order, '并行：fast 先做完').toEqual(['fast', 'slow']);
    expect(seen[0]).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '问题' },
    ]);
    expect(seen[1].slice(3).map((m) => (m.role === 'tool' ? [m.tool_call_id, m.content] : m.role))).toEqual([
      ['c1', '{"x":1}'],
      ['c2', 'quick'],
      ['c3', '出错：坏了'],
      ['c4', '没有工具 nope，可用的：slow、fast、boom'],
      ['c5', '参数不是合法的 JSON：{oops'],
    ]);
    expect(seen[1][2]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }, { id: 'c5' }] });
  });

  test('最大步数；没有 system', async () => {
    const loop = { content: null, tool_calls: [{ id: 'c', name: 't', arguments: '{}' }] };
    const { chat, seen } = scripted([loop, loop, loop, loop]);
    const r = await runLoop('q', { chat, tools: { t: () => 'ok' }, maxSteps: 3 });
    expect(r).toMatchObject({ status: 'max_steps', answer: '', steps: 3 });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual([{ role: 'user', content: 'q' }]);
  });
});

describe('第 59 天：SSE 解析器', () => {
  test('在任何地方断开都能拼回来', () => {
    const text = ': ping\r\nevent: delta\r\ndata: {"a":1}\r\n\r\ndata:第一行\ndata: 第二行\nid: 7\n\ndata: [DONE]\n\n';
    for (let size = 1; size <= text.length; size++) {
      const p = createSSEParser();
      const events = [];
      for (let i = 0; i < text.length; i += size) events.push(...p.push(text.slice(i, i + size)));
      expect(events, `每块 ${size} 个字符`).toEqual([{ event: 'delta', data: '{"a":1}' }, { data: '第一行\n第二行' }, { data: '[DONE]' }]);
    }
  });

  test('没有 data 的事件不交出；没结束的留到下一块', () => {
    const p = createSSEParser();
    expect(p.push('event: x\n\n')).toEqual([]);
    expect(p.push('data: half')).toEqual([]);
    expect(p.push('\n\n')).toEqual([{ data: 'half' }]);
  });
});

describe('第 59 天：有并发上限的 map', () => {
  test('同时最多 limit 个；结果按输入的顺序', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
    await expect(mapLimit([1], 0, async () => 1)).rejects.toThrow('正整数');
  });

  test('一个失败就整体失败，不再开始新的', async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 5));
        if (n === 2) throw new Error('第 2 个坏了');
        return n;
      }),
    ).rejects.toThrow('第 2 个坏了');
    await new Promise((r) => setTimeout(r, 30));
    expect(started.length).toBeLessThanOrEqual(3);
  });
});

describe('第 59 天：重试', () => {
  test('指数退避加抖动；Retry-After 优先；次数用完抛最后的错', async () => {
    const waits: number[] = [];
    let calls = 0;
    const err = (msg: string, extra = {}) => Object.assign(new Error(msg), extra);
    await expect(
      retry(
        async (attempt) => {
          calls++;
          throw attempt === 1 ? err('限流', { retryAfterMs: 1500 }) : err(`第 ${attempt} 次`);
        },
        { retries: 3, baseMs: 100, maxMs: 1000, random: () => 0.5, sleep: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toThrow('第 3 次');
    expect(calls).toBe(4);
    expect(waits).toEqual([50, 1000, 200]);
  });

  test('成功就返回；不该重试的马上抛', async () => {
    let n = 0;
    expect(await retry(async () => (++n < 3 ? Promise.reject(new Error('x')) : 'ok'), { sleep: async () => {} })).toBe('ok');
    let m = 0;
    await expect(retry(async () => (m++, Promise.reject(new Error('400'))), { isRetryable: () => false, sleep: async () => {} })).rejects.toThrow('400');
    expect(m).toBe(1);
  });
});

describe('第 59 天：裁剪历史', () => {
  const count = (m: Msg) => (m.content ?? '').length;
  const history: Msg[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'aaaa' },
    { role: 'assistant', content: 'bb', tool_calls: [{ id: 'c', name: 't', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'c', content: 'ccccc' },
    { role: 'assistant', content: 'dd' },
    { role: 'user', content: 'eee' },
  ];

  test('留 system 和最新的；不留没有调用的工具结果', () => {
    expect(trimHistory(history, 100, count)).toEqual(history);
    expect(trimHistory(history, 13, count).map((m) => m.content), '3 + 3 + 2 + 5 = 13：工具结果留下了，但它的调用被裁了，也要去掉').toEqual(['sys', 'dd', 'eee']);
    expect(trimHistory(history, 15, count).map((m) => m.content)).toEqual(['sys', 'bb', 'ccccc', 'dd', 'eee']);
    expect(trimHistory(history, 4, count).map((m) => m.content), '最新的一条超了也不留').toEqual(['sys']);
  });
});
