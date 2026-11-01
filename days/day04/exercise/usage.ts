// token 用量和花费。各家返回的 usage 字段不完全一样，先统一成 Usage，再算钱。

export interface Usage {
  /** 输入 token，包括命中缓存的部分 */
  inputTokens: number;
  /** 输入里命中缓存的部分，按更低的单价计费 */
  cachedTokens: number;
  /** 输出 token，包括思考的部分 */
  outputTokens: number;
  /** 输出里思考的部分，按输出单价计费 */
  reasoningTokens: number;
}

/** 接口返回的 usage。字段名以 OpenAI 为准，再加上几家自己的写法 */
export type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  /** DeepSeek：命中缓存的输入 token */
  prompt_cache_hit_tokens?: number;
  /** Kimi 的文档里也写了这个顶层字段 */
  cached_tokens?: number;
};

/** 单价，单位是元/百万 token */
export interface Price {
  input: number;
  /** 命中缓存的输入的单价。不填就按 input 算 */
  cachedInput?: number;
  output: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** 把接口返回的 usage 统一成 Usage。没有 usage 时全部算 0 */
export function parseUsage(raw: RawUsage | null | undefined): Usage {
  return {
    inputTokens: raw?.prompt_tokens ?? 0,
    cachedTokens: raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens ?? raw?.cached_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? 0,
    reasoningTokens: raw?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** 算出这些用量花了多少元 */
export function calcCost(usage: Usage, price: Price): number {
  const uncached = usage.inputTokens - usage.cachedTokens;
  const cachedPrice = price.cachedInput ?? price.input;
  return (uncached * price.input + usage.cachedTokens * cachedPrice + usage.outputTokens * price.output) / 1_000_000;
}

/**
 * 读取 .env 里的单价。格式是「输入,缓存命中的输入,输出」，单位是元/百万 token，比如 2,0.2,8；
 * 没有缓存价时也可以只写「输入,输出」。没填就返回 undefined
 */
export function parsePrice(text: string | undefined): Price | undefined {
  if (!text?.trim()) return undefined;
  const numbers = text.split(',').map((part) => Number(part.trim()));
  if (![2, 3].includes(numbers.length) || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`单价的格式是「输入,缓存命中的输入,输出」（元/百万 token），比如 2,0.2,8。现在填的是：${text}`);
  }
  if (numbers.length === 2) return { input: numbers[0], output: numbers[1] };
  return { input: numbers[0], cachedInput: numbers[1], output: numbers[2] };
}

/** 比如：输入 812 tokens（缓存命中 512） · 输出 96 tokens（思考 40） · 0.0015 元（单价 2,0.2,8 时） */
export function formatUsage(usage: Usage, price?: Price): string {
  let input = `输入 ${usage.inputTokens} tokens`;
  if (usage.cachedTokens) input += `（缓存命中 ${usage.cachedTokens}）`;
  let output = `输出 ${usage.outputTokens} tokens`;
  if (usage.reasoningTokens) output += `（思考 ${usage.reasoningTokens}）`;
  const parts = [input, output];
  if (price) parts.push(formatCost(calcCost(usage, price)));
  return parts.join(' · ');
}

function formatCost(cost: number): string {
  if (cost === 0) return '0 元';
  if (cost < 0.0001) return '不到 0.0001 元';
  return `${cost.toFixed(4)} 元`;
}
