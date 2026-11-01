import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');
const { createModel, PROVIDERS } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day08-'));
});

/** 这个协议的请求记录在哪：OpenAI 兼容接口和 Anthropic 协议分开记 */
const requestsOf = (provider: string) => (provider === 'anthropic' ? llm.anthropicRequests : llm.requests);

// 同一个 Agent、同一份脚本，在两种协议上跑同一组测试
describe.each(PROVIDERS)('第 8 天：同一个 Agent 跑在 %s 协议上', (provider) => {
  describeMock('mock 模型', () => {
    test('调用工具、拿到结果、给出回答', async () => {
      llm
        .reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '(1234 + 5678) * 9' } }] })
        .reply({ content: '结果是 62208。' });
      const result = await runAgent('(1234 + 5678) * 9 等于多少？', { model: createModel(provider), tools: createTools(workspace) });
      expect(result).toMatchObject({ status: 'completed', answer: '结果是 62208。', steps: 2 });
      expect(requestsOf(provider), `请求应该发到 ${provider} 协议的接口`).toHaveLength(2);
      // 历史始终是我们自己的格式，和用哪种协议无关
      expect(result.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    });

    test('一轮里的两个工具调用，结果都交回模型', async () => {
      llm
        .reply({
          toolCalls: [
            { name: 'calculator', arguments: { expression: '1 + 1' } },
            { name: 'calculator', arguments: { expression: '2 + 2' } },
          ],
        })
        .reply({ content: '2 和 4。' });
      const result = await runAgent('算 1+1 和 2+2', { model: createModel(provider), tools: createTools(workspace) });
      expect(result.status).toBe('completed');
      expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['2', '4']);
    });

    test('带思考的工具调用：思考内容按各自协议的规则传回去', async () => {
      llm
        .reply({ reasoning: '需要用计算器', toolCalls: [{ name: 'calculator', arguments: { expression: '6 * 7' } }] })
        .reply({ content: '42。' });
      const result = await runAgent('6 乘 7 是多少？', { model: createModel(provider), tools: createTools(workspace) });
      // Anthropic 协议下，mock 会检查 thinking 块（含签名）有没有原样传回，没有就返回 400
      expect(result.status).toBe('completed');
      expect(result.messages[2]).toMatchObject({ role: 'assistant', reasoning_content: '需要用计算器' });
    });

    test('输出被截断、被拒绝回答：两种协议得到同样的 status', async () => {
      llm.reply({ content: '写到一半', finishReason: 'length' }).reply({ content: '', finishReason: 'content_filter' });
      expect((await runAgent('写长文', { model: createModel(provider), tools: createTools(workspace) })).status).toBe('truncated');
      expect((await runAgent('……', { model: createModel(provider), tools: createTools(workspace) })).status).toBe('blocked');
    });
  });

  describeE2E('真实模型', () => {
    test('用计算器算出准确的结果', async () => {
      const result = await runAgent('1234 * 5678 + 91011 等于多少？', { model: createModel(provider), tools: createTools(workspace) });
      expect(result.status).toBe('completed');
      expect(result.answer.replace(/[,，\s]/g, ''), '答案是 7097663').toContain('7097663');
    });

    test('写入文件再读出来', async () => {
      const result = await runAgent('在 notes/todo.txt 里写一行「买牛奶」，然后读出来确认一下', {
        model: createModel(provider),
        tools: createTools(workspace),
      });
      expect(result.status).toBe('completed');
    });
  });
});
