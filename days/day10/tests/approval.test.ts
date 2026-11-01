import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { ApprovalRequest } from '../solution/tool.ts';

const { runToolCall } = await loadTarget<typeof import('../solution/tool.ts')>(import.meta.url, 'tool.ts');
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');

let workspace: string;
let tools: ReturnType<typeof createTools>;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'day10-approval-'));
  tools = createTools(workspace);
});

let nextId = 1;
const call = (name: string, args: object) => ({
  id: `call_${nextId++}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** 记下每次确认请求，并按 answer 回答 */
function recorder(answer: boolean) {
  const asked: ApprovalRequest[] = [];
  return { asked, confirm: async (request: ApprovalRequest) => (asked.push(request), answer) };
}

describe('第 10 天：执行有副作用的工具之前先确认（TODO 2）', () => {
  test('用户同意：照常执行。确认请求里带着工具名和已经校验过的参数', async () => {
    const { asked, confirm } = recorder(true);
    const result = await runToolCall(tools, call('write_file', { path: 'a.txt', content: '你好' }), { confirm });
    expect(result.isError).toBe(false);
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: 'write_file', input: { path: 'a.txt', content: '你好' } });
  });

  test('用户不同意：不执行，把「用户没有同意」作为错误结果交回模型', async () => {
    const { confirm } = recorder(false);
    const result = await runToolCall(tools, call('write_file', { path: 'a.txt', content: '你好' }), { confirm });
    expect(existsSync(join(workspace, 'a.txt')), '用户不同意就不能执行').toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('没有同意');
  });

  test('没有提供 confirm：有副作用的工具一律不执行', async () => {
    const result = await runToolCall(tools, call('write_file', { path: 'a.txt', content: '你好' }));
    expect(existsSync(join(workspace, 'a.txt')), '没人确认，就当作不同意').toBe(false);
    expect(result.isError).toBe(true);
  });

  test('只读的工具不用确认', async () => {
    const { asked, confirm } = recorder(false);
    expect((await runToolCall(tools, call('calculator', { expression: '1 + 1' }), { confirm })).content).toBe('2');
    expect(asked, '计算器没有副作用，不用问').toEqual([]);
  });

  test('HTTP 请求按参数判断：GET 不用确认，POST 要确认', async () => {
    const { asked, confirm } = recorder(false);
    const post = await runToolCall(tools, call('http_request', { url: 'http://127.0.0.1:9/api', method: 'POST', body: '{}' }), { confirm });
    expect(post.content, 'POST 被拒绝了，不会真的发出去').toContain('没有同意');
    expect(asked.map((r) => r.tool)).toEqual(['http_request']);
    // GET 不需要确认，会真的发出去；端口 9 没有服务在听，所以是网络错误，而不是「没有同意」
    const get = await runToolCall(tools, call('http_request', { url: 'http://127.0.0.1:9/api', method: 'GET', body: null }), { confirm });
    expect(get.content).not.toContain('没有同意');
    expect(asked, 'GET 不用问').toHaveLength(1);
  });

  test('参数不合法时，先报参数的错，不用打扰用户', async () => {
    const { asked, confirm } = recorder(true);
    const result = await runToolCall(tools, call('write_file', { path: 'a.txt' }), { confirm });
    expect(result.content).toContain('content');
    expect(asked, '先校验参数，再问用户').toEqual([]);
  });
});
