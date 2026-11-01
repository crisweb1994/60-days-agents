// 第 1 天的练习：补全两个 TODO，让 Agent 学会查术语表。
// 检查：npm run check 1
// 直接运行：node days/day01/exercise/agent.ts "什么是 MCP？"
import { lookupTerm } from '../glossary.ts';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type AssistantMessage = { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

const SYSTEM_PROMPT = '你是一个术语助手。用户问到任何术语，都先用 lookup_term 查术语表，再根据查到的定义回答。';

// TODO 1：告诉模型它有一个 lookup_term 工具。
// 每个工具写成 { type: 'function', function: { name, description, parameters } }，
// parameters 是参数的 JSON Schema：一个对象，只有一个必填的字符串参数 term。
const tools: object[] = [];

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
    // TODO 2：
    // - reply 里没有 tool_calls：模型给出了最终回答，返回 reply.content
    // - 有 tool_calls：逐个执行。call.function.arguments 是 JSON 字符串，解析出 term 交给 lookupTerm，
    //   再把结果作为 { role: 'tool', tool_call_id: call.id, content: 查到的定义 } 放回 messages
    throw new Error('TODO 2：还没有实现 Agent 循环');
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
