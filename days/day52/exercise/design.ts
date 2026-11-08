// 第 52 天：设计文档里能用程序检查的部分。
//   工具清单：每个工具的风险等级（第 29 天）、碰到哪几类东西（私有数据、不可信内容、外传渠道，第 37 天的致命三要素）、要不要人确认
//   成本估算：Agent 每一步都把整段历史重新发一遍，输入 token 随步数累加；提示缓存能省下多少（第 36 天）
// 设计文档本身是给人看的 Markdown（templates/design.md），末尾一段 ```json 是这里检查的内容。
// 第 52 天的练习：TODO 1–3 在这里。检查：npm run check 52
import { z } from 'zod';

export const CAPABILITIES = ['private-data', 'untrusted-content', 'external-send'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ToolSpecSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, '工具名用小写字母、数字和下划线'),
  /** 给模型看的描述：什么时候用、返回什么 */
  description: z.string().min(1),
  /** read：只读；write：有副作用但能撤销；irreversible：发出去、删掉、付了钱，撤不回来（第 29 天） */
  risk: z.enum(['read', 'write', 'irreversible']),
  /** 这个工具碰到哪几类东西：读私有数据、把不可信的内容带进上下文、能把数据发到外面 */
  touches: z.array(z.enum(CAPABILITIES)).default([]),
  /** 要不要人确认：never 不用；first-time 第一次问；always 每次都问 */
  approval: z.enum(['never', 'first-time', 'always']).default('never'),
});

export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const DesignSchema = z.strictObject({
  name: z.string().min(1),
  /** workflow：固定流程；agent：模型决定下一步；hybrid：流程里嵌着 Agent（第 21 天） */
  mode: z.enum(['workflow', 'agent', 'hybrid']),
  tools: z.array(ToolSpecSchema),
  /** Agent 最多走几步 */
  maxSteps: z.int().positive(),
  /** 成本估算的参数（见下面的 CostInput），加上每天大概几次任务 */
  estimate: z
    .strictObject({
      steps: z.int().positive(),
      systemTokens: z.number().min(0),
      toolTokens: z.number().min(0),
      userTokens: z.number().min(0),
      outputPerStep: z.number().min(0),
      resultPerStep: z.number().min(0),
      cacheHitRate: z.number().min(0).max(1),
      price: z.strictObject({ input: z.number().min(0), cachedInput: z.number().min(0).optional(), output: z.number().min(0) }),
      tasksPerDay: z.number().min(0),
    })
    .optional(),
});

export type Design = z.infer<typeof DesignSchema>;

/** 从设计文档里取出第一个 ```json 代码块，用 DesignSchema 校验 */
export function extractDesign(markdown: string): Design {
  const match = /```json[^\n]*\n([\s\S]*?)```/.exec(markdown);
  if (!match) throw new Error('没有找到 ```json 代码块：设计文档里要有一段给程序检查的 JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`json 代码块不是合法的 JSON：${(error as Error).message}`);
  }
  const parsed = DesignSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`设计文档的字段不对：${issue.path.join('.') || '（整个对象）'}：${issue.message}`);
  }
  return parsed.data;
}

export interface Trifecta {
  privateData: string[];
  untrusted: string[];
  externalSend: string[];
}

/**
 * 致命三要素（TODO 1）：分别列出碰到私有数据、不可信内容、外传渠道的工具名（按工具清单的顺序）。
 * 三类都有工具时返回这三个列表；缺任何一类返回 null。
 * 注意三类可以来自不同的工具：读邮件的工具带进了不可信内容，发请求的工具负责外传，合起来就是一条完整的攻击路径
 */
export function findTrifecta(tools: ToolSpec[]): Trifecta | null {
  // TODO 1：分别找出 touches 里有 private-data、untrusted-content、external-send 的工具名，三类都不是空的才返回，否则 null
  void tools;
  return null;
}

export interface Finding {
  level: 'error' | 'warn';
  rule: string;
  message: string;
}

/** 工具多于这个数，模型就容易选错（第 28 天） */
export const MAX_TOOLS = 12;
/** 描述短于这个字数，多半没写清楚什么时候用、返回什么（第 11 天） */
export const MIN_DESCRIPTION = 15;

/**
 * 审一遍设计（TODO 2），按下面的顺序返回发现的问题：
 * 1. 工具名重复：error，rule 是 duplicate-tool，「工具名重复：x」（每个名字报一次）
 * 2. 致命三要素：rule 是 lethal-trifecta，消息「同时具备致命三要素：私有数据（a、b）、不可信内容（c）、外传渠道（d）」，
 *    外传的工具都是 approval: always 时是 warn，消息后面加「。外传的工具每次都要人确认：确认时把要发出去的内容完整给人看」；
 *    否则是 error，消息后面加「。去掉其中一类，或者让外传的工具每次都要人确认」
 * 3. 每个不可逆、但不是 always 的工具：error，irreversible-approval，「x 是不可逆的，要每次都确认（approval: always）」
 * 4. 有工具会带进不可信内容时，每个 write 而且 approval 是 never 的工具：warn，write-unattended，
 *    「x 会写东西、不用确认，而 Agent 会读到不可信的内容：确认它被骗了也不要紧」
 * 5. 每个描述短于 MIN_DESCRIPTION 个字的工具：warn，short-description，「x 的描述太短：写清楚什么时候用、返回什么」
 * 6. mode 不是 workflow、工具多于 MAX_TOOLS 个：warn，too-many-tools，「n 个工具太多了：考虑按需检索工具，或者拆给子 Agent」
 */
export function reviewDesign(design: Design): Finding[] {
  // TODO 2：按上面注释的六条依次检查，把发现的问题放进数组。
  // 第 2 条用 findTrifecta；「外传的工具都是 always」指 touches 里有 external-send 的每一个工具。
  // 描述的长度用 [...description].length 数字数（不是 UTF-16 的长度）
  void findTrifecta; void MAX_TOOLS; void MIN_DESCRIPTION; void design;
  return [];
}

export interface CostInput {
  /** 一次任务调用几次模型 */
  steps: number;
  /** system prompt 的 token */
  systemTokens: number;
  /** 工具定义的 token：每次请求都要带上 */
  toolTokens: number;
  /** 用户的输入（问题、diff、文档）的 token */
  userTokens: number;
  /** 每一步模型输出多少（思考、工具调用、回答） */
  outputPerStep: number;
  /** 每一步工具结果有多少，会追加进历史 */
  resultPerStep: number;
  /** 上一次请求的内容有多大比例能命中缓存，0–1（第 36 天） */
  cacheHitRate: number;
  /** 单价，元/百万 token（第 2 天） */
  price: { input: number; cachedInput?: number; output: number };
}

export interface CostEstimate {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** 一次任务的花费，元 */
  cost: number;
  perStep: { step: number; inputTokens: number; cachedTokens: number }[];
}

/**
 * 估算一次任务的成本（TODO 3）。Agent 每一步都把之前的全部历史重新发一遍：
 * - 第 i 步（从 1 开始）的输入 = system + 工具定义 + 用户输入 + (i − 1) × (每步的输出 + 每步的工具结果)
 * - 第 1 步没有缓存；之后每一步，上一步的输入里有 cacheHitRate 这么多能命中缓存：round(上一步的输入 × cacheHitRate)
 * - 输出 = steps × 每步的输出
 * - 成本 = (没命中的输入 × input + 命中的 × cachedInput（没给就按 input）+ 输出 × output) / 1_000_000
 * 输入随步数线性增长，总输入就随步数平方增长：步数翻倍，输入差不多翻四倍
 */
export function estimateCost(input: CostInput): CostEstimate {
  // TODO 3：一步一步算出每一步的 inputTokens、cachedTokens（记住上一步的输入），再加总、算成本。
  // 别忘了第 1 步没有缓存，cachedInput 没给时按 input 的价格算
  void input;
  throw new Error('TODO 3：还没有实现 estimateCost');
}

/** 一个月的花费：每次的花费 × 每天几次 × 天数 */
export function monthlyCost(costPerTask: number, tasksPerDay: number, days = 30): number {
  return costPerTask * tasksPerDay * days;
}

const RISK_LABEL = { read: '只读', write: '可写', irreversible: '不可逆' } as const;
const CAP_LABEL = { 'private-data': '私有数据', 'untrusted-content': '不可信内容', 'external-send': '外传' } as const;
const APPROVAL_LABEL = { never: '不用', 'first-time': '第一次', always: '每次' } as const;

/** 工具清单的表格，贴进设计文档 */
export function renderToolTable(tools: ToolSpec[]): string {
  const lines = ['| 工具 | 风险 | 碰到 | 确认 | 描述 |', '|---|---|---|---|---|'];
  for (const t of tools) lines.push(`| \`${t.name}\` | ${RISK_LABEL[t.risk]} | ${t.touches.map((c) => CAP_LABEL[c]).join('、') || '—'} | ${APPROVAL_LABEL[t.approval]} | ${t.description} |`);
  return lines.join('\n');
}
