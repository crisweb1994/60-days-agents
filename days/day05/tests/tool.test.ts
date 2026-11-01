import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { loadTarget } from '#testing';

const { defineTool, toToolDefinition, runToolCall, runToolCalls } = await loadTarget<
  typeof import('../solution/tool.ts')
>(import.meta.url, 'tool.ts');
const { calculator } = await loadTarget<typeof import('../solution/tools/calculator.ts')>(
  import.meta.url,
  'tools/calculator.ts',
);

let nextId = 1;
const call = (name: string, args: unknown) => ({
  id: `call_${nextId++}`,
  type: 'function' as const,
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

const weather = defineTool({
  name: 'get_weather',
  description: '查询某个城市现在的天气',
  schema: z.object({
    city: z.string().describe('城市名，比如杭州'),
    unit: z.enum(['celsius', 'fahrenheit']).describe('温度单位'),
  }),
  execute: ({ city, unit }) => ({ city, temperature: unit === 'celsius' ? 21 : 70 }),
});

const broken = defineTool({
  name: 'broken',
  description: '一个总是出错的工具',
  schema: z.object({}),
  execute: () => {
    throw new Error('数据库连接失败');
  },
});

describe('第 5 天：工具定义（TODO 1）', () => {
  test('转成请求里的工具定义：名称、描述，以及由 zod schema 转换出的参数', () => {
    expect(toToolDefinition(weather)).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询某个城市现在的天气',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名，比如杭州' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: '温度单位' },
          },
          required: ['city', 'unit'],
          additionalProperties: false,
        },
      },
    });
  });
});

describe('第 5 天：执行工具调用（TODO 2）', () => {
  test('执行成功：字符串原样返回，其他值转成 JSON', async () => {
    expect(await runToolCall([calculator], call('calculator', { expression: '1 + 2 * 3' }))).toEqual({
      content: '7',
      isError: false,
    });
    const result = await runToolCall([weather], call('get_weather', { city: '杭州', unit: 'celsius' }));
    expect(result).toEqual({ content: '{"city":"杭州","temperature":21}', isError: false });
  });

  test('模型调用了不存在的工具：返回错误，并列出可用的工具', async () => {
    const result = await runToolCall([calculator, weather], call('search_web', { q: '天气' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('search_web');
    expect(result.content, '告诉模型有哪些工具可用，它才能改正').toContain('get_weather');
  });

  test('参数不是合法的 JSON：返回错误，不要抛出', async () => {
    const result = await runToolCall([weather], call('get_weather', '{"city": "杭州"'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('JSON');
  });

  test('参数不符合 schema：执行之前就拦下来，告诉模型哪个字段不对', async () => {
    let executed = false;
    const spy = defineTool({ ...weather, execute: () => (executed = true) });
    const result = await runToolCall([spy], call('get_weather', { city: '杭州', unit: 'kelvin' }));
    expect(result.isError).toBe(true);
    expect(result.content, '用 z.prettifyError 说明哪个字段错了').toContain('unit');
    expect(executed, '参数不合法时，不能执行工具').toBe(false);
  });

  test('工具执行时抛出错误：转成错误结果交回模型', async () => {
    expect(await runToolCall([broken], call('broken', {}))).toEqual({
      content: expect.stringContaining('数据库连接失败'),
      isError: true,
    });
    const result = await runToolCall([calculator], call('calculator', { expression: '1 / 0' }));
    expect(result.isError).toBe(true);
  });

  test('没有参数的工具，arguments 可能是空字符串', async () => {
    const ping = defineTool({ name: 'ping', description: '测试连通性', schema: z.object({}), execute: () => 'pong' });
    expect(await runToolCall([ping], call('ping', ''))).toEqual({ content: 'pong', isError: false });
  });
});

describe('第 5 天：并行执行（TODO 3）', () => {
  test('同一轮的工具调用并行执行，结果按调用的顺序返回', async () => {
    const slow = defineTool({
      name: 'slow',
      description: '等一会儿再返回',
      schema: z.object({ ms: z.number(), label: z.string() }),
      execute: async ({ ms, label }) => {
        await sleep(ms);
        return label;
      },
    });
    const started = performance.now();
    const results = await runToolCalls(
      [slow],
      [call('slow', { ms: 150, label: '第一个' }), call('slow', { ms: 50, label: '第二个' }), call('slow', { ms: 100, label: '第三个' })],
    );
    const elapsed = performance.now() - started;

    expect(results.map((r) => r.content), '结果的顺序要和调用的顺序一致').toEqual(['第一个', '第二个', '第三个']);
    expect(elapsed, '三个调用要同时执行，总耗时接近最慢的那个，而不是三个加起来').toBeLessThan(270);
  });

  test('其中一个出错，不影响其他调用', async () => {
    const results = await runToolCalls([calculator, broken], [call('broken', {}), call('calculator', { expression: '2^10' })]);
    expect(results.map((r) => r.isError)).toEqual([true, false]);
    expect(results[1].content).toBe('1024');
  });
});
