// 第 5 天：Agent 换上四个通用工具，同一轮里的多个工具调用并行执行。
// 直接运行：node days/day05/solution/agent.ts "算一下 1234 * 5678，把结果写进 result.txt"
// 读写文件都在当前目录下的 workspace/ 里（可以用环境变量 AGENT_WORKSPACE 换一个目录）。
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatStream } from './openai.ts';
import { runToolCalls, toToolDefinition, type Tool, type ToolResult } from './tool.ts';
import { createTools } from './tools/index.ts';
import type { Message, ToolCall } from './types.ts';
import { addUsage, emptyUsage, formatUsage, parsePrice, type Usage } from './usage.ts';

const SYSTEM_PROMPT = '你是一个能使用工具的助手。能用工具得到准确结果时就用工具，不要猜。';

export interface AgentOptions {
  tools: Tool[];
  maxSteps?: number;
  onUsage?: (usage: Usage) => void;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** 每个工具执行完回调一次，用来显示 Agent 做了什么 */
  onToolCall?: (call: ToolCall, result: ToolResult) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  answer: string;
  usage: Usage;
}

export async function runAgent(question: string, options: AgentOptions): Promise<AgentResult> {
  const { tools, maxSteps = 10, onUsage, onText, onReasoning, onToolCall, signal } = options;
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const definitions = tools.map(toToolDefinition);
  let usage = emptyUsage();
  for (let step = 0; step < maxSteps; step++) {
    const result = await chatStream({ messages, tools: definitions }, { onText, onReasoning, signal });
    usage = addUsage(usage, result.usage);
    onUsage?.(result.usage);
    const reply = result.message;
    messages.push(reply);
    if (!reply.tool_calls?.length) return { answer: reply.content ?? '', usage };
    // 同一轮的工具调用一起执行；出错的调用也有结果，交回模型让它决定下一步
    const results = await runToolCalls(tools, reply.tool_calls, { signal });
    reply.tool_calls.forEach((call, i) => {
      onToolCall?.(call, results[i]);
      messages.push({ role: 'tool', tool_call_id: call.id, content: results[i].content });
    });
  }
  throw new Error(`走了 ${maxSteps} 步还没有给出最终回答`);
}

// 直接运行这个文件时：边生成边打印回答，并显示每一次工具调用
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const workspace = resolve(process.env.AGENT_WORKSPACE ?? 'workspace');
  mkdirSync(workspace, { recursive: true });
  const price = parsePrice(process.env.OPENAI_PRICE);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  // 思考、回答、工具调用三种输出之间空一行；思考内容用暗色显示
  let lastKind = '';
  const print = (kind: 'thinking' | 'text' | 'tool', text: string) => {
    if (lastKind && lastKind !== kind) process.stdout.write('\n\n');
    else if (kind === 'tool' && lastKind === 'tool') process.stdout.write('\n');
    lastKind = kind;
    process.stdout.write(kind === 'thinking' ? `\x1b[2m${text}\x1b[0m` : text);
  };
  try {
    const { usage } = await runAgent(process.argv[2] ?? '计算 (1234 + 5678) * 9，再把算式和结果写进 result.txt', {
      tools: createTools(workspace),
      signal: controller.signal,
      onReasoning: (text) => print('thinking', text),
      onText: (text) => print('text', text),
      onToolCall: (call, result) => {
        const status = result.isError ? '✗' : '✓';
        print('tool', `${status} ${call.function.name} ${call.function.arguments}\n  ${result.content.split('\n')[0]}`);
      },
    });
    console.log(`\n\n合计：${formatUsage(usage, price)}`);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log('\n（已中断）');
    process.exitCode = 130;
  }
}
