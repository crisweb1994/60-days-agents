// 运行你在 exercise/agent.test.ts 里写的测试：npx vitest --config days/day07/vitest.config.ts
// npm run check 7 也用它：先在正确的 Agent 上跑一遍，再换成几个故意藏了 bug 的 Agent（tests/mutants/）各跑一遍。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const target = process.env.CHECK_TARGET === 'solution' ? 'solution' : 'exercise';
// 设置了 MUTANT 时，把被测的 agent.ts 换成 tests/mutants/ 里同名的有 bug 的版本
const mutant = process.env.MUTANT;

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [
    {
      name: 'swap-agent',
      enforce: 'pre',
      async resolveId(source, importer, options) {
        if (!mutant || !importer) return null;
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved && /[\\/]days[\\/]day07[\\/](exercise|solution)[\\/]agent\.ts$/.test(resolved.id)) {
          return fileURLToPath(new URL(`./tests/mutants/${mutant}.ts`, import.meta.url));
        }
        return null;
      },
    },
  ],
  test: {
    include: [`days/day07/${target}/agent.test.ts`],
    // vitest 默认会把转换后的模块缓存到磁盘上，下次直接复用。上面的插件按 MUTANT 换模块，
    // 缓存却不知道这一点，会把上一次的结果拿来用，所以这里关掉
    fsModuleCache: false,
  },
});
