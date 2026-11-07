// 第 23 天：规划。复杂的研究问题要查好几件事，一步一步摸索容易漏掉、走偏。先列计划，再照着做，做完一件勾一件。
// 两种做法：
// 1. 计划工具 update_plan：Agent 自己列计划、自己更新，用户随时看得到进度（像 Claude Code 的待办清单）
// 2. 先规划后执行 planAndExecute：代码按计划一步步执行，某一步失败了，让模型根据已有的结果重新规划剩下的步骤
import { z } from 'zod';
import { runAgent } from './agent.ts';
import { defineTool, type Tool } from './tool.ts';
import type { Model } from './types.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';

export const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface PlanStep {
  /** 这一步要做什么，比如「搜索潮汐协议 3.0 的性能数据」 */
  content: string;
  status: StepStatus;
  /** 补充说明。失败的步骤要写清楚为什么失败 */
  note?: string;
}

/** 一份计划最多几步。太长的计划多半拆得太细，模型维护它的成本比做事还高 */
export const MAX_PLAN_STEPS = 10;

/**
 * 检查一份计划，返回发现的问题（每条一句话），没有问题就是空数组：
 * - 至少 1 步，最多 MAX_PLAN_STEPS 步
 * - 每一步都要写内容
 * - 同一时间最多只有一步在进行（in_progress）：一次专心做一件事，用户也知道它在做什么
 * - 失败的步骤要在 note 里写原因：重新规划时要靠它
 */
export function validatePlan(steps: PlanStep[]): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push('计划里至少要有 1 步');
  if (steps.length > MAX_PLAN_STEPS) problems.push(`计划最多 ${MAX_PLAN_STEPS} 步，现在有 ${steps.length} 步。把相近的步骤合并`);
  steps.forEach((step, i) => {
    if (!step.content.trim()) problems.push(`第 ${i + 1} 步没有写要做什么`);
    if (step.status === 'failed' && !step.note?.trim()) problems.push(`第 ${i + 1} 步失败了，要在 note 里写明原因`);
  });
  const active = steps.filter((s) => s.status === 'in_progress').length;
  if (active > 1) problems.push(`同时只能有一步在进行，现在有 ${active} 步是 in_progress`);
  return problems;
}

const MARKS: Record<StepStatus, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]', failed: '[!]' };

/**
 * 把计划排成给人和模型看的样子：
 *   [x] 搜索发布说明
 *   [>] 打开性能测试报告
 *   [!] 查官方定价（网页打不开）
 *   [ ] 汇总
 *   进度：1/4
 * 进度只数完成的步骤；失败的步骤后面用括号写上原因
 */
export function formatPlan(steps: PlanStep[]): string {
  const lines = steps.map((step) => `${MARKS[step.status]} ${step.content}${step.status === 'failed' && step.note ? `（${step.note}）` : ''}`);
  const done = steps.filter((s) => s.status === 'completed').length;
  return [...lines, `进度：${done}/${steps.length}`].join('\n');
}

/** 当前的计划。一次会话共用一个，命令行用它显示进度 */
export interface PlanBoard {
  readonly steps: PlanStep[];
  /** 换成新的计划（整份替换）。返回发现的问题，有问题就不替换 */
  update(steps: PlanStep[]): string[];
  clear(): void;
}

export function createPlanBoard(onChange?: (steps: PlanStep[]) => void): PlanBoard {
  let current: PlanStep[] = [];
  return {
    get steps() {
      return current;
    },
    update(steps) {
      const problems = validatePlan(steps);
      if (problems.length) return problems;
      current = steps.map((s) => ({ ...s }));
      onChange?.(current);
      return [];
    },
    clear() {
      current = [];
    },
  };
}

const stepSchema = z.object({
  content: z.string().describe('这一步要做什么，一句话'),
  status: z.enum(STEP_STATUSES).describe('pending 还没做，in_progress 正在做，completed 做完了，failed 做不成'),
  note: z.string().optional().describe('补充说明。failed 时必须写原因'),
});

/**
 * update_plan：Agent 用它列出和更新计划。每次都传完整的计划，而不是「把第 2 步标成完成」：
 * 整份替换不会出现编号对不上的问题，模型每次重写一遍，也是在提醒自己还剩什么
 */
export function createPlanTool(board: PlanBoard): Tool {
  return defineTool({
    name: 'update_plan',
    description:
      '列出或更新研究计划。问题要查三件以上的事时，先用它列出计划，再一步步做。每次传完整的计划（不只是改动的那一步）：' +
      '开始做某一步时标成 in_progress，做完标成 completed；做不成标成 failed，在 note 里写原因，并加上替代的步骤',
    schema: z.object({ steps: z.array(stepSchema).describe('完整的计划，按顺序') }),
    execute({ steps }) {
      const problems = board.update(steps);
      if (problems.length) throw new Error(`计划没有更新：\n${problems.map((p) => `- ${p}`).join('\n')}`);
      const failed = steps.filter((s) => s.status === 'failed');
      const next = steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status === 'pending');
      let hint: string;
      if (!next) hint = '计划里的步骤都处理完了，可以写最终的回答了。';
      else hint = `接下来：${next.content}`;
      if (failed.length && steps.every((s) => s.status !== 'pending' && s.status !== 'in_progress')) {
        hint += '有步骤失败了：如果还有别的办法，加上替代的步骤；没有，就在回答里说明哪些没查到。';
      }
      return `计划已更新：\n${formatPlan(steps)}\n${hint}`;
    },
  });
}

// ---------- 先规划后执行 ----------

export const PLANNER_PROMPT = `你负责为一个研究问题制定计划。只输出 JSON，格式是 {"steps": ["第一步", "第二步"]}，不要别的文字。
- 每一步是一件能独立完成的事，比如「查潮汐协议 3.0 的发布说明，找出默认端口」
- 2 到 5 步；不要写「汇总」「写回答」这样的步骤，程序最后会汇总
- 后面的步骤可以用到前面步骤的结果`;

export const REPLANNER_PROMPT = `你负责在执行出问题时调整研究计划。用户消息里有：问题、已经完成的步骤和结果、失败的步骤和原因、原来剩下的步骤。
只输出 JSON，格式是 {"steps": ["……"]}，列出接下来要做的步骤（替换原来剩下的步骤），不要别的文字。
- 不要原样重复失败的步骤，换一个办法，比如换一个来源、换一种查法
- 已经完成的不用再做
- 剩下的信息已经够回答问题了，或者确实没有别的办法了，就输出 {"steps": []}`;

/** 解析模型给的步骤：{"steps": [...]}，去掉空的，最多 max 步。格式不对返回 undefined */
export function parseSteps(text: string, max = 5): string[] | undefined {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const steps = (JSON.parse(json) as { steps?: unknown }).steps;
    if (!Array.isArray(steps) || !steps.every((s) => typeof s === 'string')) return undefined;
    return steps.map((s) => s.trim()).filter(Boolean).slice(0, max);
  } catch {
    return undefined;
  }
}

/** 一步执行的结果 */
export interface StepOutcome {
  ok: boolean;
  /** 成功时是这一步的结果，失败时是原因 */
  output: string;
  usage?: Usage;
}

export interface CompletedStep {
  step: string;
  output: string;
}

export interface PlanExecuteOptions {
  /** 制定计划、重新规划用的模型 */
  planner: Model;
  /** 执行一步。done 是前面已经完成的步骤和结果 */
  execute: (step: string, context: { question: string; done: CompletedStep[] }) => Promise<StepOutcome>;
  /** 用全部的结果回答问题 */
  synthesize: (question: string, done: CompletedStep[]) => Promise<{ answer: string; usage?: Usage }>;
  /** 最多重新规划几次，默认 2 */
  maxReplans?: number;
  /** 最多执行几步（包括失败的），默认 8 */
  maxSteps?: number;
  /** 计划每变一次（开始做某一步、做完、失败、重新规划）就回调一次，用来给用户看进度 */
  onPlan?: (steps: PlanStep[]) => void;
  signal?: AbortSignal;
}

export interface PlanExecuteResult {
  answer: string;
  /** 最后的计划：执行过的步骤（完成的、失败的），加上没来得及做的 */
  plan: PlanStep[];
  done: CompletedStep[];
  replans: number;
  /** 没有正常走完时的原因：重新规划的次数或者步数用完了 */
  stopped?: 'max_replans' | 'max_steps';
  usage: Usage;
}

async function askForSteps(model: Model, system: string, content: string, signal?: AbortSignal) {
  const result = await model.chat(
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    },
    { signal },
  );
  return { steps: parseSteps(result.message.content ?? ''), usage: result.usage };
}

/** 重新规划时交给模型的内容 */
export function describeProgress(question: string, done: CompletedStep[], failed: { step: string; reason: string }, remaining: string[]): string {
  const doneText = done.length ? done.map((d, i) => `${i + 1}. ${d.step}\n结果：${d.output}`).join('\n\n') : '（还没有）';
  const remainingText = remaining.length ? remaining.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（没有了）';
  return `问题：${question}\n\n已经完成的步骤：\n${doneText}\n\n失败的步骤：${failed.step}\n原因：${failed.reason}\n\n原来剩下的步骤：\n${remainingText}`;
}

/**
 * 先规划后执行：制定计划，按顺序执行每一步；某一步失败了，让模型根据已有的结果重新规划剩下的步骤，最后汇总。
 * - 计划解析不了：把问题本身当作唯一的一步
 * - 重新规划的结果解析不了：保留原来剩下的步骤
 * - 重新规划的次数、执行的步数用完了：不再往下做，用已有的结果汇总，并在 stopped 里注明
 */
export async function planAndExecute(question: string, options: PlanExecuteOptions): Promise<PlanExecuteResult> {
  const { planner, execute, synthesize, maxReplans = 2, maxSteps = 8, onPlan, signal } = options;
  let usage = emptyUsage();
  const planned = await askForSteps(planner, PLANNER_PROMPT, question, signal);
  usage = addUsage(usage, planned.usage);
  let pending = planned.steps?.length ? planned.steps : [question];
  const history: PlanStep[] = []; // 执行过的步骤
  const done: CompletedStep[] = [];
  let replans = 0;
  let stopped: PlanExecuteResult['stopped'];
  const view = (current?: string): PlanStep[] => [
    ...history,
    ...(current ? [{ content: current, status: 'in_progress' as const }] : []),
    ...pending.map((content) => ({ content, status: 'pending' as const })),
  ];
  onPlan?.(view());

  while (pending.length > 0) {
    if (history.length >= maxSteps) {
      stopped = 'max_steps';
      break;
    }
    const step = pending.shift()!;
    onPlan?.(view(step));
    const outcome = await execute(step, { question, done: [...done] });
    if (outcome.usage) usage = addUsage(usage, outcome.usage);
    if (outcome.ok) {
      history.push({ content: step, status: 'completed' });
      done.push({ step, output: outcome.output });
      onPlan?.(view());
      continue;
    }
    history.push({ content: step, status: 'failed', note: outcome.output });
    if (replans >= maxReplans) {
      onPlan?.(view());
      stopped = 'max_replans';
      break;
    }
    replans++;
    const replanned = await askForSteps(planner, REPLANNER_PROMPT, describeProgress(question, done, { step, reason: outcome.output }, pending), signal);
    usage = addUsage(usage, replanned.usage);
    if (replanned.steps) pending = replanned.steps;
    onPlan?.(view());
  }

  const synthesized = await synthesize(question, done);
  if (synthesized.usage) usage = addUsage(usage, synthesized.usage);
  return { answer: synthesized.answer, plan: view(), done, replans, stopped, usage };
}

// ---------- 用研究助手的工具执行每一步 ----------

export const STEP_PROMPT = `你是研究助手的执行者，一次只做计划里的一步。用工具查资料，完成这一步就停下，不要做计划里的其他步骤。
- 来自网页和文档的信息，在句子后面用 [编号] 标明来源，编号用工具结果里给的
- 结果写得精简：只写这一步查到的事实和来源编号，不用客套
- 这一步做不成（比如找不到资料、网页打不开），回答的第一行写「失败：原因」，不要编造结果`;

export const SYNTHESIZE_PROMPT = `你是研究助手。根据用户消息里各个步骤查到的结果，回答问题。
- 只用这些结果里的信息，保留结果里的 [编号] 引用，写在句子末尾
- 有的步骤没有查到，就说明哪些信息没有查到，不要猜
- 不用在最后列出来源，程序会自动附上
- 用中文回答，先给结论，再给依据`;

/** 用 runAgent 执行一步：带上问题和前面的结果，用研究助手的工具。回答以「失败」开头，或者 Agent 没有正常完成，都算失败 */
export function createStepExecutor(model: Model, tools: Tool[], maxSteps = 8): PlanExecuteOptions['execute'] {
  return async (step, { question, done }) => {
    const context = done.length ? `\n\n前面的步骤已经查到：\n${done.map((d) => `- ${d.step}：${d.output}`).join('\n')}` : '';
    const result = await runAgent(`研究的问题：${question}${context}\n\n现在要做的这一步：${step}`, { model, tools, system: STEP_PROMPT, maxSteps });
    const answer = result.answer.trim();
    if (result.status !== 'completed') return { ok: false, output: `没有完成（${result.status}）`, usage: result.usage };
    if (/^失败[:：]/.test(answer)) return { ok: false, output: answer.replace(/^失败[:：]\s*/, '').split('\n')[0], usage: result.usage };
    return { ok: true, output: answer, usage: result.usage };
  };
}

/** 用模型汇总各个步骤的结果 */
export function createSynthesizer(model: Model): PlanExecuteOptions['synthesize'] {
  return async (question, done) => {
    const results = done.length ? done.map((d, i) => `## 步骤 ${i + 1}：${d.step}\n${d.output}`).join('\n\n') : '（没有一个步骤成功）';
    const result = await model.chat({
      messages: [
        { role: 'system', content: SYNTHESIZE_PROMPT },
        { role: 'user', content: `各个步骤的结果：\n\n${results}\n\n问题：${question}` },
      ],
    });
    return { answer: result.message.content ?? '', usage: result.usage };
  };
}

/** 执行一步时不该用的工具：计划由代码管，不让执行者再列计划 */
export function stepTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => t.name !== 'update_plan');
}
