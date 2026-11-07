import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const d = await loadTarget<typeof import('../solution/deep-research.ts')>(import.meta.url, 'deep-research.ts');
const { parsePlan, applyReview, formatFindingsForReport, deepResearch, saveReport, DEEP_PLAN_PROMPT, REPORT_PROMPT, MAX_SUBQUESTIONS } = d;
const { splitSentences } = await loadTarget<typeof import('../solution/citations.ts')>(import.meta.url, 'citations.ts');
const { SUBAGENT_PROMPT } = await loadTarget<typeof import('../solution/subagent.ts')>(import.meta.url, 'subagent.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

const supported = (quote: string, match: string) => ({ content: JSON.stringify({ verdict: 'supported', quote, reason: '原文写了' }), match: `要核查的句子：${match}` });
const finding = (question: string, findings: string, status = 'completed') => ({ task: { question }, status, findings, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }, steps: 1, toolCalls: 0 }) as any;

test('报告的标题不算句子：标题里的版本号不需要引用', () => {
  expect(splitSentences('# 潮汐协议 3.0 升级评估\n\n## 结论\n延迟 18 毫秒 [1]。')).toEqual(['延迟 18 毫秒 [1]。']);
});

describe('第 30 天：计划（TODO 1）', () => {
  test('parsePlan：合格的计划；解析不了就把问题本身当作唯一的子问题；最多 5 个', () => {
    expect(parsePlan('问题', '{"steps": ["查性能", "查迁移"]}')).toEqual({ question: '问题', subquestions: ['查性能', '查迁移'], fallback: false });
    expect(parsePlan('问题', '我会先查性能')).toEqual({ question: '问题', subquestions: ['问题'], fallback: true });
    expect(parsePlan('问题', '{"steps": []}').fallback).toBe(true);
    const many = JSON.stringify({ steps: Array.from({ length: 8 }, (_, i) => `子问题 ${i}`) });
    expect(parsePlan('问题', many).subquestions).toHaveLength(MAX_SUBQUESTIONS);
  });

  test('applyReview：照着做、改了再做、取消；改完一个都不剩当作取消', () => {
    const plan = { question: '问题', subquestions: ['甲', '乙'], fallback: false };
    expect(applyReview(plan, { action: 'approve' })).toEqual(['甲', '乙']);
    expect(applyReview(plan, { action: 'edit', subquestions: [' 丙 ', '', '丁'] })).toEqual(['丙', '丁']);
    expect(applyReview(plan, { action: 'edit', subquestions: ['  '] })).toBeUndefined();
    expect(applyReview(plan, { action: 'cancel' })).toBeUndefined();
  });

  test('formatFindingsForReport：每个子问题一节，没查完的注明', () => {
    const text = formatFindingsForReport([finding('查性能', '延迟 18 毫秒 [1]。'), finding('查价格', '', 'max_steps')]);
    expect(text).toBe('## 子问题 1：查性能\n延迟 18 毫秒 [1]。\n\n## 子问题 2：查价格（这个子问题没有查完：max_steps）\n（没有结论）');
  });
});

describeMock('第 30 天：深度研究的完整流程（TODO 2、3）', () => {
  test('规划 → 确认 → 两个子 Agent 同时调研 → 写报告 → 核查；编号统一，用量分步统计', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const report = [
      '# 潮汐协议 3.0 升级评估',
      '',
      '## 结论',
      '3.0 的平均延迟是 18 毫秒 [1]，迁移时要把配置项改名为 handshake.attempts [3]。',
      '',
      '## 分析',
      '### 性能',
      '平均延迟是 18 毫秒 [1]。',
      '### 迁移',
      '配置项 handshake.retries 改名为 handshake.attempts [3]。',
      '',
      '## 没有查到的',
      '无',
    ].join('\n');
    llm
      .reply({ content: '{"steps": ["潮汐协议 3.0 的性能比 2.x 提升了多少", "从潮汐协议 2.x 迁移到 3.0 要改什么配置"]}', usage: { prompt_tokens: 100, completion_tokens: 20 } })
      // 子 Agent A 先搜，登记 [1] [2]；子 Agent B 晚一点搜，登记 [3]
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 性能' } }], match: '子问题：潮汐协议 3.0 的性能' })
      .reply({ content: '3.0 的平均延迟是 18 毫秒 [1]。', match: '子问题：潮汐协议 3.0 的性能' })
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐 迁移' } }], match: '子问题：从潮汐协议 2.x 迁移', delayMs: 80 })
      .reply({ toolCalls: [{ name: 'fetch_page', arguments: { url: `${fixture.base}/migration.html` } }], match: '子问题：从潮汐协议 2.x 迁移' })
      .reply({ content: '配置项 handshake.retries 改名为 handshake.attempts [3]。', match: '子问题：从潮汐协议 2.x 迁移' })
      .reply({ content: report, usage: { prompt_tokens: 2000, completion_tokens: 200 } })
      // 核查：三句带引用的话同时核查
      .reply(supported('3.0 的平均延迟是 18 毫秒', '3.0 的平均延迟'))
      .reply(supported('3.0 的平均延迟是 18 毫秒', '平均延迟'))
      .reply(supported('配置项 handshake.retries 改名为 handshake.attempts', '配置项'));

    const events: string[] = [];
    let reviewed: string[] = [];
    const result = await deepResearch('潮汐协议 3.0 值得升级吗？', setup, {
      model: createModel('openai'),
      now: () => new Date(2026, 10, 4),
      review: async (plan) => {
        reviewed = plan.subquestions;
        return { action: 'approve' };
      },
      onEvent: (e) => events.push(e.type),
    });

    expect(llm.requests[0].messages[0].content).toBe(DEEP_PLAN_PROMPT);
    expect(reviewed, '计划先给用户确认').toEqual(['潮汐协议 3.0 的性能比 2.x 提升了多少', '从潮汐协议 2.x 迁移到 3.0 要改什么配置']);
    const subRequests = llm.requests.filter((r) => r.messages[0].content === SUBAGENT_PROMPT);
    expect(subRequests).toHaveLength(5);
    expect(subRequests[0].messages[1].content, '子 Agent 知道这是哪个研究的一部分').toContain('背景：这是研究「潮汐协议 3.0 值得升级吗？」的一部分');
    const reportRequest = llm.requests.find((r) => r.messages[0].content === REPORT_PROMPT)!;
    const reportInput = reportRequest.messages[1].content!;
    expect(reportInput).toContain('今天是 2026-11-04');
    expect(reportInput.indexOf('## 子问题 1'), '结论在前，问题在后').toBeLessThan(reportInput.indexOf('研究的问题：潮汐协议 3.0 值得升级吗？'));
    expect(reportInput).toContain('配置项 handshake.retries 改名为 handshake.attempts [3]。');

    expect(result.status).toBe('completed');
    expect(result.verification?.stopped).toBe('verified');
    expect(result.citations.problems).toEqual([]);
    expect(result.text).toContain(`来源：\n[1] 潮汐协议 3.0 性能测试报告 ${fixture.base}/benchmark.html\n[3] 从潮汐协议 2.x 迁移到 3.0 ${fixture.base}/migration.html`);
    expect(events).toEqual(['plan', 'investigate', 'subagent', 'subagent', 'report', 'verify']);
    expect(result.usage.plan.inputTokens).toBe(100);
    expect(result.usage.report.inputTokens).toBe(2000);
    expect(result.usage.subagents.inputTokens).toBeGreaterThan(0);
    expect(result.usage.verify.inputTokens).toBeGreaterThan(0);
    const { plan, subagents, report: r, verify, total } = result.usage;
    expect(total.inputTokens).toBe(plan.inputTokens + subagents.inputTokens + r.inputTokens + verify.inputTokens);
  });

  test('用户改了计划：按改过的子问题调研；verifyRounds 为 0 时不核查', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '{"steps": ["查性能", "查迁移"]}' }).reply({ content: '专业版每月 499 元。' }).reply({ content: '# 报告\n\n## 结论\n没有查到可靠的来源。' });
    const result = await deepResearch('潮汐云托管多少钱？', setup, {
      model: createModel('openai'),
      verifyRounds: 0,
      review: async () => ({ action: 'edit', subquestions: ['只查专业版的价格'] }),
    });
    expect(result.subquestions).toEqual(['只查专业版的价格']);
    expect(llm.requests[1].messages[1].content).toBe('子问题：只查专业版的价格\n\n背景：这是研究「潮汐云托管多少钱？」的一部分');
    expect(result.verification).toBeUndefined();
    expect(llm.requests).toHaveLength(3);
  });

  test('核查发现报告里的数字不对：改过以后的那一版才是最终的报告', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ content: '{"steps": ["潮汐协议 3.0 的延迟"]}' })
      .reply({ toolCalls: [{ name: 'web_search', arguments: { query: '潮汐协议 3.0 性能' } }] })
      .reply({ content: '平均延迟是 18 毫秒 [1]。' })
      .reply({ content: '## 结论\n延迟只有 15 毫秒 [1]。' })
      .reply({ content: '## 结论\n延迟是 18 毫秒 [1]。' })
      .reply(supported('3.0 的平均延迟是 18 毫秒', '延迟是 18'));
    const result = await deepResearch('潮汐协议 3.0 的延迟是多少？', setup, { model: createModel('openai') });
    expect(result.verification).toMatchObject({ rounds: 1, stopped: 'verified' });
    expect(result.report).toBe('## 结论\n延迟是 18 毫秒 [1]。');
    expect(result.text.startsWith('## 结论\n延迟是 18 毫秒 [1]。\n\n来源：')).toBe(true);
  });

  test('用户取消：不派子 Agent，不写报告', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '{"steps": ["查性能"]}' }).reply({ content: '不该用到这一轮' });
    const result = await deepResearch('问题', setup, { model: createModel('openai'), review: async () => ({ action: 'cancel' }) });
    expect(result).toMatchObject({ status: 'cancelled', findings: [], report: '' });
    expect(llm.requests).toHaveLength(1);
    expect(result.usage.total.inputTokens).toBe(result.usage.plan.inputTokens);
  });

  test('一个子 Agent 出错：其他的照常，报告里注明', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ content: '{"steps": ["查甲", "查乙"]}' })
      .fail({ status: 400, message: '参数不对' })
      .reply({ content: '乙的结论。' })
      .reply({ content: '# 报告' });
    const result = await deepResearch('问题', setup, { model: createModel('openai'), concurrency: 1, verifyRounds: 0 });
    expect(result.findings.map((f) => f.status)).toEqual(['error', 'completed']);
    expect(llm.requests.at(-1)!.messages[1].content).toContain('（这个子问题没有查完：error）');
  });
});

describeMock('第 30 天：命令行的 /deep', () => {
  test('显示计划等确认，调研、写报告，报告存进 reports/', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '{"steps": ["潮汐云托管专业版的价格"]}' }).reply({ content: '专业版每月 499 元。' }).reply({ content: '# 潮汐云托管\n\n## 结论\n专业版每月 499 元。' });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (data) => (text += data));
    input.end(['/deep 潮汐云托管多少钱？', '', '/exit'].map((l) => `${l}\n`).join(''));
    await runCLI({ input, output, workspace: setup.workspace, provider: 'openai', search: setup.search, now: () => new Date(2026, 10, 4, 9, 5) });
    expect(text).toContain('计划：\n1. 潮汐云托管专业版的价格');
    expect(text).toContain('↳ 子问题 1：查完了');
    expect(text).toContain('# 潮汐云托管');
    const files = await readdir(join(setup.workspace, 'reports'));
    expect(files).toEqual(['20261104-0905-潮汐云托管多少钱？.md']);
    expect(await readFile(join(setup.workspace, 'reports', files[0]), 'utf8')).toContain('专业版每月 499 元');
    expect(text).toContain(`报告已保存：${join(setup.workspace, 'reports', files[0])}`);
  });
});

test('saveReport：文件名是日期加问题的开头，不能有路径分隔符', async () => {
  const setup = await makeSetup(import.meta.url, fixture);
  const path = await saveReport(setup.workspace, '对比 a/b 两种方案: 哪个好？', '# 报告', new Date(2026, 10, 4, 21, 7));
  expect(path).toBe(join(setup.workspace, 'reports', '20261104-2107-对比-a-b-两种方案-哪个好？.md'));
  expect(await readFile(path, 'utf8')).toBe('# 报告\n');
});

/** 第 30 天的三个研究任务。答案只在测试用的假网页和本地文档里 */
const TASKS = [
  { question: '潮汐协议 3.0 值得从 2.x 升级吗？请从性能提升和迁移成本两方面分析。', expect: ['18', '42', 'handshake.attempts'] },
  { question: '潮汐云托管的基础版和专业版有什么区别？一个五个人的小团队该选哪个？', expect: ['99', '499', '99.95'] },
  { question: '潮汐协议 3.0 有哪些主要变化？我们团队的网关部署文档里，上线前要检查什么？', expect: ['7443', '证书'] },
];

describeE2E('第 30 天：用真实模型跑通三个研究任务', () => {
  for (const task of TASKS) {
    test(task.question, { timeout: 900_000 }, async () => {
      const setup = await makeSetup(import.meta.url, fixture);
      const result = await deepResearch(task.question, setup, {
        model: createModel('openai'),
        review: async (plan) => {
          console.log(`\n计划：\n${plan.subquestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
          return { action: 'approve' };
        },
      });
      const checks = result.verification?.reports.at(-1);
      console.log(`\n${result.text}\n\n核查：${checks ? `${checks.problems.length} 处问题（${result.verification!.stopped}）` : '没有核查'}；引用检查：${result.citations.problems.join('；') || '通过'}`);
      expect(result.status).toBe('completed');
      expect(result.subquestions.length, '应该拆成几个子问题').toBeGreaterThanOrEqual(2);
      for (const fact of task.expect) expect(result.report, `报告里应该有 ${fact}`).toContain(fact);
      expect(result.citations.problems.filter((p) => p.includes('不是查到过的来源')), '不能编造编号').toEqual([]);
    });
  }
});
