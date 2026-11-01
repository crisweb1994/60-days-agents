// Agent 要查的术语表，和第 1 天的一样。
const glossary: Record<string, string> = {
  agent: 'Agent：让模型在循环里自己决定调用哪些工具、什么时候停下来的程序。可以概括成 Agent = 模型 + 工具 + 循环。',
  mcp: 'MCP（Model Context Protocol）：一个开放协议，让 Agent 用统一的方式接入外部的工具和数据。',
  工具调用: '工具调用（tool calling）：模型不直接回答，而是返回想调用的函数名和参数，由程序执行后再把结果交回模型。',
  token: 'token：模型处理文本的基本单位，计费和上下文长度都按 token 计算。',
  上下文窗口: '上下文窗口（context window）：模型一次能处理的 token 上限，输入和输出都算在内。',
  潮汐窗口: '潮汐窗口：本课程虚构的术语，指每周四晚上的发布时段，内部代号 TW-42。',
};

const aliases: Record<string, string> = {
  'tool calling': '工具调用',
  'context window': '上下文窗口',
};

/** 查一个术语的定义。查不到时也返回一句说明，让模型知道术语表里没有 */
export function lookupTerm(term: string): string {
  const key = term.trim().toLowerCase();
  return glossary[aliases[key] ?? key] ?? `术语表里没有「${term}」。`;
}
