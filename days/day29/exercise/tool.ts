// 工具的定义和执行。每个工具用 zod 写参数的 schema：转成 JSON Schema 交给模型，执行前再用它校验参数。
// 第 11 天：出错时的信息要能引导模型自己改正：叫错了工具名，告诉它最像的是哪个；参数不对，把每个参数的要求列出来。
// 结果太长时分页，告诉模型怎么读下一页。
// 第 29 天：按风险分级，由权限策略决定允许、问用户还是禁止；没人可问时，返回一个「中断」，让 Agent 暂停，以后再接着跑。
import { z } from 'zod';
import { decide, riskOf, type PermissionPolicy, type Risk } from './permissions.ts';
import type { ToolCall, ToolDefinition } from './types.ts';

// 参数校验的错误信息用中文，模型和人都好读
z.config(z.locales.zhCN());

/** 请用户确认的一次工具调用 */
export interface ApprovalRequest {
  tool: string;
  /** 已经通过校验的参数 */
  input: unknown;
  call: ToolCall;
  /** 风险等级（第 29 天） */
  risk: Risk;
}

/**
 * 中断：工具调用要等用户（第 29 天）。两种：
 * - approval：要用户批准才能执行，但现在没人可问
 * - input：工具要用户回答一个问题（ask_user）
 */
export type Interrupt =
  | { kind: 'approval'; tool: string; input: unknown; risk: Risk }
  | { kind: 'input'; question: string; options?: string[] };

/** 工具在执行中途发现要等用户时抛出它，runToolCall 会把它变成一个带 interrupt 的结果 */
export class InterruptSignal extends Error {
  readonly interrupt: Interrupt;
  constructor(interrupt: Interrupt) {
    super('要等用户');
    this.interrupt = interrupt;
  }
}

/** 执行工具时可以用到的上下文 */
export interface ToolContext {
  /** 用户取消时触发，耗时的工具（比如网络请求）应该跟着停下 */
  signal?: AbortSignal;
  /** 执行有副作用的工具之前，问用户同不同意。没有提供时，一律当作不同意 */
  confirm?: (request: ApprovalRequest) => Promise<boolean>;
  /** 权限策略。有它就按风险等级决定允许、问用户还是禁止；没有就像以前一样，只看 requiresApproval（第 29 天） */
  policy?: PermissionPolicy;
  /** 用户在这次会话里说过「以后都可以」的工具（第 29 天） */
  grants?: ReadonlySet<string>;
  /** 要问用户、又没有 confirm 时，不当作不同意，而是返回中断，让 Agent 暂停（第 29 天） */
  pausable?: boolean;
  /** 问用户一个问题，等他回答。ask_user 工具用它；没有就只能暂停（第 29 天） */
  ask?: (question: string, options?: string[]) => Promise<string>;
}

export interface Tool<Input = any> {
  name: string;
  /** 写给模型看：这个工具能做什么、什么时候该用 */
  description: string;
  /** 参数的 schema */
  schema: z.ZodType<Input>;
  /**
   * 直接给出参数的 JSON Schema，不从 schema 转换。用在别人定义好的工具上，比如 MCP 服务器的工具（第 13 天）：
   * 它们只给了 JSON Schema，参数由服务器自己校验，这时 schema 只要求参数是个对象
   */
  parameters?: object;
  /** 执行工具，返回交给模型的结果。字符串原样交回，其他值转成 JSON */
  execute(input: Input, context: ToolContext): unknown;
  /** 执行之前要不要征得用户同意。可以按参数判断，比如 HTTP 请求只有 POST 才要（第 10 天） */
  requiresApproval?: boolean | ((input: Input) => boolean);
  /** 风险等级，可以按参数判断。不写时，requiresApproval 的算 write，其他的算 read（第 29 天） */
  risk?: Risk | ((input: Input) => Risk);
}

/** 工具执行的结果。出错也是一种结果：把错误告诉模型，它往往能自己换个办法 */
export interface ToolResult {
  content: string;
  isError: boolean;
  /** 这个调用在等用户，还没有真正的结果（第 29 天） */
  interrupt?: Interrupt;
}

/** 定义一个工具。写成函数是为了让 TypeScript 根据 schema 推导出 execute 参数的类型 */
export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

/** 把工具转成请求里的工具定义 */
export function toToolDefinition(tool: Tool): ToolDefinition {
  if (tool.parameters) return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
  // $schema 字段模型用不到，去掉。io: 'input' 按「模型要填的参数」来转换：有默认值的参数是可选的（第 11 天）
  const { $schema, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

const failure = (content: string): ToolResult => ({ content, isError: true });

/** 编辑距离：把 a 改成 b 最少要增、删、改几个字符 */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * 在 candidates 里找和 name 最像的一个，用来提示「你是不是想用……」。
 * 不区分大小写，把 - 当成 _；差得太远（编辑距离超过 name 长度的一半）就不提示，免得误导
 */
export function closest(name: string, candidates: string[]): string | undefined {
  const normalize = (text: string) => text.toLowerCase().replaceAll('-', '_');
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(normalize(name), normalize(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(1, Math.floor(name.length / 2)) ? best : undefined;
}

type JSONSchemaProperty = { type?: string | string[]; description?: string; enum?: unknown[]; anyOf?: JSONSchemaProperty[] };

/** 参数的类型，写成模型和人都好懂的样子：字符串、数字、'GET' 或 'POST'、字符串或 null…… */
function typeName(property: JSONSchemaProperty): string {
  if (property.enum) return property.enum.map((value) => JSON.stringify(value)).join(' 或 ');
  if (property.anyOf) return property.anyOf.map(typeName).join(' 或 ');
  const names: Record<string, string> = {
    string: '字符串',
    number: '数字',
    integer: '整数',
    boolean: '布尔值',
    array: '数组',
    object: '对象',
    null: 'null',
  };
  const types = Array.isArray(property.type) ? property.type : [property.type ?? '任意'];
  return types.map((type) => names[type] ?? type).join(' 或 ');
}

/**
 * 把工具的参数要求列成几行，附在校验失败的信息后面，模型照着就能改对：
 * - query（字符串，必填）：要搜索的关键词
 * - limit（整数，可选）：最多返回几条
 */
export function describeParameters(tool: Tool): string {
  const { parameters } = toToolDefinition(tool).function as {
    parameters: { properties?: Record<string, JSONSchemaProperty>; required?: string[] };
  };
  const required = new Set(parameters.required ?? []);
  return Object.entries(parameters.properties ?? {})
    .map(([name, property]) => {
      const description = property.description ? `：${property.description}` : '';
      return `- ${name}（${typeName(property)}，${required.has(name) ? '必填' : '可选'}）${description}`;
    })
    .join('\n');
}

/** 执行一个工具调用。不管出了什么问题都不抛出，而是把问题写成结果交回模型 */
export async function runToolCall(tools: Tool[], call: ToolCall, context: ToolContext = {}): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) {
    // 叫错了名字，多半是拼写、大小写或者连字符的问题。告诉模型最像的是哪个，它下一步就能改对
    const guess = closest(call.function.name, tools.map((t) => t.name));
    const hint = guess ? `你是不是想用 ${guess}？` : '';
    return failure(`没有名为 ${call.function.name} 的工具。${hint}可用的工具：${tools.map((t) => t.name).join('、')}`);
  }
  let input: unknown;
  try {
    // 没有参数的工具，有的模型会给一个空字符串
    input = JSON.parse(call.function.arguments || '{}');
  } catch {
    return failure(`参数不是合法的 JSON：${call.function.arguments}`);
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    // 只说哪里错了还不够：把每个参数的要求都列出来，模型对照着改一次就能对
    return failure(`参数不符合要求：\n${z.prettifyError(parsed.error)}\n\n${tool.name} 的参数：\n${describeParameters(tool)}`);
  }
  // 有副作用的工具，先问用户。放在校验之后：用户看到的是合法的参数，按参数判断要不要问也才可靠。
  // 有权限策略时按风险等级决定（第 29 天），没有就只看 requiresApproval
  const risk = riskOf(tool, parsed.data);
  // TODO 2（第 29 天的练习）：
  // - 有 context.policy 就用 decide(policy, tool, 参数, context.grants) 决定；没有就像以前一样：read 直接执行，其他的问用户
  // - deny：返回错误「权限策略不允许执行这个操作。不要换个参数再试，换个办法，或者告诉用户需要他自己来做」，也不用问用户
  // - ask：没有 confirm、但 context.pausable 为真：不执行，返回 { content: '', isError: false, interrupt: { kind: 'approval', tool, input, risk } }；
  //   否则像以前一样调用 confirm（请求里带上 risk），不同意就返回下面那条错误
  void decide;
  if (risk !== 'read') {
    const approved = (await context.confirm?.({ tool: tool.name, input: parsed.data, call, risk })) ?? false;
    if (!approved) return failure('用户没有同意执行这个操作。不要换个参数再试同样的操作，可以换个办法，或者问问用户');
  }
  return executeTool(tool, parsed.data, context);
}

/** 执行工具，不再检查权限。恢复暂停的运行时，用户已经批准过的调用直接用它执行（第 29 天） */
export async function executeTool(tool: Tool, input: unknown, context: ToolContext = {}): Promise<ToolResult> {
  try {
    const output = await tool.execute(input, context);
    if (output === undefined) return { content: '执行完成，没有返回内容', isError: false };
    return { content: typeof output === 'string' ? output : JSON.stringify(output), isError: false };
  } catch (error) {
    if (error instanceof InterruptSignal) return { content: '', isError: false, interrupt: error.interrupt };
    return failure(`工具执行出错：${(error as Error).message}`);
  }
}

/** 并行执行一轮里的所有工具调用，结果的顺序和调用的顺序一致。要用户确认的调用，确认请求可能同时发出，由 confirm 自己排队 */
export function runToolCalls(tools: Tool[], calls: ToolCall[], context: ToolContext = {}): Promise<ToolResult[]> {
  return Promise.all(calls.map((call) => runToolCall(tools, call, context)));
}

/** 分页的结果 */
export interface Page {
  /** 这一页的内容，末尾带着「第几页、怎么读下一页」的说明 */
  content: string;
  /** 只有这一页的内容，不带说明（第 12 天） */
  body: string;
  /** 说明，比如「（第 1/3 页。用 page=2 读下一页）」。只有一页时是空字符串（第 12 天） */
  footer: string;
  page: number;
  pages: number;
}

/**
 * 把长文本分页，每页最多 pageSize 个字符。和 truncate 不同，后面的内容没有丢掉，模型可以翻页接着读。
 * 尽量在换行处分页，不把一行切成两半；page 超出范围时抛出错误，说明一共有几页
 */
export function paginate(text: string, page: number, pageSize: number): Page {
  const starts = [0];
  while (text.length - starts.at(-1)! > pageSize) {
    const start = starts.at(-1)!;
    const newline = text.lastIndexOf('\n', start + pageSize);
    // 这一页里找不到换行（或者换行太靠前），只好硬切
    starts.push(newline > start + pageSize / 2 ? newline + 1 : start + pageSize);
  }
  const pages = starts.length;
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`没有第 ${page} 页，一共只有 ${pages} 页`);
  const body = text.slice(starts[page - 1], starts[page] ?? text.length).trimEnd();
  if (pages === 1) return { content: body, body, footer: '', page, pages };
  const footer = page < pages ? `（第 ${page}/${pages} 页。用 page=${page + 1} 读下一页）` : `（第 ${page}/${pages} 页，已经是最后一页）`;
  return { content: `${body}\n\n${footer}`, body, footer, page, pages };
}

/** 结果太长时截断，并注明总长度，免得一个工具结果就塞满上下文 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n……（内容太长，只保留了前 ${maxChars} 个字符，共 ${text.length} 个字符）`;
}
