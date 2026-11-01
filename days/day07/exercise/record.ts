// 用真实模型跑一次 Agent，把每次调用的请求和回复录下来，存进 cassettes/ 目录，供回放测试使用。
// 用法：node days/day07/exercise/record.ts <录制的名字> "问题"
// 比如：node days/day07/exercise/record.ts calculator "计算 (1234 + 5678) * 9，再把结果写进 result.txt"
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.ts';
import { createOpenAIModel } from './openai.ts';
import { recordModel } from './testing/cassette.ts';
import { createTools } from './tools/index.ts';

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件时，就用终端里已经设置的环境变量
}
const [name, question] = process.argv.slice(2);
if (!name || !question || !/^[\w-]+$/.test(name)) {
  console.error('用法：node record.ts <录制的名字，只用字母、数字、- 和 _> "问题"');
  process.exit(1);
}

// 在一个空的临时目录里运行工具：回放时也用空目录，工具的结果才和录制时一样
const workspace = await mkdtemp(join(tmpdir(), 'record-'));
const recorder = recordModel(createOpenAIModel());
const result = await runAgent(question, { model: recorder, tools: createTools(workspace) });

const file = fileURLToPath(new URL(`./cassettes/${name}.json`, import.meta.url));
await recorder.save(file);
console.log(`状态：${result.status}，调用了 ${result.steps} 次模型`);
console.log(`回答：${result.answer}`);
console.log(`已保存到 ${file}`);
if (result.status !== 'completed') console.log('注意：这次运行没有正常完成，回放测试会以它为准');
