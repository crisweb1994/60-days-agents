// 第 41 天：几种实现共用的接口。同一个 mini-agent，分别用手写的循环、Vercel AI SDK、OpenAI Agents SDK 实现，
// 都包成 FrameworkRunner：给一个问题和一组工具，交回同样形状的结果，才能用同一组任务比较。
import { runAgent } from '../agent.ts';
import { z } from 'zod';
import { describeParameters, executeTool, type ApprovalRequest, type Tool, type ToolContext, type ToolResult } from '../tool.ts';
import type { Model } from '../types.ts';
import type { Usage } from '../usage.ts';

export interface RunInput {
  question: string;
  tools: Tool[];
  system?: string;
  /** 最多调用几次模型，默认 10 */
  maxSteps?: number;
  /** 有副作用的工具执行前问用户。不传就一律拒绝 */
  confirm?: (request: Pick<ApprovalRequest, 'tool' | 'input'>) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface FrameworkResult {
  framework: string;
  /** completed：给出了回答；max_steps：步数用完了；其他手写循环的状态原样保留 */
  status: string;
  answer: string;
  /** 调用了几次模型 */
  steps: number;
  /** 按顺序执行过（或者被拒绝）的工具调用 */
  toolCalls: { name: string; arguments: unknown }[];
  usage: Usage;
}

export type FrameworkRunner = (input: RunInput) => Promise<FrameworkResult>;

/** 第 1–10 天手写的循环，包成同样的接口，作为比较的基准 */
export function handwrittenRunner(model: Model): FrameworkRunner {
  return async ({ question, tools, system, maxSteps = 10, confirm, signal }) => {
    const toolCalls: FrameworkResult['toolCalls'] = [];
    const r = await runAgent(question, {
      model,
      tools,
      system,
      maxSteps,
      signal,
      confirm: confirm ? (req) => confirm({ tool: req.tool, input: req.input }) : undefined,
      onToolCall: (call) => toolCalls.push({ name: call.function.name, arguments: safeParse(call.function.arguments) }),
    });
    return { framework: 'handwritten', status: r.status, answer: r.answer, steps: r.steps, toolCalls, usage: r.usage };
  };
}

/**
 * 交给框架的工具执行函数：先用工具自己的 zod schema 校验参数（框架拿到的只是 JSON Schema，不一定校验），
 * 不对就把每个参数的要求交回模型（第 11 天）；对了再交给 executeTool 执行、捕获错误
 */
export async function executeChecked(tool: Tool, input: unknown, context: ToolContext = {}): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { content: `参数不符合要求：\n${z.prettifyError(parsed.error)}\n\n${tool.name} 的参数：\n${describeParameters(tool)}`, isError: true };
  return executeTool(tool, parsed.data, context);
}

export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
