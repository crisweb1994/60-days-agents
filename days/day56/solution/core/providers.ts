// 毕业项目的模型入口：从研究助手的 providers.ts 精简而来，只留两种协议和重试。
// 配置从环境变量读：MODEL_PROVIDER（openai 或 anthropic，默认 openai），以及 OPENAI_* 或 ANTHROPIC_*
import { createAnthropicModel } from './anthropic.ts';
import { createOpenAIModel } from './openai.ts';
import { withRetry } from './retry.ts';
import type { Model } from './types.ts';

export type Provider = 'openai' | 'anthropic';

export function createModel(provider: Provider = providerFromEnv()): Model {
  return provider === 'anthropic' ? createAnthropicModel() : createOpenAIModel();
}

/** 带重试的模型（第 9 天）：限流、过载、超时自动重试 */
export function createReliableModel(provider: Provider = providerFromEnv()): Model {
  return withRetry(createModel(provider));
}

export function providerFromEnv(): Provider {
  const value = process.env.MODEL_PROVIDER || 'openai';
  if (value !== 'openai' && value !== 'anthropic') throw new Error(`MODEL_PROVIDER 只能是 openai 或 anthropic，现在是 ${value}`);
  return value;
}
