// 工具的定义和执行。每个工具用 zod 写参数的 schema：转成 JSON Schema 交给模型，执行前再用它校验参数。
// 第 5 天的练习：先完成这里的 TODO 1–3，再去 tools/ 目录完成 TODO 4–6。检查：npm run check 5
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
  // TODO 1：返回 { type: 'function', function: { name, description, parameters } }。
  // parameters 用 z.toJSONSchema(tool.schema) 转换，再去掉模型用不到的 $schema 字段
  throw new Error('TODO 1：还没有实现 toToolDefinition()');
}

const failure = (content: string): ToolResult => ({ content, isError: true });

/** 执行一个工具调用。不管出了什么问题都不抛出，而是把问题写成结果交回模型 */
export async function runToolCall(tools: Tool[], call: ToolCall, context: ToolContext = {}): Promise<ToolResult> {
  // TODO 2：按顺序检查，任何一步出问题都返回 failure(说明)，不要抛出：
  // 1. 按 call.function.name 找到工具。找不到：说明没有这个工具，并列出可用的工具名
  // 2. JSON.parse(call.function.arguments) 解析参数。没有参数的工具，有的模型会给空字符串，当成 '{}'。
  //    解析失败：说明参数不是合法的 JSON
  // 3. tool.schema.safeParse 校验参数。不通过：用 z.prettifyError 说明哪里不对，并且不要执行工具
  // 4. await tool.execute(参数, context)。抛出错误：说明工具执行出错，带上错误信息
  // 5. 执行成功：字符串原样作为 content，undefined 写一句「执行完成」，其他值用 JSON.stringify 转换
  throw new Error('TODO 2：还没有实现 runToolCall()');
}

/** 并行执行一轮里的所有工具调用，结果的顺序和调用的顺序一致 */
export async function runToolCalls(tools: Tool[], calls: ToolCall[], context: ToolContext = {}): Promise<ToolResult[]> {
  // TODO 3：现在是一个接一个地执行。改成同时执行（提示：Promise.all），结果的顺序要和 calls 一致
  const results: ToolResult[] = [];
  for (const call of calls) results.push(await runToolCall(tools, call, context));
  return results;
}

/** 结果太长时截断，并注明总长度，免得一个工具结果就塞满上下文 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n……（内容太长，只保留了前 ${maxChars} 个字符，共 ${text.length} 个字符）`;
}
