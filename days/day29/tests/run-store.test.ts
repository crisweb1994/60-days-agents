import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { createRunStore, runResumable, resumeRun, describeInterrupt, waitingOf } = await loadTarget<typeof import('../solution/run-store.ts')>(
  import.meta.url,
  'run-store.ts',
);
const { createTools } = await loadTarget<typeof import('../solution/tools/index.ts')>(import.meta.url, 'tools/index.ts');
const { askUser } = await loadTarget<typeof import('../solution/tools/ask-user.ts')>(import.meta.url, 'tools/ask-user.ts');
const { DEFAULT_POLICY } = await loadTarget<typeof import('../solution/permissions.ts')>(import.meta.url, 'permissions.ts');
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');
const { createModel } = await loadTarget<typeof import('../solution/providers.ts')>(import.meta.url, 'providers.ts');

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'day29-runs-'));
  const dir = join(workspace, 'runs');
  const store = createRunStore(dir);
  const now = () => new Date('2026-11-04T01:30:00Z');
  const options = { store, now, model: createModel('openai'), tools: [...createTools(workspace), askUser], policy: DEFAULT_POLICY };
  return { workspace, dir, store, options };
}

describe('describeInterrupt', () => {
  test('批准和提问，写成给人看的一句话', () => {
    expect(describeInterrupt({ kind: 'approval', tool: 'write_file', input: { path: 'a.md' }, risk: 'write' })).toBe('批准执行 write_file（可写）：{"path":"a.md"}');
    expect(describeInterrupt({ kind: 'input', question: '哪个版本？', options: ['2.x', '3.0'] })).toBe('回答问题：哪个版本？（可选：2.x / 3.0）');
  });
});

describeMock('第 29 天：保存和恢复暂停的运行（TODO 5）', () => {
  test('暂停了就存成文件；带着答复恢复；又暂停就再存一次；跑完就删掉', async () => {
    const { dir, store, options, workspace } = await setup();
    llm
      .reply({ toolCalls: [{ name: 'ask_user', arguments: { question: '文件叫什么名字？' } }] })
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'tide.md', content: '笔记' } }] })
      .reply({ content: '写好了。' });

    const first = await runResumable('把笔记存下来', options);
    expect(first.result.status).toBe('paused');
    expect(first.waiting).toEqual([{ callId: expect.any(String), kind: 'input', description: '回答问题：文件叫什么名字？' }]);
    expect(await readdir(dir)).toEqual([`${first.id}.json`]);
    const saved = await store.load(first.id);
    expect(saved).toMatchObject({ id: first.id, question: '把笔记存下来', created: '2026-11-04T01:30:00.000Z', grants: [] });

    const second = await resumeRun(first.id, { [first.waiting[0].callId]: { answer: 'tide.md' } }, options);
    expect(second.id).toBe(first.id);
    expect(second.waiting.map((w) => w.description)).toEqual(['批准执行 write_file（可写）：{"path":"tide.md","content":"笔记"}']);
    expect((await store.list()).map((r) => r.id)).toEqual([first.id]);

    const third = await resumeRun(first.id, { [second.waiting[0].callId]: { approved: true, always: true } }, options);
    expect(third.result).toMatchObject({ status: 'completed', answer: '写好了。' });
    expect(third.waiting).toEqual([]);
    expect(await readFile(join(workspace, 'tide.md'), 'utf8')).toBe('笔记');
    expect(await readdir(dir), '跑完就删掉').toEqual([]);
    await expect(store.load(first.id)).rejects.toThrow(`没有这次运行：${first.id}`);
  });

  test('「以后都可以」存在运行里，下次恢复时还有效', async () => {
    const { store, options } = await setup();
    llm
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'a.md', content: 'a' } }] })
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'b.md', content: 'b' } }, { name: 'ask_user', arguments: { question: '还要别的吗？' } }] })
      .reply({ content: '好了。' });
    const first = await runResumable('写两个文件', options);
    const second = await resumeRun(first.id, { [first.waiting[0].callId]: { approved: true, always: true } }, options);
    expect((await store.load(first.id)).grants).toEqual(['write_file']);
    expect(second.waiting.map((w) => w.kind), '第二次写文件不用再批准，只等问题的回答').toEqual(['input']);
    expect(waitingOf((await store.load(first.id)).paused)).toEqual(second.waiting);
  });

  test('id 只能是字母、数字、下划线和连字符：不能用它跑到别的目录', async () => {
    const { store } = await setup();
    await expect(store.load('../../etc/passwd')).rejects.toThrow('运行的 id 不合法');
  });
});

describeMock('第 29 天：命令行里的确认和提问', () => {
  test('写文件回答 a：这次会话里不再问；Agent 用 ask_user 问的问题，直接在命令行里回答', async () => {
    const base = await makeSetup(import.meta.url, fixture);
    llm
      .reply({ toolCalls: [{ name: 'ask_user', arguments: { question: '存成什么文件名？', options: ['a.md', 'b.md'] } }] })
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'a.md', content: '1' } }] })
      .reply({ content: '存好了。' })
      .reply({ toolCalls: [{ name: 'write_file', arguments: { path: 'a.md', content: '2' } }] })
      .reply({ content: '又存好了。' });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (d) => (text += d));
    input.end(['存一下笔记', 'a.md', 'a', '再存一次', '/permissions', '/exit'].map((l) => `${l}\n`).join(''));
    await runCLI({ input, output, workspace: base.workspace, provider: 'openai', search: base.search });
    expect(text).toContain('存成什么文件名？（a.md / b.md）\n你的回答 > a.md');
    expect(llm.requests[1].messages.at(-1)!.content).toBe('用户回答：a.md');
    expect(text).toContain('要执行 write_file {"path":"a.md","content":"1"}（可写）');
    expect(text).toContain('允许吗？(y 允许 / a 这次会话里都允许 / N 不允许)');
    expect(text.match(/允许吗？/g), '第二次写文件没有再问').toHaveLength(1);
    expect(await readFile(join(base.workspace, 'a.md'), 'utf8')).toBe('2');
    expect(text).toContain('这次会话里都允许的：write_file');
  });
});
