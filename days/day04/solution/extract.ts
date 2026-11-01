// 第 4 天：从一段杂乱的文本里提取结构化信息，校验失败就把错误交回模型修正。
// 三种做法：JSON 模式（json_object）、工具调用（tool）、JSON Schema 约束（json_schema）。
// 直接运行：node days/day04/solution/extract.ts [json_object|tool|json_schema] [样例编号 0-2]
import { z } from 'zod';
import { samples } from '../samples.ts';
import { JobPosting } from './job.ts';
import { chat } from './openai.ts';
import type { AssistantMessage, ChatRequest, Message } from './types.ts';
import { addUsage, emptyUsage, formatUsage, parsePrice, type Usage } from './usage.ts';

// 校验失败的提示用中文：交回模型、打印出来都好读
z.config(z.locales.zhCN());

export type Mode = 'json_object' | 'tool' | 'json_schema';
export const MODES: Mode[] = ['json_object', 'tool', 'json_schema'];

export interface ExtractOptions {
  mode: Mode;
  /** 最多调用几次模型。第一次之后的每一次，都是把错误交回模型让它修正 */
  maxAttempts?: number;
}

export interface ExtractResult<T> {
  data: T;
  /** 一共调用了几次模型 */
  attempts: number;
  usage: Usage;
}

/** 调用了 maxAttempts 次，输出还是不符合要求 */
export class ExtractError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = 'ExtractError';
    this.attempts = attempts;
  }
}

/** 工具调用的做法里，让模型「调用」这个工具来提交结果 */
export const TOOL_NAME = 'save_result';

const TASK = '从用户给出的文本里提取信息。文本里没有提到、并且允许为 null 的字段填 null，不要编造。';

/** zod schema 转成 JSON Schema，去掉 $schema 字段：模型和接口都用不到它 */
export function toJSONSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** 按做法拼出第一次请求 */
export function buildRequest(schema: z.ZodType, text: string, mode: Mode): ChatRequest {
  const jsonSchema = toJSONSchema(schema);
  if (mode === 'json_object') {
    // JSON 模式只保证输出是合法的 JSON，字段要靠提示词说明。提示词里还必须出现 json 这个词
    const system = `${TASK}\n只输出一个 JSON 对象，不要输出别的内容。JSON 要符合这个 JSON Schema：\n${JSON.stringify(jsonSchema)}`;
    return {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      responseFormat: { type: 'json_object' },
    };
  }
  if (mode === 'json_schema') {
    // schema 直接交给接口，由接口约束模型的输出
    return {
      messages: [
        { role: 'system', content: TASK },
        { role: 'user', content: text },
      ],
      responseFormat: { type: 'json_schema', json_schema: { name: 'extraction', schema: jsonSchema, strict: true } },
    };
  }
  // 工具调用：schema 写进工具的参数，模型「调用」工具时生成的参数就是我们要的结果
  return {
    messages: [
      { role: 'system', content: `${TASK}\n提取完成后，调用 ${TOOL_NAME} 工具提交结果。` },
      { role: 'user', content: text },
    ],
    tools: [{ type: 'function', function: { name: TOOL_NAME, description: '提交提取出的信息', parameters: jsonSchema } }],
  };
}

/** 从回复里取出模型输出的 JSON 文本：工具调用的做法看工具参数，另外两种看 content */
export function readOutput(message: AssistantMessage, mode: Mode): string | undefined {
  if (mode === 'tool') return message.tool_calls?.find((call) => call.function.name === TOOL_NAME)?.function.arguments;
  return message.content ?? undefined;
}

/** 解析 JSON。模型有时会用 ```json 代码块把 JSON 包起来，先去掉 */
export function parseJSON(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return JSON.parse(fenced ? fenced[1] : text);
}

type Checked<T> = { ok: true; data: T } | { ok: false; problem: string };

/** 检查模型的输出：有没有、是不是合法的 JSON、符不符合 schema */
function check<T>(schema: z.ZodType<T>, output: string | undefined, mode: Mode): Checked<T> {
  if (output === undefined || output.trim() === '') {
    return { ok: false, problem: mode === 'tool' ? `没有调用 ${TOOL_NAME} 工具。请调用它提交结果。` : '回复是空的。请输出 JSON。' };
  }
  let value: unknown;
  try {
    value = parseJSON(output);
  } catch (error) {
    return { ok: false, problem: `输出不是合法的 JSON（${(error as Error).message}）。请只输出一个完整的 JSON 对象。` };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, problem: `输出没有通过校验，请修正后重新输出：\n${z.prettifyError(parsed.error)}` };
}

/** 把问题告诉模型。工具调用的做法要用 tool 消息回应每一个工具调用，另外两种用 user 消息 */
function feedback(reply: AssistantMessage, problem: string): Message[] {
  if (!reply.tool_calls?.length) return [{ role: 'user', content: problem }];
  return reply.tool_calls.map((call) => ({
    role: 'tool',
    tool_call_id: call.id,
    content: call.function.name === TOOL_NAME ? problem : `没有 ${call.function.name} 这个工具，请调用 ${TOOL_NAME}。`,
  }));
}

/** 从 text 里提取符合 schema 的数据。输出不合格时，把问题交回模型，最多调用 maxAttempts 次 */
export async function extract<T>(schema: z.ZodType<T>, text: string, options: ExtractOptions): Promise<ExtractResult<T>> {
  const { mode, maxAttempts = 3 } = options;
  const request = buildRequest(schema, text, mode);
  let usage = emptyUsage();
  let problem = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await chat(request);
    usage = addUsage(usage, result.usage);
    const checked = check(schema, readOutput(result.message, mode), mode);
    if (checked.ok) return { data: checked.data, attempts: attempt, usage };
    // 把模型的回复和问题都放进历史，下一次它能看到自己错在哪
    problem = checked.problem;
    request.messages.push(result.message, ...feedback(result.message, problem));
  }
  throw new ExtractError(`调用了 ${maxAttempts} 次模型，输出还是不符合要求：\n${problem}`, maxAttempts);
}

// 直接运行这个文件时：从一则样例招聘启事里提取信息
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const mode = (process.argv[2] ?? 'json_object') as Mode;
  const sample = samples[Number(process.argv[3] ?? 0)];
  if (!MODES.includes(mode) || !sample) {
    console.error(`用法：node extract.ts [${MODES.join('|')}] [样例编号 0-${samples.length - 1}]`);
    process.exit(1);
  }
  console.log(`原文：\n${sample}\n`);
  const result = await extract(JobPosting, sample, { mode });
  console.log(JSON.stringify(result.data, null, 2));
  console.log(`\n调用 ${result.attempts} 次模型 · ${formatUsage(result.usage, parsePrice(process.env.OPENAI_PRICE))}`);
}
