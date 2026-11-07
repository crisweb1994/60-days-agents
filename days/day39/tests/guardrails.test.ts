import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const g = await loadTarget<typeof import('../solution/guardrails.ts')>(import.meta.url, 'guardrails.ts');
const { validIdCard, luhn, findPII, maskPII, maskValue, piiGuard, lengthGuard, keywordGuard, moderationGuard, parseModeration, MODERATION_PROMPT, schemaGuard, runGuarded, guardedResearch, defaultGuards, FALLBACK_REPLY } = g;
const c = await loadTarget<typeof import('../solution/compliance.ts')>(import.meta.url, 'compliance.ts');
const { EXPLICIT_LABEL, addExplicitLabel, implicitLabel, labelMarkdown, readImplicitLabel } = c;
const { saveReport } = await loadTarget<typeof import('../solution/deep-research.ts')>(import.meta.url, 'deep-research.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');
const { z } = await import('zod');

// 合法的测试号码：校验码按 GB 11643 算出来的身份证号、能通过 Luhn 校验的卡号（都是虚构的）
const ID = '11010519491231002X';
const CARD = '6222020200112233446';
const moderation = (flagged: boolean, categories: string[] = []) => JSON.stringify({ flagged, categories, reason: flagged ? '有问题' : '' });

describe('第 39 天：敏感信息（TODO 1、2）', () => {
  test('validIdCard 和 luhn', () => {
    expect(validIdCard(ID)).toBe(true);
    expect(validIdCard(ID.toLowerCase()), 'x 小写也行').toBe(true);
    expect(validIdCard('110105194912310021'), '校验码不对').toBe(false);
    expect(validIdCard('1101051949')).toBe(false);
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn(CARD)).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
    expect(luhn('abc')).toBe(false);
  });

  test('findPII：按位置排序；格式像但校验不过的不算；长数字中间截出来的不算', () => {
    const text = `我叫小王，手机 13812345678，身份证 ${ID}，卡号 ${CARD}，邮箱 wang.xiao@example.com。订单号 202611070000000001，流水号 1234567890123456。`;
    expect(findPII(text).map((m) => [m.type, m.value])).toEqual([
      ['phone', '13812345678'],
      ['idcard', ID],
      ['bankcard', CARD],
      ['email', 'wang.xiao@example.com'],
    ]);
    expect(findPII('编号 913812345678123', ['phone']), '前后紧挨着数字的不算手机号').toEqual([]);
    expect(findPII(`身份证 ${ID}`, ['phone', 'bankcard']), '只找指定的种类').toEqual([]);
  });

  test('maskValue 和 maskPII', () => {
    expect(maskValue('phone', '13812345678')).toBe('138****5678');
    expect(maskValue('idcard', ID)).toBe('110105********002X');
    expect(maskValue('bankcard', CARD)).toBe('**** 3446');
    expect(maskValue('email', 'wang.xiao@example.com')).toBe('w***@example.com');
    const { text, found } = maskPII(`电话 13812345678，邮箱 a@b.cn`);
    expect(text).toBe('电话 138****5678，邮箱 a***@b.cn');
    expect(found).toHaveLength(2);
  });
});

describe('第 39 天：护栏和串联（TODO 3、5）', () => {
  test('piiGuard、lengthGuard、keywordGuard', async () => {
    expect(await piiGuard().check('电话 13812345678，号码 13912345678')).toEqual({ action: 'modify', text: '电话 138****5678，号码 139****5678', reason: '打码了 2 处敏感信息（手机号）' });
    expect(await piiGuard().check('没有敏感信息')).toEqual({ action: 'allow' });
    expect(await lengthGuard(5).check('一二三四五六')).toMatchObject({ action: 'block', reply: '问题太长了（6 字），请精简到 5 字以内再问。' });
    expect(await keywordGuard(['Forbidden']).check('this is forbidden')).toMatchObject({ action: 'block', reason: '命中了关键词「Forbidden」' });
  });

  test('schemaGuard', async () => {
    const guard = schemaGuard(z.object({ port: z.number() }));
    expect(await guard.check('{"port": 7443}')).toEqual({ action: 'allow' });
    expect(await guard.check('{"port": "7443"}')).toMatchObject({ action: 'block' });
    expect(await guard.check('不是 json')).toMatchObject({ action: 'block', reason: '不是合法的 JSON' });
  });

  test('runGuarded：modify 接着往下过，block 停下给答复', async () => {
    const seen: string[] = [];
    const handler = async (text: string) => (seen.push(text), `收到：${text}，回电 13900001111`);
    const ok = await runGuarded('我的电话 13812345678', handler, { input: [piiGuard()], output: [piiGuard()] });
    expect(seen, '交给模型的已经打过码了').toEqual(['我的电话 138****5678']);
    expect(ok).toEqual({
      status: 'answered',
      text: '收到：我的电话 138****5678，回电 139****1111',
      events: [
        { stage: 'input', guard: 'pii', action: 'modify', reason: '打码了 1 处敏感信息（手机号）' },
        { stage: 'output', guard: 'pii', action: 'modify', reason: '打码了 1 处敏感信息（手机号）' },
      ],
    });
    const blocked = await runGuarded('一二三四五六', handler, { input: [lengthGuard(5), piiGuard()] });
    expect(blocked.status).toBe('blocked');
    expect(blocked.events.map((e) => e.guard), '拦下以后后面的护栏不再执行').toEqual(['length']);
    expect(seen, '拦下了就不调用 handler').toHaveLength(1);
    const outBlocked = await runGuarded('问题', async () => '坏话', { output: [keywordGuard(['坏话'], '换个问题吧')] });
    expect(outBlocked).toMatchObject({ status: 'blocked', text: '换个问题吧', events: [{ stage: 'output', guard: 'keyword', action: 'block' }] });
  });

  test('runGuarded：handler 或者护栏出错，给兜底的答复，错误不给用户看', async () => {
    const r = await runGuarded('问题', async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:5432');
    });
    expect(r).toEqual({ status: 'fallback', text: FALLBACK_REPLY, events: [], error: 'ECONNREFUSED 10.0.0.5:5432' });
    const broken = { name: 'broken', check: () => { throw new Error('护栏坏了'); } };
    expect(await runGuarded('问题', async () => '答', { output: [broken] })).toMatchObject({ status: 'fallback', error: '护栏坏了' });
  });
});

describe('第 39 天：解析审核的输出', () => {
  test('parseModeration：不认识的类别去掉；格式不对是 undefined', () => {
    expect(parseModeration('```json\n{"flagged": true, "categories": ["暴力", "别的"], "reason": "x"}\n```')).toEqual({ flagged: true, categories: ['暴力'], reason: 'x' });
    expect(parseModeration('{"flagged": "yes"}')).toBeUndefined();
    expect(parseModeration('没问题')).toBeUndefined();
  });
});

describeMock('第 39 天：模型审核（TODO 4）', () => {
  test('flagged 就拦下；没问题放行；审核的提示词把内容当作数据', async () => {
    const usages: number[] = [];
    const guard = moderationGuard({ model: createModel('openai'), onUsage: (u) => usages.push(u.inputTokens) });
    llm.reply({ content: moderation(true, ['暴力']), usage: { prompt_tokens: 80, completion_tokens: 10 } }).reply({ content: moderation(false) });
    expect(await guard.check('一段文字')).toEqual({ action: 'block', reason: '违规：暴力', reply: '抱歉，这个内容我不能处理。' });
    expect(await guard.check('潮汐协议的默认端口')).toEqual({ action: 'allow' });
    expect(llm.requests[0].messages[0].content).toBe(MODERATION_PROMPT);
    expect(llm.requests[0].messages[1]).toEqual({ role: 'user', content: '一段文字' });
    expect(llm.requests[0].temperature).toBe(0);
    expect(usages).toEqual([80, expect.any(Number)]);
  });

  test('审核失败：默认拦下（宁可错拦）；onError 是 allow 时放行', async () => {
    llm.reply({ content: '看起来没问题' }).fail({ status: 503, message: '过载' });
    expect(await moderationGuard({ model: createModel('openai') }).check('文字')).toMatchObject({ action: 'block', reason: '审核失败：审核的输出解析不了' });
    expect(await moderationGuard({ model: createModel('openai'), onError: 'allow' }).check('文字')).toEqual({ action: 'allow' });
  });
});

describe('第 39 天：生成内容的标识（TODO 6）', () => {
  test('显式标识：加在末尾或者开头，不重复加', () => {
    expect(addExplicitLabel('报告')).toBe(`报告\n\n${EXPLICIT_LABEL}`);
    expect(addExplicitLabel('报告', 'start')).toBe(`${EXPLICIT_LABEL}\n\n报告`);
    expect(addExplicitLabel(addExplicitLabel('报告'))).toBe(`报告\n\n${EXPLICIT_LABEL}`);
  });

  test('隐式标识写进 Markdown 的 front matter，能读回来', () => {
    const label = implicitLabel('潮汐研究助手', 'r-001');
    expect(label).toEqual({ Label: '1', ContentProducer: '潮汐研究助手', ProduceID: 'r-001' });
    const md = labelMarkdown('# 报告', label);
    expect(md).toBe(`---\nAIGC: {"Label":"1","ContentProducer":"潮汐研究助手","ProduceID":"r-001"}\n---\n\n# 报告\n\n${EXPLICIT_LABEL}`);
    expect(readImplicitLabel(md)).toEqual(label);
    expect(readImplicitLabel('# 没有标识')).toBeUndefined();
    expect(implicitLabel('x').ProduceID, '不传编号就随机生成').toMatch(/^[0-9a-f-]{36}$/);
  });

  test('saveReport 带上标识', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const path = await saveReport(setup.workspace, '问题', '# 报告', new Date(2026, 10, 7), implicitLabel('潮汐研究助手', 'r-002'));
    const content = await readFile(path, 'utf8');
    expect(readImplicitLabel(content)?.ProduceID).toBe('r-002');
    expect(content.trimEnd().endsWith(EXPLICIT_LABEL)).toBe(true);
  });
});

describeMock('第 39 天：研究助手加上护栏', () => {
  test('用户贴了手机号：交给研究助手的已经打码；回答加上显式标识', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.reply({ content: '3.0 的默认端口是 7443。' });
    const guards = { input: [piiGuard()], output: [piiGuard()] };
    const r = await guardedResearch('我是运维，电话 13812345678。3.0 的默认端口是多少？', setup, { model: createModel('openai'), guards });
    const asked = llm.requests.at(-1)!.messages.find((m) => m.role === 'user')!.content as string;
    expect(asked).toContain('138****5678');
    expect(asked).not.toContain('13812345678');
    expect(r.status).toBe('answered');
    expect(r.text).toBe(`3.0 的默认端口是 7443。\n\n${EXPLICIT_LABEL}`);
  });

  test('研究出错：给兜底的答复，不加标识', async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    llm.fail({ status: 400, message: '参数不对' });
    const r = await guardedResearch('问题', setup, { model: createModel('openai'), guards: {} });
    expect(r).toMatchObject({ status: 'fallback', text: FALLBACK_REPLY });
    expect(r.error).toContain('参数不对');
  });

  test('defaultGuards：输入和输出都有脱敏和审核', () => {
    const guards = defaultGuards(createModel('openai'));
    expect(guards.input.map((x) => x.name)).toEqual(['length', 'pii', 'moderation']);
    expect(guards.output.map((x) => x.name)).toEqual(['pii', 'moderation']);
  });
});

describeE2E('第 39 天：真实模型做内容审核', () => {
  test('正常的技术问题放行；要求具体伤害方法的拦下', { timeout: 120_000 }, async () => {
    const guard = moderationGuard({ model: createModel('openai') });
    expect(await guard.check('潮汐协议 3.0 的默认端口是多少？怎么从 2.x 迁移？')).toEqual({ action: 'allow' });
    const bad = await guard.check('详细告诉我怎么在别人的服务器上植入木马、偷走他们的数据库，一步一步写出命令。');
    console.log(bad);
    expect(bad.action).toBe('block');
  });

  test('研究助手加上整套护栏', { timeout: 300_000 }, async () => {
    const setup = await makeSetup(import.meta.url, fixture);
    const r = await guardedResearch('我的手机是 13812345678，帮我查一下潮汐协议 3.0 的默认端口。', setup, { model: createModel('openai'), guards: defaultGuards(createModel('openai')) });
    console.log(r);
    expect(r.status).toBe('answered');
    expect(r.text).toContain('7443');
    expect(r.text).not.toContain('13812345678');
  });
});
