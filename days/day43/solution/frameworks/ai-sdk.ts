// 第 41 天：用 Vercel AI SDK 重写 mini-agent。
// AI SDK 替你做了：各家接口的适配（provider）、工具的 schema 转换和参数校验、多步的工具循环（stopWhen）、
// 流式输出、结构化输出、工具审批（needsApproval）。对照第 2–8 天手写的那些，代码少了很多。
// 它没有替你做的：重复调用和连续出错的护栏（第 6 天）、按风险的权限策略（第 29 天）、注入防护（第 37 天）、预算（第 36 天）。
// 运行：node days/day41/solution/frameworks/ai-sdk.ts "算一下 (17 + 25) * 3"
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
  return {
    inputTokens: usage.inputTokens ?? 0,
    cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

/**
 * 把我们的工具换成 AI SDK 的工具：
 * - inputSchema 用 jsonSchema() 包住 toToolDefinition 生成的 JSON Schema：MCP 工具只有 JSON Schema，zod 的也一样转，两种统一
 * - needsApproval 对应 requiresApproval（可以是函数，按参数判断）
 * - execute 交给 executeChecked（common.ts）：先用工具自己的 zod schema 校验参数，再交给第 5 天的 executeTool 执行、捕获错误、把结果转成字符串。
 *   审批已经由 AI SDK 做过了，所以 confirm 直接回答同意
 */
export function toAISDKTools(tools: Tool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    const approval = t.requiresApproval;
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema<unknown>(toToolDefinition(t).function.parameters as Parameters<typeof jsonSchema>[0]),
      needsApproval: typeof approval === 'function' ? (input: unknown) => approval(input) : Boolean(approval),
      execute: async (input: unknown, { abortSignal }) => (await executeChecked(t, input, { signal: abortSignal, confirm: async () => true })).content,
    });
  }
  return set;
}

/**
 * 用 AI SDK 跑 mini-agent。generateText 自己会循环：调用模型 → 执行工具 → 再调用模型，直到模型不再调用工具或者到了 stopWhen。
 * 遇到要审批的工具，它停下来，把 tool-approval-request 交给我们：
 *   问用户（confirm）→ 把每个请求的 tool-approval-response 放进一条 tool 消息 → 带着历史再调用一次 generateText，它会先执行批准了的工具
 * 步数在几次 generateText 之间累计；用完了还停在工具调用上，status 是 max_steps
 */
export async function runWithAISDK(model: LanguageModel, input: RunInput): Promise<FrameworkResult> {
  const { question, tools, system = SYSTEM_PROMPT, maxSteps = 10, confirm, signal } = input;
  const aiTools = toAISDKTools(tools);
  const messages: ModelMessage[] = [{ role: 'user', content: question }];
  const toolCalls: FrameworkResult['toolCalls'] = [];
  let usage = emptyUsage();
  let steps = 0;
  for (;;) {
    const r = await generateText({ model, instructions: system, messages, tools: aiTools, stopWhen: stepCountIs(maxSteps - steps), abortSignal: signal });
    steps += r.steps.length;
    usage = addUsage(usage, fromAISDKUsage(r.totalUsage));
    for (const step of r.steps) for (const call of step.toolCalls) toolCalls.push({ name: call.toolName, arguments: call.input });
    messages.push(...r.responseMessages);
    const approvals = r.content.filter((part) => part.type === 'tool-approval-request');
    const result = (status: string): FrameworkResult => ({ framework: 'ai-sdk', status, answer: r.text, steps, toolCalls, usage });
    if (!approvals.length) return result(r.finishReason === 'tool-calls' ? 'max_steps' : 'completed');
    if (steps >= maxSteps) return result('max_steps');
    const responses = [];
    for (const request of approvals) {
      const approved = confirm ? await confirm({ tool: request.toolCall.toolName, input: request.toolCall.input }) : false;
      responses.push({ type: 'tool-approval-response' as const, approvalId: request.approvalId, approved, ...(approved ? {} : { reason: '用户没有同意' }) });
    }
    messages.push({ role: 'tool', content: responses });
  }
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
