import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadTarget } from '#testing';

const mem = await loadTarget<typeof import('../solution/memory.ts')>(import.meta.url, 'memory.ts');
const { createMemoryStore, findSecrets, memorySection, parseMemory, serializeMemory } = mem;

const tempDir = () => mkdtemp(join(tmpdir(), 'day19-memory-'));
/** 一个可以拨动的时钟 */
function clock(start = '2026-11-02T10:00:00Z') {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advanceDays: (days: number) => (t += days * 86_400_000) };
}

describe('第 19 天：敏感信息不能记（TODO 1）', () => {
  test('认出 API Key、令牌、身份证号、银行卡号、手机号', () => {
    expect(findSecrets('我的 key 是 sk-abcdefghijklmnopqrstuvwx')).toEqual(['API Key']);
    expect(findSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toEqual(['令牌']);
    expect(findSecrets('身份证 11010519491231002X')).toEqual(['身份证号']);
    expect(findSecrets('卡号 6222021234567890123')).toEqual(['银行卡号']);
    expect(findSecrets('电话 13812345678')).toEqual(['手机号']);
  });

  test('普通的内容不误报：日期、版本号、端口、短数字', () => {
    expect(findSecrets('2026-11-02 发布 3.0 版本，端口 7443，每秒 12000 个请求，用户喜欢简短的回答')).toEqual([]);
  });
});

test('serializeMemory 和 parseMemory 互相还原；格式坏了返回 undefined', () => {
  const memory = { name: 'a', type: 'user' as const, content: '内容\n第二行', created: '2026-11-01T00:00:00.000Z', updated: '2026-11-02T00:00:00.000Z' };
  expect(parseMemory('a', serializeMemory(memory))).toEqual(memory);
  expect(parseMemory('a', '没有元数据')).toBeUndefined();
  expect(parseMemory('a', '---\ntype: unknown\ncreated: x\nupdated: y\n---\n\n内容')).toBeUndefined();
});

describe('第 19 天：记下和更新（TODO 2）', () => {
  test('每条记忆一个文件，MEMORY.md 是索引', async () => {
    const dir = await tempDir();
    const store = createMemoryStore(dir, clock().now);
    const { memory, updated } = await store.remember({ name: 'prefers-short-answers', type: 'user', content: '用户喜欢简短的回答' });
    expect(updated).toBe(false);
    expect(memory).toMatchObject({ name: 'prefers-short-answers', type: 'user', created: '2026-11-02T10:00:00.000Z' });
    expect(readFileSync(join(dir, 'prefers-short-answers.md'), 'utf8')).toContain('用户喜欢简短的回答');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain('- [prefers-short-answers](prefers-short-answers.md)（user）用户喜欢简短的回答');
  });

  test('同名的记忆更新它，不会出现两条；创建时间保留', async () => {
    const c = clock();
    const store = createMemoryStore(await tempDir(), c.now);
    await store.remember({ name: 'deploy', type: 'project', content: '用 Docker 部署' });
    c.advanceDays(3);
    const { memory, updated } = await store.remember({ name: 'deploy', type: 'project', content: '改用 Kubernetes 部署' });
    expect(updated).toBe(true);
    expect(memory.created).toBe('2026-11-02T10:00:00.000Z');
    expect(memory.updated).toBe('2026-11-05T10:00:00.000Z');
    expect((await store.list()).map((m) => m.content)).toEqual(['改用 Kubernetes 部署']);
  });

  test('名字不对、内容是空的、太长、有敏感信息：都拒绝，说明原因', async () => {
    const store = createMemoryStore(await tempDir());
    await expect(store.remember({ name: 'Bad Name', type: 'user', content: 'x' })).rejects.toThrow('短横线');
    await expect(store.remember({ name: 'empty', type: 'user', content: '  ' })).rejects.toThrow('空');
    await expect(store.remember({ name: 'long', type: 'user', content: '长'.repeat(501) })).rejects.toThrow('太长');
    await expect(store.remember({ name: 'key', type: 'reference', content: '用户的 API Key 是 sk-abcdefghijklmnopqrstuvwx' })).rejects.toThrow('API Key');
    expect(existsSync(join(store.dir, 'key.md')), '敏感信息绝不能写进文件').toBe(false);
  });

  test('ttlDays：到期以后自动忘掉', async () => {
    const c = clock();
    const store = createMemoryStore(await tempDir(), c.now);
    await store.remember({ name: 'this-week', type: 'project', content: '这周在准备发布', ttlDays: 7 });
    await store.remember({ name: 'forever', type: 'user', content: '用户叫小王' });
    c.advanceDays(6);
    expect((await store.list()).map((m) => m.name)).toEqual(['forever', 'this-week']);
    c.advanceDays(2);
    expect((await store.list()).map((m) => m.name)).toEqual(['forever']);
    expect(existsSync(join(store.dir, 'this-week.md')), '过期的文件要删掉').toBe(false);
  });
});

describe('第 19 天：列出、查找、忘掉（TODO 3）', () => {
  test('list：最近更新的在前；人手改坏的文件跳过；目录不存在就是空的', async () => {
    const c = clock();
    const dir = await tempDir();
    const store = createMemoryStore(dir, c.now);
    await store.remember({ name: 'first', type: 'user', content: '第一条' });
    c.advanceDays(1);
    await store.remember({ name: 'second', type: 'feedback', content: '第二条' });
    await writeFile(join(dir, 'broken.md'), '被人改坏了');
    expect((await store.list()).map((m) => m.name)).toEqual(['second', 'first']);
    expect(await createMemoryStore(join(dir, 'nope')).list()).toEqual([]);
  });

  test('search：名字或内容里包含每一个关键词，不区分大小写', async () => {
    const store = createMemoryStore(await tempDir());
    await store.remember({ name: 'deploy-k8s', type: 'project', content: '项目用 Kubernetes 部署' });
    await store.remember({ name: 'short', type: 'user', content: '回答要简短' });
    expect((await store.search('kubernetes')).map((m) => m.name)).toEqual(['deploy-k8s']);
    expect((await store.search('k8s 部署')).map((m) => m.name)).toEqual(['deploy-k8s']);
    expect(await store.search('python')).toEqual([]);
  });

  test('forget：删掉文件，更新索引；没有这条就返回 false', async () => {
    const store = createMemoryStore(await tempDir());
    await store.remember({ name: 'a', type: 'user', content: '甲' });
    expect(await store.forget('a')).toBe(true);
    expect(await store.forget('a')).toBe(false);
    expect(readFileSync(join(store.dir, 'MEMORY.md'), 'utf8')).not.toContain('甲');
  });

  test('memorySection：放进动态信息；放不下的只列名字', async () => {
    const store = createMemoryStore(await tempDir());
    expect(await memorySection(store)).toBeUndefined();
    await store.remember({ name: 'short', type: 'user', content: '回答要简短' });
    await store.remember({ name: 'long', type: 'project', content: '长'.repeat(400) });
    const section = (await memorySection(store, 100))!;
    expect(section).toMatchObject({ label: 'memory', priority: 5 });
    expect(section.content).toContain('- short（user）：回答要简短');
    expect(section.content).toContain('还有 1 条没列出：long');
  });
});
