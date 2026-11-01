// 第 3 天：Agent 改用流式调用，边生成边显示，按 Ctrl+C 可以中断。
// 直接运行：node days/day03/solution/agent.ts "Agent 和 MCP 有什么关系？"
import { lookupTerm } from '../glossary.ts';
import { chatStream } from './openai.ts';
import type { Message, ToolDefinition } from './types.ts';
import { addUsage, emptyUsage, formatUsage, parsePrice, type Usage } from './usage.ts';

const SYSTEM_PROMPT = '你是一个术语助手。用户问到任何术语，都先用 lookup_term 查术语表，再根据查到的定义回答。';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_term',
      description: '在术语表里查一个术语的定义',
      parameters: {
        type: 'object',
        properties: { term: { type: 'string', description: '要查的术语，比如 MCP' } },
        required: ['term'],
      },
    },
  },
];

export interface AgentOptions {
  maxSteps?: number;
  /** 每次调用模型之后回调，拿到这一次的用量 */
  onUsage?: (usage: Usage) => void;
  /** 模型每生成一段文字就回调一次 */
  onText?: (text: string) => void;
  /** 推理模型每生成一段思考内容就回调一次 */
  onReasoning?: (text: string) => void;
  /** 取消正在进行的调用 */
  signal?: AbortSignal;
}

export interface AgentResult {
  answer: string;
  /** 所有调用加起来的用量 */
  usage: Usage;
}

export async function runAgent(question: string, options: AgentOptions = {}): Promise<AgentResult> {
  const { maxSteps = 10, onUsage, onText, onReasoning, signal } = options;
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  let usage = emptyUsage();
  for (let step = 0; step < maxSteps; step++) {
    const result = await chatStream({ messages, tools }, { onText, onReasoning, signal });
    usage = addUsage(usage, result.usage);
    onUsage?.(result.usage);
    const reply = result.message;
    // 整条回复原样放回历史，包括 reasoning_content：有的模型服务要求带工具的对话把思考内容传回去
    messages.push(reply);
    if (!reply.tool_calls?.length) return { answer: reply.content ?? '', usage };
    for (const call of reply.tool_calls) {
      const { term } = JSON.parse(call.function.arguments) as { term: string };
      messages.push({ role: 'tool', tool_call_id: call.id, content: lookupTerm(term) });
    }
  }
  throw new Error(`走了 ${maxSteps} 步还没有给出最终回答`);
}

// 直接运行这个文件时：边生成边打印回答，按 Ctrl+C 中断
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const price = parsePrice(process.env.OPENAI_PRICE);
  // 按下 Ctrl+C 时，进程会收到 SIGINT 信号。用 once 只拦截第一次：再按一次就恢复默认行为，直接退出
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  let thinking = false; // 正在显示思考内容
  try {
    const { usage } = await runAgent(process.argv[2] ?? '什么是 Agent？', {
      signal: controller.signal,
      // 思考内容用暗色显示；从思考切换到回答时空一行，把两者分开
      onReasoning: (text) => {
        thinking = true;
        process.stdout.write(`\x1b[2m${text}\x1b[0m`);
      },
      onText: (text) => {
        if (thinking) process.stdout.write('\n\n');
        thinking = false;
        process.stdout.write(text);
      },
    });
    console.log(`\n\n合计：${formatUsage(usage, price)}`);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log('\n（已中断）');
    process.exitCode = 130; // 惯例：被 Ctrl+C 中断的程序以 130 退出
  }
}
