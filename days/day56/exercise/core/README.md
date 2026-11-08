# core：Agent 内核

从研究助手（第 49 天的参考答案）里原样拿出来的 Agent 内核，毕业项目可以直接复制到自己的仓库里用：

| 文件 | 内容 | 来自 |
|---|---|---|
| `agent.ts` | Agent 循环：护栏、确认、暂停和恢复、onToolStart | 第 1–10、26、28、29、44 天 |
| `tool.ts`、`permissions.ts` | 工具的定义、校验、执行、分页；风险分级和权限策略 | 第 5、11、29 天 |
| `types.ts`、`usage.ts`、`errors.ts` | 消息和模型的类型、用量和成本、错误 | 第 2、7、8 天 |
| `openai.ts`、`anthropic.ts`、`sse.ts` | 两种协议的适配器 | 第 2、3、8 天 |
| `retry.ts` | 按错误分类重试 | 第 9 天 |
| `parallel.ts` | 有并发上限的 `mapLimit` | 第 22 天 |
| `providers.ts` | 精简过的模型入口：两种协议加重试 | 第 8、9 天 |

不想用自己写的内核，也可以换成 Vercel AI SDK 或者 Claude Agent SDK（第 41–43 天）。示例项目 review-bot 用这个内核，是为了让测试继续用 mock 模型离线跑。
