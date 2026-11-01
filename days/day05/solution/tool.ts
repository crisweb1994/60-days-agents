// 工具的定义和执行。每个工具用 zod 写参数的 schema：转成 JSON Schema 交给模型，执行前再用它校验参数。
import { z } from 'zod';
import type { ToolCall, ToolDefinition } from './types.ts';

// 参数校验的错误信息用中文，模型和人都好读
z.config(z.locales.zhCN());

/** 执行工具时可以用到的上下文 */
export interface ToolContext {
  /** 用户取消时触发，耗时的工具（比如网络请求）应该跟着停下 */
  signal?: AbortSignal;
}

export interface Tool<Input = any> {
  name: string;
  /** 写给模型看：这个工具能做什么、什么时候该用 */
  description: string;
  /** 参数的 schema */
  schema: z.ZodType<Input>;
  /** 执行工具，返回交给模型的结果。字符串原样交回，其他值转成 JSON */
  execute(input: Input, context: ToolContext): unknown;
}

/** 工具执行的结果。出错也是一种结果：把错误告诉模型，它往往能自己换个办法 */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** 定义一个工具。写成函数是为了让 TypeScript 根据 schema 推导出 execute 参数的类型 */
export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

/** 把工具转成请求里的工具定义 */
export function toToolDefinition(tool: Tool): ToolDefinition {
  // $schema 字段模型用不到，去掉
  const { $schema, ...parameters } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

const failure = (content: string): ToolResult => ({ content, isError: true });

/** 执行一个工具调用。不管出了什么问题都不抛出，而是把问题写成结果交回模型 */
export async function runToolCall(tools: Tool[], call: ToolCall, context: ToolContext = {}): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) {
    return failure(`没有名为 ${call.function.name} 的工具。可用的工具：${tools.map((t) => t.name).join('、')}`);
  }
  let input: unknown;
  try {
    // 没有参数的工具，有的模型会给一个空字符串
    input = JSON.parse(call.function.arguments || '{}');
  } catch {
    return failure(`参数不是合法的 JSON：${call.function.arguments}`);
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return failure(`参数不符合要求：\n${z.prettifyError(parsed.error)}`);
  try {
    const output = await tool.execute(parsed.data, context);
    if (output === undefined) return { content: '执行完成，没有返回内容', isError: false };
    return { content: typeof output === 'string' ? output : JSON.stringify(output), isError: false };
  } catch (error) {
    return failure(`工具执行出错：${(error as Error).message}`);
  }
}

/** 并行执行一轮里的所有工具调用，结果的顺序和调用的顺序一致 */
export function runToolCalls(tools: Tool[], calls: ToolCall[], context: ToolContext = {}): Promise<ToolResult[]> {
  return Promise.all(calls.map((call) => runToolCall(tools, call, context)));
}

/** 结果太长时截断，并注明总长度，免得一个工具结果就塞满上下文 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n……（内容太长，只保留了前 ${maxChars} 个字符，共 ${text.length} 个字符）`;
}
