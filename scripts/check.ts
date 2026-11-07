// npm run check <天数>：用 vitest 跑某一天的测试。
// 默认测你在 exercise/ 里写的代码，用本地 mock 模型，不需要 API Key。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `用法：
  npm run check <天数>                 用 mock 模型测你在 exercise/ 里写的代码
  npm run check <天数> -- --e2e        改用 .env 里配置的真实模型
  npm run check <天数> -- --solution   测参考答案
  npm run check all -- --solution      测所有天的参考答案（写课和 CI 用）`;

const OPENAI_ENV = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
// 第 8 天起还要用到 Anthropic 兼容接口
const ANTHROPIC_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];
const MODEL_ENV = [...OPENAI_ENV, ...ANTHROPIC_ENV];
// 第 17 天起还要用到 embedding 模型。地址和 Key 没填时沿用 OPENAI_*，模型名必须填
const EMBEDDING_ENV = ['EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL'];
// 联网搜索的 Key（第 12 天起）。测试用本地的假搜索服务，mock 模式下也不传给测试
const SEARCH_ENV = ['SEARCH_PROVIDER', 'TAVILY_API_KEY', 'BOCHA_API_KEY', 'BRAVE_API_KEY'];
// 可选的配置：便宜的模型（第 22 天起）、第二家模型（第 33 天起）、单价、Langfuse（第 34 天起）。不填时代码有退路
const OPTIONAL_ENV = ['CHEAP_MODEL', 'CHEAP_PRICE', 'ALT_BASE_URL', 'ALT_API_KEY', 'ALT_MODEL', 'ALT_PRICE', 'OPENAI_PRICE', 'LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'];
const root = join(import.meta.dirname, '..');

function exit(message: string): never {
  console.error(message);
  process.exit(1);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        e2e: { type: 'boolean', default: false },
        solution: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    exit(`${(error as Error).message}\n\n${USAGE}`);
  }
}

const { values, positionals } = parse();
const [day] = positionals;
if (!day) exit(USAGE);

const days = readdirSync(join(root, 'days'))
  .filter((name) => /^day\d{2}$/.test(name))
  .sort();
let filter: string | undefined; // 交给 vitest 的路径过滤；all 时不过滤，连 shared/ 里的测试一起跑
let label: string;
let needsAnthropic = true; // e2e 模式下要不要检查 ANTHROPIC_* 配置
let needsEmbedding = true; // e2e 模式下要不要检查 EMBEDDING_MODEL
if (day === 'all') {
  label = '所有天';
} else {
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 60) exit(`「${day}」不是 1 到 60 之间的天数\n\n${USAGE}`);
  const dir = `day${String(n).padStart(2, '0')}`;
  if (!days.includes(dir)) {
    exit(`第 ${n} 天的内容还没发布。目前有：${days.map((d) => `第 ${Number(d.slice(3))} 天`).join('、')}`);
  }
  filter = `days/${dir}/`;
  label = `第 ${n} 天`;
  needsAnthropic = n >= 8;
  needsEmbedding = n >= 17;
}

if (values.e2e) {
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const required = [...(needsAnthropic ? MODEL_ENV : OPENAI_ENV), ...(needsEmbedding ? ['EMBEDDING_MODEL'] : [])];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    exit(`e2e 模式要调用真实模型，但缺少这些配置：${missing.join('、')}\n先运行 cp .env.example .env，再把它们填好。`);
  }
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitest)) exit('还没有安装依赖，先运行 npm install');

const env: NodeJS.ProcessEnv = {
  ...process.env,
  CHECK_MODE: values.e2e ? 'e2e' : 'mock',
  CHECK_TARGET: values.solution ? 'solution' : 'exercise',
};
// mock 模式绝不碰真实接口：就算终端里设置了这些变量，也不传给测试
if (!values.e2e) for (const key of [...MODEL_ENV, ...EMBEDDING_ENV, ...SEARCH_ENV, ...OPTIONAL_ENV]) delete env[key];

const subject = values.solution ? '参考答案' : '练习';
const model = values.e2e ? `真实模型 ${process.env.OPENAI_MODEL}` : 'mock 模型';
console.log(`\n${label} · ${values.solution ? '参考答案' : '你的练习'} · ${model}\n`);

const result = spawnSync(process.execPath, [vitest, 'run', ...(filter ? [filter] : [])], {
  cwd: root,
  env,
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log(`\n✅ ${label}的${subject}全部通过`);
} else {
  const hints = ['看看上面的报错'];
  if (values.e2e) hints.push('真实模型每次的输出不一样，偶尔失败可以再跑一次确认');
  if (!values.solution && filter) hints.push(`实在卡住了，可以参考 ${filter}solution/`);
  console.log(`\n❌ 还有测试没通过。${hints.join('；')}`);
}
process.exit(result.status ?? 1);
