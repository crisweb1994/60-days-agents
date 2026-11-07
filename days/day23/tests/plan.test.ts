import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const { createPlanBoard, createPlanTool, formatPlan, validatePlan, MAX_PLAN_STEPS } = await loadTarget<typeof import('../solution/plan.ts')>(
  import.meta.url,
  'plan.ts',
);
const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');

type Step = Parameters<typeof formatPlan>[0][number];
const step = (content: string, status: Step['status'] = 'pending', note?: string): Step => ({ content, status, ...(note ? { note } : {}) });
const call = (args: object) => ({ id: 'call_1', type: 'function' as const, function: { name: 'update_plan', arguments: JSON.stringify(args) } });

describe('第 23 天：检查计划（TODO 1）', () => {
  test('合格的计划没有问题', () => {
    expect(validatePlan([step('搜索', 'completed'), step('读网页', 'in_progress'), step('查文档')])).toEqual([]);
  });

  test('空计划、太长的计划', () => {
    expect(validatePlan([])).toEqual(['计划里至少要有 1 步']);
    const long = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => step(`第 ${i + 1} 步`));
    expect(validatePlan(long)).toEqual([`计划最多 ${MAX_PLAN_STEPS} 步，现在有 ${MAX_PLAN_STEPS + 1} 步。把相近的步骤合并`]);
  });

  test('没写内容的步骤、没写原因的失败、同时进行好几步', () => {
    expect(validatePlan([step('  '), step('查价格', 'failed'), step('a', 'in_progress'), step('b', 'in_progress')])).toEqual([
      '第 1 步没有写要做什么',
      '第 2 步失败了，要在 note 里写明原因',
      '同时只能有一步在进行，现在有 2 步是 in_progress',
    ]);
  });
});

describe('第 23 天：显示计划（TODO 2）', () => {
  test('每一步一个标记，失败的写上原因，最后是进度', () => {
    const plan = [step('搜索发布说明', 'completed'), step('打开性能测试报告', 'in_progress'), step('查官方定价', 'failed', '网页打不开'), step('查迁移指南')];
    expect(formatPlan(plan)).toBe('[x] 搜索发布说明\n[>] 打开性能测试报告\n[!] 查官方定价（网页打不开）\n[ ] 查迁移指南\n进度：1/4');
  });
});

describe('第 23 天：计划工具 update_plan（TODO 3）', () => {
  test('更新计划，返回整份计划和下一步', async () => {
    const changes: Step[][] = [];
    const board = createPlanBoard((steps) => changes.push(steps));
    const tool = createPlanTool(board);
    const result = await runToolCall([tool], call({ steps: [step('搜索', 'completed'), step('读网页', 'in_progress'), step('汇总')] }));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('计划已更新：\n[x] 搜索\n[>] 读网页\n[ ] 汇总\n进度：1/3\n接下来：读网页');
    expect(board.steps.map((s) => s.status)).toEqual(['completed', 'in_progress', 'pending']);
    expect(changes).toHaveLength(1);
  });

  test('没有在进行的步骤时，下一步是第一个 pending；都做完了，提示写回答', async () => {
    const tool = createPlanTool(createPlanBoard());
    const next = await runToolCall([tool], call({ steps: [step('搜索', 'completed'), step('读网页')] }));
    expect(next.content.endsWith('接下来：读网页')).toBe(true);
    const finished = await runToolCall([tool], call({ steps: [step('搜索', 'completed')] }));
    expect(finished.content.endsWith('计划里的步骤都处理完了，可以写最终的回答了。')).toBe(true);
  });

  test('有失败的步骤、又没有剩下的步骤：提醒它加上替代的办法，或者说明没查到', async () => {
    const tool = createPlanTool(createPlanBoard());
    const result = await runToolCall([tool], call({ steps: [step('搜索', 'completed'), step('查定价', 'failed', '网页打不开')] }));
    expect(result.content).toContain('[!] 查定价（网页打不开）');
    expect(result.content).toContain('加上替代的步骤');
  });

  test('计划不合格：返回错误，说明问题，计划保持原样', async () => {
    const board = createPlanBoard();
    board.update([step('原来的计划')]);
    const tool = createPlanTool(board);
    const result = await runToolCall([tool], call({ steps: [step('a', 'in_progress'), step('b', 'failed')] }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('计划没有更新');
    expect(result.content).toContain('第 2 步失败了，要在 note 里写明原因');
    expect(board.steps.map((s) => s.content)).toEqual(['原来的计划']);
  });

  test('状态写错了：参数校验会列出可选的值', async () => {
    const result = await runToolCall([createPlanTool(createPlanBoard())], call({ steps: [{ content: '搜索', status: 'done' }] }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('in_progress');
  });
});
