# 第 1 天：60 行写出第一个 Agent

> 最后核对：2026-11-01

<!-- TODO: 讲义正文（30–45 分钟）：准备环境；Agent = 模型 + 工具 + 循环；模型如何决定调用工具、拿到结果、再给出回答 -->

## 动手：写一个会查术语表的 Agent

打开 [exercise/agent.ts](exercise/agent.ts)，完成里面的两个 TODO：

1. 定义 `lookup_term` 工具，告诉模型它能查术语表
2. 补全 Agent 循环：模型要调用工具时，执行工具并把结果交回模型；模型不再调用工具时，返回它的回答

术语表在 [glossary.ts](glossary.ts) 里，已经写好了。

## 检查

```bash
npm run check 1
```

这条命令用 mock 模型离线运行，测试全部通过就算完成。

想用真实模型验证，先在 `.env` 里填好模型配置，再运行：

```bash
npm run check 1 -- --e2e
```

也可以直接和你的 Agent 对话：

```bash
node days/day01/exercise/agent.ts "什么是 MCP？"
```

实在卡住了，再看 [solution/agent.ts](solution/agent.ts)。
