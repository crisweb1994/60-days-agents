// 第 2 天：第 1 天的 Agent 改用自己写的 chat()，并统计每次调用的 token 和花费。
// 直接运行：node days/day02/solution/agent.ts "Agent 和 MCP 有什么关系？"
import { lookupTerm } from '../glossary.ts';
import { chat } from './openai.ts';
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
}

export interface AgentResult {
  answer: string;
  /** 所有调用加起来的用量 */
  usage: Usage;
}

export async function runAgent(question: string, options: AgentOptions = {}): Promise<AgentResult> {
  const { maxSteps = 10, onUsage } = options;
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  let usage = emptyUsage();
  for (let step = 0; step < maxSteps; step++) {
    const result = await chat({ messages, tools });
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

// 直接运行这个文件时：回答命令行里的问题，每次调用模型后打印用量
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  const price = parsePrice(process.env.OPENAI_PRICE);
  let calls = 0;
  const { answer, usage } = await runAgent(process.argv[2] ?? '什么是 Agent？', {
    onUsage: (callUsage) => console.log(`第 ${++calls} 次调用：${formatUsage(callUsage, price)}`),
  });
  console.log(`\n${answer}\n`);
  console.log(`合计 ${calls} 次调用：${formatUsage(usage, price)}`);
}
