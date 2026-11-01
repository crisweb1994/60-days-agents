import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { ChatRequest, ChatResult, Model } from '../solution/types.ts';

const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

describe('第 7 天：依赖注入（TODO 1）', () => {
  test('runAgent 用调用方传进来的模型，不自己创建', async () => {
    const received: ChatRequest[] = [];
    // 一个最简单的假模型：不联网，直接回一句话。这个测试里没有配置 OPENAI_* 环境变量
    const model: Model = {
      name: 'fake',
      async chat(request): Promise<ChatResult> {
        received.push(structuredClone(request)); // 存副本：Agent 之后还会往 messages 里追加内容
        return {
          message: { role: 'assistant', content: '我是假模型' },
          finishReason: 'stop',
          usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        };
      },
    };
    const workspace = await mkdtemp(join(tmpdir(), 'day07-di-'));
    const outcome = await runAgent('你好', { model, tools: createTools(workspace) }).catch((error: Error) => error);

    expect(
      outcome instanceof Error ? `报错了：${outcome.message}` : outcome.answer,
      '要调用 options.model.chat()，而不是在 runAgent 里自己创建模型',
    ).toBe('我是假模型');
    expect(received).toHaveLength(1);
    expect(received[0].messages.at(-1)).toEqual({ role: 'user', content: '你好' });
  });
});
