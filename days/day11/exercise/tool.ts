// 工具的定义和执行。每个工具用 zod 写参数的 schema：转成 JSON Schema 交给模型，执行前再用它校验参数。
// 第 11 天：出错时的信息要能引导模型自己改正：叫错了工具名，告诉它最像的是哪个；参数不对，把每个参数的要求列出来。
// 结果太长时分页，告诉模型怎么读下一页。
// 第 11 天的练习：TODO 1–3 在这里，TODO 4、5 在 tools/library.ts，TODO 6 在 bench.ts。检查：npm run check 11
import { z } from 'zod';
import type { ToolCall, ToolDefinition } from './types.ts';

// 参数校验的错误信息用中文，模型和人都好读
z.config(z.locales.zhCN());

/** 请用户确认的一次工具调用 */
export interface ApprovalRequest {
  tool: string;
  /** 已经通过校验的参数 */
  input: unknown;
  call: ToolCall;
}

/** 执行工具时可以用到的上下文 */
export interface ToolContext {
  /** 用户取消时触发，耗时的工具（比如网络请求）应该跟着停下 */
  signal?: AbortSignal;
  /** 执行有副作用的工具之前，问用户同不同意。没有提供时，一律当作不同意 */
  confirm?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface Tool<Input = any> {
  name: string;
  /** 写给模型看：这个工具能做什么、什么时候该用 */
  description: string;
  /** 参数的 schema */
  schema: z.ZodType<Input>;
  /** 执行工具，返回交给模型的结果。字符串原样交回，其他值转成 JSON */
  execute(input: Input, context: ToolContext): unknown;
  /** 执行之前要不要征得用户同意。可以按参数判断，比如 HTTP 请求只有 POST 才要（第 10 天） */
  requiresApproval?: boolean | ((input: Input) => boolean);
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
  // TODO 1：找出 candidates 里和 name 编辑距离最小的一个。
  // - 比较之前先统一格式：都转成小写，把 - 换成 _
  // - 最小的距离超过 max(1, name 长度的一半，向下取整) 时返回 undefined：差得太远的建议只会误导模型
  return undefined;
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
  // TODO 2：把参数要求列成几行，格式见上面的注释。
  // - 参数的 JSON Schema 用 toToolDefinition(tool).function.parameters 拿到：properties 是每个参数，required 是必填的参数名
  // - 类型用 typeName(property) 转成中文；没有 description 的参数，就不写冒号和说明
  return '';
}

/** 执行一个工具调用。不管出了什么问题都不抛出，而是把问题写成结果交回模型 */
export async function runToolCall(tools: Tool[], call: ToolCall, context: ToolContext = {}): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.function.name);
  if (!tool) {
    // TODO 1：叫错了名字，多半是拼写、大小写或者连字符的问题。用 closest 找出最像的工具，
    // 有的话在下面的信息里加上「你是不是想用 xxx？」
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
  if (!parsed.success) {
    // TODO 2：只说哪里错了还不够。在错误信息后面空一行，再附上「工具名 的参数：」和 describeParameters(tool)
    return failure(`参数不符合要求：\n${z.prettifyError(parsed.error)}`);
  }
  // 有副作用的工具，先问用户。放在校验之后：用户看到的是合法的参数，按参数判断要不要问也才可靠
  const needsApproval =
    typeof tool.requiresApproval === 'function' ? tool.requiresApproval(parsed.data) : tool.requiresApproval === true;
  if (needsApproval) {
    const approved = (await context.confirm?.({ tool: tool.name, input: parsed.data, call })) ?? false;
    if (!approved) return failure('用户没有同意执行这个操作。不要换个参数再试同样的操作，可以换个办法，或者问问用户');
  }
  try {
    const output = await tool.execute(parsed.data, context);
    if (output === undefined) return { content: '执行完成，没有返回内容', isError: false };
    return { content: typeof output === 'string' ? output : JSON.stringify(output), isError: false };
  } catch (error) {
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
  page: number;
  pages: number;
}

/**
 * 把长文本分页，每页最多 pageSize 个字符。和 truncate 不同，后面的内容没有丢掉，模型可以翻页接着读。
 * 尽量在换行处分页，不把一行切成两半；page 超出范围时抛出错误，说明一共有几页
 */
export function paginate(text: string, page: number, pageSize: number): Page {
  // TODO 3：分页。
  // - 先算出每一页从哪里开始：从 0 开始，剩下的内容超过 pageSize 时，在 pageSize 以内找最后一个换行，从换行后面开始下一页；
  //   找不到换行，或者换行在这一页的前一半（太靠前，这一页会很短），就在 pageSize 处硬切
  // - page 不是 1 到总页数之间的整数时，抛出错误「没有第 N 页，一共只有 M 页」
  // - 这一页的内容去掉末尾的空白。只有一页时原样返回；有多页时空一行再加上说明：
  //   不是最后一页：（第 1/3 页。用 page=2 读下一页）；最后一页：（第 3/3 页，已经是最后一页）
  return { content: text, page: 1, pages: 1 };
}

/** 结果太长时截断，并注明总长度，免得一个工具结果就塞满上下文 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n……（内容太长，只保留了前 ${maxChars} 个字符，共 ${text.length} 个字符）`;
}
