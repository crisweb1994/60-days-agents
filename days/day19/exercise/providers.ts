// 按协议创建模型。只有程序的入口用它，其他代码都只认 Model 接口。
import { createAnthropicModel } from './anthropic.ts';
import { createOpenAIModel } from './openai.ts';
import type { Model } from './types.ts';

export type Provider = 'openai' | 'anthropic';
export const PROVIDERS: Provider[] = ['openai', 'anthropic'];

/** 按协议创建模型，配置从对应的环境变量读取：OPENAI_* 或 ANTHROPIC_* */
export function createModel(provider: Provider): Model {
  return provider === 'anthropic' ? createAnthropicModel() : createOpenAIModel();
}

/** 从环境变量 MODEL_PROVIDER 读取用哪种协议，默认 openai */
export function providerFromEnv(): Provider {
  const value = process.env.MODEL_PROVIDER || 'openai';
  if (!PROVIDERS.includes(value as Provider)) {
    throw new Error(`MODEL_PROVIDER 只能是 ${PROVIDERS.join(' 或 ')}，现在是 ${value}`);
  }
  return value as Provider;
}
