import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

const llm = await setupModel();
const common = await loadTarget<typeof import('../solution/frameworks/common.ts')>(import.meta.url, 'frameworks/common.ts');
const ai = await loadTarget<typeof import('../solution/frameworks/ai-sdk.ts')>(import.meta.url, 'frameworks/ai-sdk.ts');
const oa = await loadTarget<typeof import('../solution/frameworks/openai-agents.ts')>(import.meta.url, 'frameworks/openai-agents.ts');
const { compareFrameworks, summarizeComparison, formatComparison } = await loadTarget<typeof import('../solution/frameworks/compare.ts')>(import.meta.url, 'frameworks/compare.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');
const { createOpenAIModel } = await loadTarget<typeof import('../solution/openai.ts')>(import.meta.url, 'openai.ts');

const workspace = () => mkdtemp(join(tmpdir(), 'day41-'));
/** 三种实现，同一个模型服务 */
const runners = () => ({
  handwritten: common.handwrittenRunner(createOpenAIModel()),
  'ai-sdk': ai.aiSdkRunner(ai.createAISDKModel()),
  'openai-agents': oa.agentsSdkRunner(oa.createAgentsModel()),
});
type Name = keyof ReturnType<typeof runners>;
const NAMES: Name[] = ['handwritten', 'ai-sdk', 'openai-agents'];

describe('第 41 天：转换（TODO 1、3）', () => {
  test('fromAISDKUsage：缓存和思考的 token 在 details 里，没有就是 0', () => {
    expect(ai.fromAISDKUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, inputTokenDetails: { cacheReadTokens: 60, noCacheTokens: 40, cacheWriteTokens: undefined }, outputTokenDetails: { reasoningTokens: 5, textTokens: 15 } })).toEqual({
      inputTokens: 100,
      cachedTokens: 60,
      outputTokens: 20,
      reasoningTokens: 5,
    });
    expect(ai.fromAISDKUsage({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined }, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined } })).toEqual({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  });

  test('toAISDKTools 和 toAgentsTools：名字、描述都在；写文件要审批', async () => {
    const tools = createTools(await workspace());
    const set = ai.toAISDKTools(tools);
    expect(Object.keys(set)).toEqual(tools.map((t) => t.name));
    expect(set.calculator.description).toBe(tools[0].description);
    expect(set.write_file.needsApproval, 'requiresApproval 对应 needsApproval').toBe(true);
    expect(set.calculator.needsApproval).toBe(false);
    const agentTools = oa.toAgentsTools(tools);
    expect(agentTools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(agentTools.every((t) => t.strict === false), '国产模型多半不支持 strict 的工具参数').toBe(true);
  });
});

describeMock('第 41 天：三种实现跑同一个任务（TODO 2、4）', () => {
  test.each(NAMES)('%s：调用计算器，再回答', async (name) => {
    llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: '(17 + 25) * 3' } }] }).reply({ content: '结果是 126。' }).reply({ content: '多余的一轮' });
    const r = await runners()[name]({ question: '算一下 (17 + 25) * 3', tools: createTools(await workspace()) });
    expect(r).toMatchObject({ status: 'completed', answer: '结果是 126。', steps: 2, toolCalls: [{ name: 'calculator', arguments: { expression: '(17 + 25) * 3' } }] });
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(llm.requests).toHaveLength(2);
    const toolMessage = llm.requests[1].messages.at(-1)!;
    expect(toolMessage, '工具的结果交回了模型').toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(String(toolMessage.content)).toContain('126');
    expect(llm.requests[0].tools!.map((t) => t.function.name)).toContain('write_file');
  });

  test.each(NAMES)('%s：写文件要确认，同意了才写', async (name) => {
    const dir = await workspace();
    const asked: string[] = [];
    llm.reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'hello' } }] }).reply({ content: '写好了。' });
    const r = await runners()[name]({ question: '写个文件', tools: createTools(dir), confirm: async ({ tool }) => (asked.push(tool), true) });
    expect(asked).toEqual(['write_file']);
    expect(r.status).toBe('completed');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello');
  });

  test.each(NAMES)('%s：不同意就不写，模型知道被拒绝了', async (name) => {
    const dir = await workspace();
    llm.reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'hello' } }] }).reply({ content: '好的，不写了。' });
    const r = await runners()[name]({ question: '写个文件', tools: createTools(dir), confirm: async () => false });
    expect(r.answer).toBe('好的，不写了。');
    await expect(readFile(join(dir, 'a.txt'), 'utf8')).rejects.toThrow();
    expect(llm.requests[1].messages.at(-1), '被拒绝也要有一条工具结果').toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  test.each(NAMES)('%s：步数用完了是 max_steps', async (name) => {
    for (let i = 0; i < 4; i++) llm.reply({ toolCalls: [{ name: 'calculator', arguments: { expression: `${i} + 1` } }] });
    const r = await runners()[name]({ question: '一直算', tools: createTools(await workspace()), maxSteps: 3 });
    expect(r.status).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);
  });
});

describe('第 41 天：比较（TODO 5）', () => {
  test('每个任务每种实现跑一次；出错记下来；按 expect 判断对错', async () => {
    let t = 0;
    const fake = (answer: string, steps: number) => async () => ({ framework: 'x', status: 'completed', answer, steps, toolCalls: [], usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, reasoningTokens: 0 } });
    const seen: string[] = [];
    const rows = await compareFrameworks(
      [
        { id: 'a', question: 'Q1', expect: '126' },
        { id: 'b', question: 'Q2' },
      ],
      {
        good: async (input) => (seen.push(`good:${input.question}:${input.tools.length}`), fake('结果是 126', 2)()),
        bad: async () => {
          throw new Error('接口不兼容');
        },
      },
      { tools: () => [], clock: () => (t += 100) },
    );
    expect(rows.map((r) => [r.task, r.framework, r.ok, r.error ?? ''])).toEqual([
      ['a', 'good', true, ''],
      ['a', 'bad', false, '接口不兼容'],
      ['b', 'good', true, ''],
      ['b', 'bad', false, '接口不兼容'],
    ]);
    expect(rows.every((r) => r.ms === 100)).toBe(true);
    expect(seen).toEqual(['good:Q1:0', 'good:Q2:0']);
    const summary = summarizeComparison(rows);
    expect(summary.map((s) => [s.framework, s.passed, s.total, s.avgSteps])).toEqual([
      ['good', 2, 2, 2],
      ['bad', 0, 2, 0],
    ]);
    expect(formatComparison(summary)).toContain('| good | 2/2 |');
  });
});

describeE2E('第 41 天：真实模型', () => {
  test.each(NAMES)('%s：用计算器算出结果', { timeout: 120_000 }, async (name) => {
    const r = await runners()[name]({ question: '用计算器算 1234 * 5678，只回答结果', tools: createTools(await workspace()) });
    console.log(name, r.answer, r.steps);
    expect(r.toolCalls.map((c) => c.name)).toContain('calculator');
    expect(r.answer.replace(/[,，\s]/g, '')).toContain('7006652');
  });
});
