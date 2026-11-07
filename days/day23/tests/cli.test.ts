import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { describeMock, loadTarget, setupModel } from '#testing';
import { makeSetup } from './helpers.ts';
import { startFixture } from './web-fixture.ts';

const llm = await setupModel();
const fixture = await startFixture();
const { runCLI } = await loadTarget<typeof import('../solution/cli.ts')>(import.meta.url, 'cli.ts');

async function runWith(lines: string[]) {
  const setup = await makeSetup(import.meta.url, fixture);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (data) => (text += data));
  input.end(lines.map((line) => `${line}\n`).join(''));
  await runCLI({ input, output, workspace: setup.workspace, provider: 'openai', search: setup.search, docs: setup.docs });
  return text;
}

describeMock('第 23 天：命令行里的计划', () => {
  test('Agent 更新计划时显示整份计划；/plan 查看当前的计划', async () => {
    const steps = (statuses: string[]) => ['查端口', '查性能'].map((content, i) => ({ content, status: statuses[i] }));
    llm
      .reply({ toolCalls: [{ name: 'update_plan', arguments: { steps: steps(['in_progress', 'pending']) } }] })
      .reply({ toolCalls: [{ name: 'update_plan', arguments: { steps: steps(['completed', 'in_progress']) } }] })
      .reply({ content: '好的。' });
    const text = await runWith(['潮汐协议 3.0 怎么样？', '/plan', '/exit']);
    expect(text).toContain('✓ 计划\n  [>] 查端口\n  [ ] 查性能\n  进度：0/2');
    expect(text).toContain('✓ 计划\n  [x] 查端口\n  [>] 查性能\n  进度：1/2');
    expect(text).toMatch(/\/plan\n\[x\] 查端口\n\[>\] 查性能\n进度：1\/2/);
  });

  test('还没有计划时，/plan 说明一下', async () => {
    const text = await runWith(['/plan', '/exit']);
    expect(text).toContain('还没有计划');
  });
});
