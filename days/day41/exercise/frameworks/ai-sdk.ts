// 第 41 天：用 Vercel AI SDK 重写 mini-agent。
// AI SDK 替你做了：各家接口的适配（provider）、工具的 schema 转换和参数校验、多步的工具循环（stopWhen）、
// 流式输出、结构化输出、工具审批（needsApproval）。对照第 2–8 天手写的那些，代码少了很多。
// 它没有替你做的：重复调用和连续出错的护栏（第 6 天）、按风险的权限策略（第 29 天）、注入防护（第 37 天）、预算（第 36 天）。
// 第 41 天的练习：TODO 1、2 在这里，TODO 3、4 在 openai-agents.ts，TODO 5 在 compare.ts。检查：npm run check 41
// 运行：node days/day41/exercise/frameworks/ai-sdk.ts "算一下 (17 + 25) * 3"
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai';
import { SYSTEM_PROMPT } from '../agent.ts';
import { openAIConfigFromEnv, type OpenAIConfig } from '../openai.ts';
import { toToolDefinition, type Tool } from '../tool.ts';
import { addUsage, emptyUsage, type Usage } from '../usage.ts';
import { executeChecked, type FrameworkResult, type FrameworkRunner, type RunInput } from './common.ts';

/**
 * 用 OpenAI 兼容接口创建 AI SDK 的模型。国产模型、本地 Ollama 都走这一个 provider；
 * includeUsage 让流式返回也带上用量（第 3 天的 stream_options）
 */
export function createAISDKModel(config: OpenAIConfig = openAIConfigFromEnv()): LanguageModel {
  const provider = createOpenAICompatible({ name: 'openai-compatible', baseURL: config.baseURL, apiKey: config.apiKey, includeUsage: true });
  return provider.chatModel(config.model);
}

/** AI SDK 的用量换成我们的 Usage。缓存命中和思考 token 在 details 里，可能没有 */
export function fromAISDKUsage(usage: LanguageModelUsage): Usage {
  // TODO 1（一）：inputTokens、outputTokens 直接对应；缓存命中在 inputTokenDetails.cacheReadTokens，思考在 outputTokenDetails.reasoningTokens。没有的都算 0
  void usage;
  return emptyUsage();
}

/**
 * 把我们的工具换成 AI SDK 的工具：
 * - inputSchema 用 jsonSchema() 包住 toToolDefinition 生成的 JSON Schema：MCP 工具只有 JSON Schema，zod 的也一样转，两种统一
 * - needsApproval 对应 requiresApproval（可以是函数，按参数判断）
 * - execute 交给 executeChecked（common.ts）：先用工具自己的 zod schema 校验参数，再交给第 5 天的 executeTool 执行、捕获错误、把结果转成字符串。
 *   审批已经由 AI SDK 做过了，所以 confirm 直接回答同意
 */
export function toAISDKTools(tools: Tool[]): ToolSet {
  // TODO 1（二）：每个工具用 AI SDK 的 tool() 包一个，放进 set[工具名]：
  // - description 原样；inputSchema 用 jsonSchema() 包住 toToolDefinition(t).function.parameters
  // - needsApproval：requiresApproval 是函数就包一层传进去，否则转成 boolean
  // - execute(input, { abortSignal })：交给 executeChecked（先校验参数再执行），context 里 signal 是 abortSignal、confirm 直接回答 true，返回结果的 content
  void tool;
  void jsonSchema;
  void executeChecked;
  void toToolDefinition;
  void tools;
  return {};
}

/**
 * 用 AI SDK 跑 mini-agent。generateText 自己会循环：调用模型 → 执行工具 → 再调用模型，直到模型不再调用工具或者到了 stopWhen。
 * 遇到要审批的工具，它停下来，把 tool-approval-request 交给我们：
 *   问用户（confirm）→ 把每个请求的 tool-approval-response 放进一条 tool 消息 → 带着历史再调用一次 generateText，它会先执行批准了的工具
 * 步数在几次 generateText 之间累计；用完了还停在工具调用上，status 是 max_steps
 */
export async function runWithAISDK(model: LanguageModel, input: RunInput): Promise<FrameworkResult> {
  // TODO 2：按上面注释的步骤写一个循环：
  // - 每轮 generateText({ model, instructions: system, messages, tools, stopWhen: stepCountIs(剩下的步数), abortSignal })
  // - steps 加上 r.steps.length；usage 加上 fromAISDKUsage(r.totalUsage)；每一步的 toolCalls 记下 toolName 和 input；r.responseMessages 接到 messages 后面
  // - r.content 里没有 type 为 tool-approval-request 的：finishReason 是 tool-calls 就是 max_steps，否则 completed
  // - 有审批请求但步数用完了：max_steps
  // - 否则逐个 confirm（没有 confirm 就是拒绝），每个都做成 { type: 'tool-approval-response', approvalId, approved }，放进一条 role 为 tool 的消息，接着循环
  void generateText;
  void stepCountIs;
  void addUsage;
  void toAISDKTools;
  const { question, system = SYSTEM_PROMPT, maxSteps = 10, confirm, signal } = input;
  void question; void system; void maxSteps; void confirm; void signal; void model;
  const messages: ModelMessage[] = [];
  void messages;
  throw new Error('TODO 2：还没有实现 runWithAISDK');
}

/** 包成和别的实现一样的接口 */
export function aiSdkRunner(model: LanguageModel): FrameworkRunner {
  return (input) => runWithAISDK(model, input);
}

if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const { resolve } = await import('node:path');
  const { createInterface } = await import('node:readline/promises');
  const { createTools } = await import('../tools/index.ts');
  const { formatUsage } = await import('../usage.ts');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const r = await runWithAISDK(createAISDKModel(), {
    question: process.argv.slice(2).join(' ') || '算一下 (17 + 25) * 3',
    tools: createTools(resolve(process.env.AGENT_WORKSPACE ?? 'workspace')),
    confirm: async ({ tool: name, input }) => (await rl.question(`允许执行 ${name} ${JSON.stringify(input)}？(y/N) `)).trim().toLowerCase() === 'y',
  });
  rl.close();
  console.log(`${r.answer}\n\n（${r.status}，${r.steps} 步，${formatUsage(r.usage)}）`);
}
