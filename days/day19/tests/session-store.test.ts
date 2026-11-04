import { readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';
import type { Message } from '../solution/types.ts';

const { createSessionStore, newSessionId, repairHistory, titleOf } = await loadTarget<typeof import('../solution/session-store.ts')>(
  import.meta.url,
  'session-store.ts',
);

const saved = (id: string, updated: string, messages: Message[] = [{ role: 'user', content: '你好' }]) => ({
  id,
  title: titleOf(messages),
  model: 'openai:m',
  messages,
  usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, reasoningTokens: 0 },
  turns: 1,
  created: updated,
  updated,
});

test('newSessionId 按时间排序；titleOf 去掉动态信息，太长就截短', () => {
  expect(newSessionId(new Date('2026-11-02T10:20:30Z'))).toMatch(/^20261102-102030-[a-z0-9]{1,4}$/);
  expect(titleOf([{ role: 'system', content: 'S' }, { role: 'user', content: '<date>\n今天\n</date>\n\n潮汐协议是什么' }])).toBe('潮汐协议是什么');
  expect(titleOf([{ role: 'user', content: '问'.repeat(40) }])).toBe(`${'问'.repeat(30)}…`);
});

describe('第 19 天：保存和读取会话（TODO 4）', () => {
  test('保存再读回来，内容一样；不留临时文件', async () => {
    const store = createSessionStore(await mkdtemp(join(tmpdir(), 'day19-sessions-')));
    const session = saved('s1', '2026-11-02T10:00:00.000Z');
    await store.save(session);
    expect(await store.load('s1')).toEqual(session);
    expect(readdirSync(store.dir)).toEqual(['s1.json']);
  });

  test('list：最近更新的在前，坏掉的文件跳过', async () => {
    const store = createSessionStore(await mkdtemp(join(tmpdir(), 'day19-sessions-')));
    await store.save(saved('old', '2026-11-01T00:00:00.000Z'));
    await store.save(saved('new', '2026-11-02T00:00:00.000Z'));
    await writeFile(join(store.dir, 'broken.json'), '{ 写到一半');
    expect((await store.list()).map((s) => s.id)).toEqual(['new', 'old']);
    expect((await store.list())[0]).toEqual({ id: 'new', title: '你好', turns: 1, updated: '2026-11-02T00:00:00.000Z' });
  });

  test('找不到、文件坏了、id 想跑到目录外面：报错，说明原因', async () => {
    const store = createSessionStore(await mkdtemp(join(tmpdir(), 'day19-sessions-')));
    await expect(store.load('nope')).rejects.toThrow('/sessions');
    await writeFile(join(store.dir, 'broken.json'), '{');
    await expect(store.load('broken')).rejects.toThrow('坏了');
    await expect(store.load('../../etc/passwd')).rejects.toThrow('格式不对');
  });
});

describe('第 19 天：修补中断的历史（TODO 5）', () => {
  test('最后的工具调用没有结果：补上「没有执行」的结果；完整的历史不变', () => {
    const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'calculator', arguments: '{}' } });
    const broken: Message[] = [
      { role: 'user', content: '算一下' },
      { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
      { role: 'tool', tool_call_id: 'a', content: '1' },
    ];
    const repaired = repairHistory(broken);
    expect(repaired).toHaveLength(4);
    expect(repaired[3]).toMatchObject({ role: 'tool', tool_call_id: 'b' });
    expect(repaired[3].content).toContain('中断');
    expect(broken, '不要修改传进来的数组').toHaveLength(3);
    const complete: Message[] = [...broken, { role: 'tool', tool_call_id: 'b', content: '2' }, { role: 'assistant', content: '好了' }];
    expect(repairHistory(complete)).toEqual(complete);
  });

  test('load 时自动修补', async () => {
    const store = createSessionStore(await mkdtemp(join(tmpdir(), 'day19-sessions-')));
    const messages: Message[] = [
      { role: 'user', content: '算一下' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'calculator', arguments: '{}' } }] },
    ];
    await store.save(saved('crashed', '2026-11-02T00:00:00.000Z', messages));
    expect((await store.load('crashed')).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'x' });
  });
});
