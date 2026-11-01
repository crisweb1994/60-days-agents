// 第 4 天：从一段杂乱的文本里提取结构化信息，校验失败就把错误交回模型修正。
// 三种做法：JSON 模式（json_object）、工具调用（tool）、JSON Schema 约束（json_schema）。
// 直接运行：node days/day04/exercise/extract.ts [json_object|tool|json_schema] [样例编号 0-2]
// 第 4 天的练习：先去 job.ts 完成 TODO 1，再完成这里的 TODO 2–5。检查：npm run check 4
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
  // TODO 2：按三种做法拼出请求。先用 toJSONSchema(schema) 得到 JSON Schema。
  // 三种做法的 messages 都是一条 system（任务说明，可以用 TASK）加一条 user（原文 text）。
  // - json_object：responseFormat 设为 { type: 'json_object' }。JSON 模式只保证输出是 JSON，
  //   所以要在 system 里写明「只输出一个 JSON 对象」，再附上 JSON.stringify(jsonSchema)。
  //   提示词里必须出现 json 这个词，不然接口会报错
  // - json_schema：responseFormat 设为 { type: 'json_schema', json_schema: { name, schema, strict: true } }，
  //   name 随便起一个，比如 'extraction'
  // - tool：定义一个名为 TOOL_NAME 的工具，parameters 就是 jsonSchema；在 system 里告诉模型提取完调用它
  throw new Error('TODO 2：还没有拼出请求');
}

/** 从回复里取出模型输出的 JSON 文本：工具调用的做法看工具参数，另外两种看 content */
export function readOutput(message: AssistantMessage, mode: Mode): string | undefined {
  // TODO 3（上）：tool 做法返回名为 TOOL_NAME 的工具调用的 arguments，没有就返回 undefined；
  // 另外两种返回 message.content（null 时返回 undefined）
  throw new Error('TODO 3：还没有实现 readOutput()');
}

/** 解析 JSON。模型有时会用 ```json 代码块把 JSON 包起来，先去掉 */
export function parseJSON(text: string): unknown {
  // TODO 3（下）：如果 text 是 ```json … ``` 或 ``` … ``` 包起来的，先取出中间的部分，再 JSON.parse
  return JSON.parse(text);
}

type Checked<T> = { ok: true; data: T } | { ok: false; problem: string };

/** 检查模型的输出：有没有、是不是合法的 JSON、符不符合 schema */
function check<T>(schema: z.ZodType<T>, output: string | undefined, mode: Mode): Checked<T> {
  // TODO 4：依次检查，有问题就返回 { ok: false, problem: 交给模型看的说明 }，都没问题返回 { ok: true, data }。
  // - output 是 undefined 或空白：tool 做法说明「没有调用 TOOL_NAME 工具，请调用它提交结果」，另外两种说明回复是空的
  // - parseJSON 抛错：说明输出不是合法的 JSON，带上错误信息
  // - schema.safeParse(value) 不通过：用 z.prettifyError(result.error) 把错误整理成文字，告诉模型哪里不对
  throw new Error('TODO 4：还没有实现 check()');
}

/** 把问题告诉模型。工具调用的做法要用 tool 消息回应每一个工具调用，另外两种用 user 消息 */
function feedback(reply: AssistantMessage, problem: string): Message[] {
  // TODO 5（上）：
  // - reply 里没有工具调用：返回一条 user 消息，内容是 problem
  // - 有工具调用：每个工具调用都要有一条 tool 消息回应，tool_call_id 和调用的 id 对上。
  //   名为 TOOL_NAME 的那个回应 problem；其他的告诉模型没有这个工具
  throw new Error('TODO 5：还没有实现 feedback()');
}

/** 从 text 里提取符合 schema 的数据。输出不合格时，把问题交回模型，最多调用 maxAttempts 次 */
export async function extract<T>(schema: z.ZodType<T>, text: string, options: ExtractOptions): Promise<ExtractResult<T>> {
  const { mode, maxAttempts = 3 } = options;
  const request = buildRequest(schema, text, mode);
  // TODO 5（下）：最多循环 maxAttempts 次：
  // - 用 chat(request) 调用模型，累加用量（addUsage）
  // - 用 readOutput 取出输出，交给 check 检查。通过就返回 { data, attempts: 第几次, usage }
  // - 不通过：把模型的回复和 feedback() 生成的消息都追加到 request.messages，下一次模型就能看到自己错在哪
  // 次数用完还不行，抛出 ExtractError，错误信息里带上最后一次的问题
  throw new Error('TODO 5：还没有实现 extract()');
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
