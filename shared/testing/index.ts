// 每一天的测试共用的工具。测试文件里这样引入：import { setupModel, loadTarget } from '#testing'
import { afterAll, beforeEach, describe } from 'vitest';
import { startMockLLM, type MockLLM } from '../mock-llm/index.ts';

export type { ChatMessage, ChatRequest, MockFailure, MockLLM, MockReply } from '../mock-llm/index.ts';

/** mock：用本地 mock 模型离线测试；e2e：调用 .env 里配置的真实模型 */
export const mode: 'mock' | 'e2e' = process.env.CHECK_MODE === 'e2e' ? 'e2e' : 'mock';

/** 测的是学员的练习（exercise）还是参考答案（solution） */
export const target: 'exercise' | 'solution' = process.env.CHECK_TARGET === 'solution' ? 'solution' : 'exercise';

/** 只在 mock 模式下跑。模型的输出由脚本决定，断言可以精确到每一条消息 */
export const describeMock = describe.runIf(mode === 'mock');

/** 只在 e2e 模式下跑。真实模型的输出不固定，只断言关键结果 */
export const describeE2E = describe.runIf(mode === 'e2e');

/**
 * 启动 mock 模型服务器。mock 模式下把 OPENAI_* 环境变量指向它；e2e 模式下保留 .env 里的真实配置。
 * 要在 loadTarget 之前调用，这样被测代码在 import 时读到的就已经是正确的配置。
 */
export async function setupModel(): Promise<MockLLM> {
  const llm = await startMockLLM();
  if (mode === 'mock') {
    process.env.OPENAI_BASE_URL = llm.baseURL;
    process.env.OPENAI_API_KEY = 'mock-key';
    process.env.OPENAI_MODEL = 'mock-model';
  }
  beforeEach(() => llm.reset());
  afterAll(() => llm.close());
  return llm;
}

/**
 * 按 CHECK_TARGET 加载当天 exercise/ 或 solution/ 里的同名模块，类型从 solution 取：
 * const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
 */
export async function loadTarget<T>(testFileUrl: string, file: string): Promise<T> {
  return (await import(/* @vite-ignore */ new URL(`../${target}/${file}`, testFileUrl).href)) as T;
}
