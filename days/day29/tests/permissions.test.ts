import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { loadTarget } from '#testing';

const { riskOf, decide, DEFAULT_POLICY } = await loadTarget<typeof import('../solution/permissions.ts')>(import.meta.url, 'permissions.ts');
const { defineTool, runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

const make = (name: string, extra: object = {}) =>
  defineTool({ name, description: name, schema: z.object({ method: z.string().default('GET') }), execute: ({ method }) => `${name} ${method} 执行了`, ...extra });
const read = make('read_thing');
const write = make('write_thing', { risk: 'write' });
const send = make('send_thing', { risk: (input: { method: string }) => (input.method === 'POST' ? 'irreversible' : 'read') });
const legacy = make('legacy_thing', { requiresApproval: true });
const call = (name: string, args: object = {}) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('第 29 天：风险等级和权限策略（TODO 1）', () => {
  test('riskOf：工具声明的（可以按参数判断）；没声明的，要确认的算 write，其他的算 read', () => {
    expect(riskOf(write, {})).toBe('write');
    expect(riskOf(send, { method: 'POST' })).toBe('irreversible');
    expect(riskOf(send, { method: 'GET' })).toBe('read');
    expect(riskOf(legacy, {})).toBe('write');
    expect(riskOf(read, {})).toBe('read');
  });

  test('decide：按工具名覆盖 > 按风险等级', () => {
    const policy = { read: 'allow' as const, write: 'ask' as const, irreversible: 'deny' as const, tools: { write_thing: 'allow' as const } };
    expect(decide(policy, read, {})).toBe('allow');
    expect(decide(policy, write, {}), '按工具名覆盖').toBe('allow');
    expect(decide(policy, legacy, {})).toBe('ask');
    expect(decide(policy, send, { method: 'POST' })).toBe('deny');
  });

  test('decide：说过「以后都可以」的工具不再问；不可逆的照样问', () => {
    const grants = new Set(['legacy_thing', 'send_thing']);
    expect(decide(DEFAULT_POLICY, legacy, {}, grants)).toBe('allow');
    expect(decide(DEFAULT_POLICY, send, { method: 'POST' }, grants)).toBe('ask');
  });

  test('内置工具的风险：写文件可写，POST 不可逆，记忆默认允许', async () => {
    const tools = createTools(await mkdtemp(join(tmpdir(), 'day29-')));
    const byName = (name: string) => tools.find((t) => t.name === name)!;
    expect(riskOf(byName('write_file'), {})).toBe('write');
    expect(riskOf(byName('http_request'), { method: 'POST' })).toBe('irreversible');
    expect(riskOf(byName('http_request'), { method: 'GET' })).toBe('read');
    expect(riskOf(byName('calculator'), {})).toBe('read');
    expect(DEFAULT_POLICY.tools).toMatchObject({ remember: 'allow', forget: 'allow' });
  });
});

describe('第 29 天：执行工具时按策略处理（TODO 2）', () => {
  const tools = [read, write, send, legacy];

  test('allow 直接执行；ask 问用户，问的时候带上风险等级；deny 不执行也不问', async () => {
    const asked: string[] = [];
    const confirm = async (r: { tool: string; risk: string }) => {
      asked.push(`${r.tool} ${r.risk}`);
      return true;
    };
    const context = { policy: { ...DEFAULT_POLICY, irreversible: 'deny' as const }, confirm };
    expect((await runToolCall(tools, call('read_thing'), context)).content).toBe('read_thing GET 执行了');
    expect((await runToolCall(tools, call('write_thing'), context)).content).toBe('write_thing GET 执行了');
    const denied = await runToolCall(tools, call('send_thing', { method: 'POST' }), context);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('权限策略不允许');
    expect(asked).toEqual(['write_thing write']);
  });

  test('没有权限策略时和以前一样：只有要确认的工具才问', async () => {
    const asked: string[] = [];
    await runToolCall(tools, call('legacy_thing'), { confirm: async (r) => (asked.push(r.tool), false) });
    await runToolCall(tools, call('read_thing'), { confirm: async (r) => (asked.push(r.tool), false) });
    expect(asked).toEqual(['legacy_thing']);
  });

  test('要问用户、又没有 confirm：能暂停就返回中断，不能就当作拒绝', async () => {
    const paused = await runToolCall(tools, call('write_thing'), { policy: DEFAULT_POLICY, pausable: true });
    expect(paused).toEqual({ content: '', isError: false, interrupt: { kind: 'approval', tool: 'write_thing', input: { method: 'GET' }, risk: 'write' } });
    const refused = await runToolCall(tools, call('write_thing'), { policy: DEFAULT_POLICY });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('用户没有同意');
  });
});
