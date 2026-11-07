// 按协议创建模型。只有程序的入口用它，其他代码都只认 Model 接口。
import { createAnthropicModel } from './anthropic.ts';
import { createOpenAIModel, openAIConfigFromEnv } from './openai.ts';
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

/**
 * 第 22 天：便宜的模型，用来做分类、回答简单的问题。和 OPENAI_* 用同一个服务，只是模型名换成 CHEAP_MODEL；
 * 没填就用 OPENAI_MODEL
 */
export function createCheapModel(): Model {
  const config = openAIConfigFromEnv();
  return createOpenAIModel({ ...config, model: process.env.CHEAP_MODEL || config.model });
}

/**
 * 第 33 天：第二家模型，用来横评。配置在 ALT_*：ALT_BASE_URL、ALT_API_KEY、ALT_MODEL，都是 OpenAI 兼容接口。
 * 没有配置 ALT_MODEL 时返回 undefined
 */
export function createAltModel(): Model | undefined {
  const { ALT_BASE_URL, ALT_API_KEY, ALT_MODEL } = process.env;
  if (!ALT_MODEL) return undefined;
  const config = openAIConfigFromEnv();
  return createOpenAIModel({ baseURL: ALT_BASE_URL || config.baseURL, apiKey: ALT_API_KEY || config.apiKey, model: ALT_MODEL });
}
