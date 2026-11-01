import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { parseUsage, calcCost } = await loadTarget<typeof import('../solution/usage.ts')>(import.meta.url, 'usage.ts');

describe('第 2 天：解析 usage（TODO 4）', () => {
  test('OpenAI 的写法：缓存在 prompt_tokens_details，思考在 completion_tokens_details', () => {
    const usage = parseUsage({
      prompt_tokens: 1200,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 1024 },
      completion_tokens_details: { reasoning_tokens: 180 },
    });
    expect(usage).toEqual({ inputTokens: 1200, cachedTokens: 1024, outputTokens: 300, reasoningTokens: 180 });
  });

  test('DeepSeek 的写法：缓存命中在 prompt_cache_hit_tokens', () => {
    const usage = parseUsage({
      prompt_tokens: 800,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 640,
      prompt_cache_miss_tokens: 160,
    } as Parameters<typeof parseUsage>[0]);
    expect(usage).toEqual({ inputTokens: 800, cachedTokens: 640, outputTokens: 50, reasoningTokens: 0 });
  });

  test('没有的字段算 0；接口没返回 usage 时全部算 0', () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({
      inputTokens: 10,
      cachedTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
    });
    expect(parseUsage(undefined)).toEqual({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  });
});

describe('第 2 天：计算花费（TODO 5）', () => {
  test('未命中缓存的输入、命中缓存的输入、输出，分别按各自的单价计费', () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 500_000, reasoningTokens: 200_000 };
    // 60 万 × 2 元 + 40 万 × 0.5 元 + 50 万 × 8 元，单价按百万 token 计
    expect(calcCost(usage, { input: 2, cachedInput: 0.5, output: 8 })).toBeCloseTo(5.4);
  });

  test('没有缓存价时，命中缓存的输入也按输入单价算', () => {
    const usage = { inputTokens: 3000, cachedTokens: 1000, outputTokens: 1000, reasoningTokens: 0 };
    expect(calcCost(usage, { input: 4, output: 16 })).toBeCloseTo((3000 * 4 + 1000 * 16) / 1_000_000);
  });
});
