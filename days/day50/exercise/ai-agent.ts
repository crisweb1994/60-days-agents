// 第 42 天：用 AI SDK 自己的循环跑研究助手：ToolLoopAgent、工具审批、结构化输出。
// ai-model.ts 只把 AI SDK 当作「发请求的那一层」，循环还是我们的；这里反过来，循环交给 AI SDK，
// 我们的东西从外面接进去：工具仍然是 createResearchTools 组装的那一套（注入防护、白名单、大结果写文件都包在里面），
// 权限策略（第 29 天）变成 AI SDK 的 toolApproval，来源登记和引用检查（第 20 天）在循环结束以后照样做。
// 两种做法对比着看：哪些能力跟着工具走（换了循环也还在），哪些长在循环里（换了循环就要重新接）。
import { generateText, jsonSchema, NoObjectGeneratedError, Output, tool, ToolLoopAgent, type LanguageModel, type ModelMessage, type ToolApprovalStatus, type ToolSet } from 'ai';
import { z } from 'zod';
import { appendReferences, checkCitations, type CitationReport } from './citations.ts';
import { formatQuestion } from './context.ts';
import { DEEP_PLAN_PROMPT, MAX_SUBQUESTIONS, type ResearchPlan } from './deep-research.ts';
import { fromAISDKUsage } from './frameworks/ai-sdk.ts';
import { executeChecked } from './frameworks/common.ts';
import { sanitizeAnswer } from './injection.ts';
import { decide, DEFAULT_POLICY, type PermissionPolicy } from './permissions.ts';
import { dateSection, RESEARCH_PROMPT } from './prompts.ts';
import { createResearchTools, type ResearchSetup } from './research.ts';
import { toToolDefinition, type ApprovalRequest, type Tool } from './tool.ts';
import { addUsage, emptyUsage, type Usage } from './usage.ts';

// ---------- 结构化输出：规划 ----------

export const PlanSchema = z.object({
  steps: z.array(z.string().trim().min(1)).min(1).describe('可以同时、独立调研的子问题'),
});

/**
 * 第 30 天的规划，用 AI SDK 的结构化输出来做：Output.object 把 zod schema 转成 response_format，
 * 回复由它解析、校验，r.output 就是对象。模型给的不合格（解析不了、不符合 schema）会抛出 NoObjectGeneratedError，
 * 这时和第 30 天一样退回成「问题本身就是唯一的子问题」。最多 MAX_SUBQUESTIONS 个
 */
export async function planWithAISDK(question: string, model: LanguageModel, signal?: AbortSignal): Promise<{ plan: ResearchPlan; usage: Usage }> {
  try {
    const r = await generateText({ model, instructions: DEEP_PLAN_PROMPT, prompt: question, output: Output.object({ schema: PlanSchema, name: 'research_plan' }), abortSignal: signal });
    return { plan: { question, subquestions: r.output.steps.slice(0, MAX_SUBQUESTIONS), fallback: false }, usage: fromAISDKUsage(r.totalUsage) };
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    return { plan: { question, subquestions: [question], fallback: true }, usage: error.usage ? fromAISDKUsage(error.usage) : emptyUsage() };
  }
}

// ---------- 工具和审批 ----------

/**
 * 研究助手的工具换成 AI SDK 的工具。和第 41 天不同的是 execute 的上下文：要把用户的 confirm 传进去。
 * 注入防护（第 37 天）在工具里面，遇到不明的网址会用 confirm 问用户；这里不能替用户回答「同意」
 */
export function toResearchToolSet(tools: Tool[], confirm?: (request: ApprovalRequest) => Promise<boolean>): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema<unknown>(toToolDefinition(t).function.parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown, { abortSignal, toolCallId }) =>
        (await executeChecked(t, input, { signal: abortSignal, confirm, call: { id: toolCallId, type: 'function', function: { name: t.name, arguments: JSON.stringify(input) } } })).content,
    });
  }
  return set;
}

/**
 * 第 29 天的权限策略换成 AI SDK 的 toolApproval：allow → 不用审批；ask → 要用户审批；deny → 直接拒绝，原因交给模型。
 * 叫错名字的工具不在这里管（not-applicable），AI SDK 会把错误交回模型
 */
export function approvalFromPolicy(tools: Tool[], policy: PermissionPolicy = DEFAULT_POLICY) {
  return ({ toolCall }: { toolCall: { toolName: string; input: unknown } }): ToolApprovalStatus => {
    const t = tools.find((x) => x.name === toolCall.toolName);
    if (!t) return 'not-applicable';
    const decision = decide(policy, t, toolCall.input);
    if (decision === 'allow') return 'not-applicable';
    if (decision === 'ask') return 'user-approval';
    return { type: 'denied', reason: '权限策略不允许执行这个操作。不要换个参数再试，换个办法，或者告诉用户需要他自己来做' };
  };
}

// ---------- 研究 ----------

export interface AIResearchOptions {
  model: LanguageModel;
  policy?: PermissionPolicy;
  /** 要审批的工具调用问用户；注入防护遇到不明的网址也问它。不传就一律拒绝 */
  confirm?: (request: Pick<ApprovalRequest, 'tool' | 'input'>) => Promise<boolean>;
  /** 最多调用几次模型，默认 15 */
  maxSteps?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface AIResearchResult {
  status: 'completed' | 'max_steps';
  answer: string;
  /** 回答加上来源列表 */
  text: string;
  report: CitationReport;
  steps: number;
  toolCalls: { name: string; arguments: unknown }[];
  usage: Usage;
}

/**
 * 用 ToolLoopAgent 跑研究助手：
 * - 工具：createResearchTools(setup) 组装的那一套，用 toResearchToolSet 转换；审批：approvalFromPolicy
 * - 问题前面带上日期（第 15 天的 formatQuestion），system prompt 是 RESEARCH_PROMPT
 * - 循环和第 41 天一样：generate → 有审批请求就问 confirm、把答复放进 tool 消息 → 再 generate；步数累计，用完了是 max_steps
 * - 最后照第 37、20 天的做法：清理回答里不明来源的链接，检查引用，附上来源列表
 */
export async function aiResearch(question: string, setup: ResearchSetup, options: AIResearchOptions): Promise<AIResearchResult> {
  const { model, policy, confirm, maxSteps = 15, now = () => new Date(), signal } = options;
  const { tools, sources, guard } = createResearchTools(setup);
  guard?.trustText(question);
  const fullConfirm = confirm ? (r: ApprovalRequest) => confirm({ tool: r.tool, input: r.input }) : undefined;
  let steps = 0; // 之前几次 generate 用掉的步数
  const agent = new ToolLoopAgent({
    model,
    instructions: RESEARCH_PROMPT,
    tools: toResearchToolSet(tools, fullConfirm),
    toolApproval: approvalFromPolicy(tools, policy),
    // 停止条件只看得到这一次 generate 的步数，加上之前用掉的，才是总步数
    stopWhen: ({ steps: current }) => steps + current.length >= maxSteps,
    maxRetries: 0,
  });
  const messages: ModelMessage[] = [{ role: 'user', content: formatQuestion([dateSection(now())], question) }];
  const toolCalls: AIResearchResult['toolCalls'] = [];
  let usage = emptyUsage();
  for (;;) {
    const r = await agent.generate({ messages, abortSignal: signal });
    steps += r.steps.length;
    usage = addUsage(usage, fromAISDKUsage(r.totalUsage));
    for (const step of r.steps) for (const call of step.toolCalls) toolCalls.push({ name: call.toolName, arguments: call.input });
    messages.push(...r.responseMessages);
    const approvals = r.content.filter((part) => part.type === 'tool-approval-request');
    if (!approvals.length || steps >= maxSteps) {
      const status = approvals.length || r.finishReason === 'tool-calls' ? 'max_steps' : 'completed';
      const answer = guard ? sanitizeAnswer(r.text, sources).text : r.text;
      const report = checkCitations(answer, sources, { researched: toolCalls.length > 0 });
      return { status, answer, text: appendReferences(answer, report.cited), report, steps, toolCalls, usage };
    }
    const responses = [];
    for (const request of approvals) {
      const approved = confirm ? await confirm({ tool: request.toolCall.toolName, input: request.toolCall.input }) : false;
      responses.push({ type: 'tool-approval-response' as const, approvalId: request.approvalId, approved, ...(approved ? {} : { reason: '用户没有同意' }) });
    }
    messages.push({ role: 'tool', content: responses });
  }
}
