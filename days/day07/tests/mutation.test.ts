// 检查你在 agent.test.ts 里写的测试：先在正确的 Agent 上跑一遍，应该全部通过；
// 再换成 mutants/ 里故意藏了 bug 的 Agent 各跑一遍，每一次都应该有测试失败。这种做法叫变异测试。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';
import { describeMock, target } from '#testing';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const config = fileURLToPath(new URL('../vitest.config.ts', import.meta.url));

const mutants = [
  { name: 'no-max-steps', bug: '循环没有步数上限' },
  { name: 'ignore-truncation', bug: '输出被截断时照常执行工具、当成正常完成' },
  { name: 'no-repeat-check', bug: '不检查重复的工具调用' },
  { name: 'blocked-as-completed', bug: '被内容审核拦截时当成正常完成' },
  { name: 'no-tool-error-limit', bug: '工具连续出错也不停下' },
  { name: 'no-assistant-in-history', bug: '没有把模型的回复放回历史' },
];

type Run = { passed: boolean; output: string };

/** 在一个新的 vitest 进程里运行 agent.test.ts。mutant 为空时用正确的 Agent */
function runYourTests(mutant: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, 'run', '--config', config], {
      cwd: root,
      env: { ...process.env, CHECK_TARGET: target, MUTANT: mutant, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    child.on('exit', (code) => resolve({ passed: code === 0, output }));
  });
}

/** 输出太长时只看最后一段，那里有失败的测试和原因 */
const tail = (output: string) => output.split('\n').slice(-40).join('\n');

describeMock('第 7 天：你写的测试（TODO 4）', () => {
  const runs = new Map<string, Run>();
  beforeAll(async () => {
    const names = ['', ...mutants.map((m) => m.name)];
    const results = await Promise.all(names.map((name) => runYourTests(name)));
    names.forEach((name, i) => runs.set(name, results[i]));
  }, 120_000);

  test('在正确的 Agent 上全部通过', () => {
    const run = runs.get('')!;
    expect(run.passed, `agent.test.ts 在正确的 Agent 上没有全部通过：\n${tail(run.output)}`).toBe(true);
  });

  for (const mutant of mutants) {
    test(`能发现这个 bug：${mutant.bug}`, () => {
      // 在正确的 Agent 上都没通过时，换成有 bug 的版本当然也会失败，那不算发现了 bug
      expect(runs.get('')!.passed, '先让 agent.test.ts 在正确的 Agent 上全部通过').toBe(true);
      expect(
        runs.get(mutant.name)!.passed,
        `把 Agent 换成「${mutant.bug}」的版本（tests/mutants/${mutant.name}.ts）后，你的测试仍然全部通过。在 agent.test.ts 里补一个能发现它的测试`,
      ).toBe(false);
    });
  }
});
