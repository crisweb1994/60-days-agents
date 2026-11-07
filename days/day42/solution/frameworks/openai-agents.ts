// 第 41 天：用 OpenAI Agents SDK 重写 mini-agent。
// 它的抽象比 AI SDK 高一层：Agent（名字、指令、模型、工具）+ Runner（循环）+ 交接（handoffs）+ 护栏（guardrails）+ 会话 + 追踪。
// 用国产模型要注意三件事：
//   1. 它默认走 OpenAI 的 Responses API，国产模型大多只有 Chat Completions，要用 OpenAIChatCompletionsModel
//   2. 它默认把 trace 发到 OpenAI 的平台，要关掉（setTracingDisabled），或者换成自己的 exporter
//   3. 工具参数默认是 strict 模式，可选的参数要写成 nullable；我们的工具直接给 JSON Schema、关掉 strict
// 运行：node days/day41/solution/frameworks/openai-agents.ts "算一下 (17 + 25) * 3"
import { Agent, MaxTurnsExceededError, OpenAIChatCompletionsModel, run, setTracingDisabled, tool, type FunctionTool, type RunResult } from '@openai/agents';
import OpenAI from 'openai';
import { SYSTEM_PROMPT } from '../agent.ts';
import { openAIConfigFromEnv, type OpenAIConfig } from '../openai.ts';
import { toToolDefinition, type Tool } from '../tool.ts';
import { emptyUsage, type Usage } from '../usage.ts';
import { executeChecked, type FrameworkResult, type FrameworkRunner, type RunInput } from './common.ts';
import { safeParse } from './common.ts';

/** 用 Chat Completions 接口的模型。同时关掉默认的追踪：不要把对话发到 OpenAI 的平台 */
export function createAgentsModel(config: OpenAIConfig = openAIConfigFromEnv()): OpenAIChatCompletionsModel {
  setTracingDisabled(true);
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  return new OpenAIChatCompletionsModel(client as unknown as ConstructorParameters<typeof OpenAIChatCompletionsModel>[0], config.model);
}

/** 非 strict 的参数 schema。类型上要求 additionalProperties 是 true，实际上 SDK 原样交给模型 */
type NonStrictSchema = Parameters<typeof tool<any, undefined, unknown>>[0]['parameters'];

/**
 * 我们的工具换成 Agents SDK 的工具：参数直接给 JSON Schema、strict 关掉；needsApproval 对应 requiresApproval；
 * execute 交给 executeChecked（先校验参数，审批已经由 SDK 做过了）。SDK 交给 execute 的参数已经是解析好的对象
 */
export function toAgentsTools(tools: Tool[]): FunctionTool[] {
  return tools.map((t) => {
    const approval = t.requiresApproval;
    return tool({
      name: t.name,
      description: t.description,
      parameters: toToolDefinition(t).function.parameters as NonStrictSchema,
      strict: false,
      needsApproval: async (_context, input) => (typeof approval === 'function' ? approval(input) : Boolean(approval)),
      execute: async (input) => (await executeChecked(t, input, { confirm: async () => true })).content,
    }) as unknown as FunctionTool;
  });
}

/** Agents SDK 的用量。缓存和思考的 token 按每次请求记在 details 数组里，加起来 */
function usageOf(result: RunResult<any, any>): { usage: Usage; requests: number } {
  const u = result.state.usage;
  const sum = (items: Record<string, number>[] | undefined, key: string) => (items ?? []).reduce((s, d) => s + (d?.[key] ?? 0), 0);
  return {
    usage: {
      inputTokens: u.inputTokens,
      cachedTokens: sum(u.inputTokensDetails as Record<string, number>[], 'cached_tokens'),
      outputTokens: u.outputTokens,
      reasoningTokens: sum(u.outputTokensDetails as Record<string, number>[], 'reasoning_tokens'),
    },
    requests: u.requests,
  };
}

/**
 * 用 Agents SDK 跑 mini-agent。run() 一直循环到模型给出最终回答；maxTurns 是最多调用几次模型，超了抛出 MaxTurnsExceededError。
 * 遇到要审批的工具，run() 返回时带着 interruptions：逐个问用户，state.approve / state.reject，再用 state 接着 run()。
 * 恢复时的 maxTurns 是剩下的步数；用量从 state 里读，它在几次 run() 之间是累计的
 */
export async function runWithAgentsSDK(model: OpenAIChatCompletionsModel, input: RunInput): Promise<FrameworkResult> {
  const { question, tools, system = SYSTEM_PROMPT, maxSteps = 10, confirm, signal } = input;
  const agent = new Agent({ name: 'mini-agent', instructions: system, model, tools: toAgentsTools(tools) });
  const toolCalls: FrameworkResult['toolCalls'] = [];
  const collect = (r: RunResult<any, any>) => {
    for (const item of r.newItems) {
      if (item.type === 'tool_call_item' && item.rawItem.type === 'function_call') toolCalls.push({ name: item.rawItem.name, arguments: safeParse(item.rawItem.arguments) });
    }
  };
  let usage = emptyUsage();
  let steps = 0;
  try {
    let result = await run(agent, question, { maxTurns: maxSteps, signal });
    for (;;) {
      ({ usage, requests: steps } = usageOf(result));
      collect(result);
      if (!result.interruptions?.length) {
        return { framework: 'openai-agents', status: 'completed', answer: String(result.finalOutput ?? ''), steps, toolCalls, usage };
      }
      for (const interruption of result.interruptions) {
        const approved = confirm ? await confirm({ tool: interruption.name ?? '', input: safeParse(String(interruption.arguments ?? '')) }) : false;
        if (approved) result.state.approve(interruption);
        else result.state.reject(interruption);
      }
      result = await run(agent, result.state, { maxTurns: maxSteps, signal });
    }
  } catch (error) {
    if (error instanceof MaxTurnsExceededError) return { framework: 'openai-agents', status: 'max_steps', answer: '', steps: Math.max(steps, maxSteps), toolCalls, usage };
    throw error;
  }
}

export function agentsSdkRunner(model: OpenAIChatCompletionsModel): FrameworkRunner {
  return (input) => runWithAgentsSDK(model, input);
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
  const r = await runWithAgentsSDK(createAgentsModel(), {
    question: process.argv.slice(2).join(' ') || '算一下 (17 + 25) * 3',
    tools: createTools(resolve(process.env.AGENT_WORKSPACE ?? 'workspace')),
    confirm: async ({ tool: name, input }) => (await rl.question(`允许执行 ${name} ${JSON.stringify(input)}？(y/N) `)).trim().toLowerCase() === 'y',
  });
  rl.close();
  console.log(`${r.answer}\n\n（${r.status}，${r.steps} 步，${formatUsage(r.usage)}）`);
}
