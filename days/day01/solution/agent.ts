// 第 1 天：一个会查术语表的 Agent。
// 直接运行：node days/day01/solution/agent.ts "什么是 MCP？"
import { lookupTerm } from '../glossary.ts';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type AssistantMessage = { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

const SYSTEM_PROMPT = '你是一个术语助手。用户问到任何术语，都先用 lookup_term 查术语表，再根据查到的定义回答。';

// 告诉模型有哪些工具可用：名称、用途，以及参数的 JSON Schema
const tools = [
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

// 调用一次模型。第 2 天会把这个函数拆开细讲
async function chat(messages: Message[]): Promise<AssistantMessage> {
  const res = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL, messages, tools }),
  });
  if (!res.ok) throw new Error(`模型调用失败：${res.status} ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: AssistantMessage }[] };
  return data.choices[0].message;
}

export async function runAgent(question: string, maxSteps = 10): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  for (let step = 0; step < maxSteps; step++) {
    const reply = await chat(messages);
    messages.push(reply);
    // 模型不再调用工具，说明它给出了最终回答
    if (!reply.tool_calls?.length) return reply.content ?? '';
    // 执行每个工具调用，把结果交回模型。tool_call_id 要和调用的 id 对上
    for (const call of reply.tool_calls) {
      const { term } = JSON.parse(call.function.arguments) as { term: string };
      messages.push({ role: 'tool', tool_call_id: call.id, content: lookupTerm(term) });
    }
  }
  throw new Error(`走了 ${maxSteps} 步还没有给出最终回答`);
}

// 直接运行这个文件时：读取 .env，回答命令行里的问题
if (import.meta.main) {
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env 文件时，就用终端里已经设置的环境变量
  }
  console.log(await runAgent(process.argv[2] ?? '什么是 Agent？'));
}
