# 第 41 天：框架全景与选型

> 最后核对：2026-11-07

前 40 天，从一次 fetch 调用到一个带评估、追踪、护栏的服务，每一行都是你自己写的。第五阶段开始用成熟的 SDK 提高效率。在选之前，先弄清楚两件事：**它们各自封装了什么**，以及**你手写的那些，分别对应它们的哪一部分**。

今天用两个不同的 SDK 各重写一遍 mini-agent（Vercel AI SDK 和 OpenAI Agents SDK），把它们和第 10 天手写的版本放在同一组任务上比一比。

```text
$ node days/day41/exercise/frameworks/compare.ts
✓ calc · handwritten
✓ calc · ai-sdk
✓ calc · openai-agents
…
| 实现 | 通过 | 平均步数 | 平均耗时 | 用量 |
|---|---|---|---|---|
| handwritten | 3/3 | 1.7 | 2.1 秒 | 输入 2214 tokens · 输出 151 tokens |
| ai-sdk | 3/3 | 1.7 | 2.0 秒 | 输入 2190 tokens · 输出 149 tokens |
| openai-agents | 3/3 | 1.7 | 2.3 秒 | 输入 2385 tokens · 输出 152 tokens |
```

学完今天，你会：

- 说出 Vercel AI SDK、Mastra、OpenAI Agents SDK、Claude Agent SDK、LangGraph.js 各自在哪一层
- 把前 40 天手写的每一块，对应到框架里的概念上
- 用 AI SDK 和 Agents SDK 写出带工具审批的 Agent，并接上国产模型
- 判断什么时候不该用框架，以及用了框架以后哪些事仍然要自己做

## 五个框架，在不同的层

| 框架 | 一句话 | 封装到哪一层 | 许可 |
|---|---|---|---|
| [Vercel AI SDK](https://ai-sdk.dev/) | 统一各家模型的调用，加上工具循环和前端的流式界面 | 模型调用 + 工具循环 + UI 流 | Apache-2.0 |
| [Mastra](https://mastra.ai/) | 基于 AI SDK 的全家桶：Agent、Workflow、记忆、RAG、评估、本地调试台 | 应用框架 | Apache-2.0（部分企业功能另有许可） |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) | Agent + Runner + 交接 + 护栏 + 会话 + 追踪 | 多 Agent 编排 | MIT |
| [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) | 把 Claude Code 整个运行时当库用：文件、命令、子 Agent、hooks、权限、skills | 完整的 Agent 运行时 | 商业条款，不是开源许可（第 43 天） |
| [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) | 把 Agent 写成状态图：节点、边、检查点、人在回路 | 有状态的流程编排 | MIT |

越往下，框架替你做的决定越多：AI SDK 只管「怎么调用模型和工具」，循环里的护栏、上下文、权限都还归你；Claude Agent SDK 连「Agent 该怎么读文件、怎么跑命令、怎么压缩上下文」都定好了，你主要做配置和扩展。

## 你手写的，在框架里叫什么

| 你手写的（第几天） | AI SDK | OpenAI Agents SDK | 还要不要自己写 |
|---|---|---|---|
| fetch 调接口、两种协议的适配器（2、8） | provider，比如 `@ai-sdk/openai-compatible` | `OpenAIChatCompletionsModel`，其他家要接 AI SDK 的扩展 | 不用 |
| SSE 解析、流式拼工具参数（3） | `streamText` | `run(..., { stream: true })` | 不用 |
| 结构化输出和自动修复（4） | `Output.object({ schema })` | `outputType` | 修复的策略看需要 |
| 工具定义和参数校验（5、11） | `tool({ inputSchema, execute })` | `tool({ parameters, execute })` | 工具描述、错误信息还是要你写好 |
| Agent 循环和停止条件（6） | `stopWhen: stepCountIs(n)` | `maxTurns` | 重复调用、连续出错的护栏要自己加 |
| mock 模型、录制回放（7） | `ai/test` 里的 mock 模型 | — | 测试和评估的思路不变 |
| 重试（9） | `maxRetries` | 底层 openai 客户端的重试 | 按错误分类的策略、故障转移要自己加 |
| 确认和权限分级（10、29） | `needsApproval` | `needsApproval` + interruptions | 风险分级、策略要自己定 |
| 上下文组装和压缩（15、16） | `prepareStep`、`pruneMessages` | 会话（sessions） | 预算、缓存命中、压缩策略要自己定 |
| 子 Agent、交接（25、26） | 工具里再调一个 Agent | `handoffs`、`agent.asTool()` | 防循环、成本控制 |
| 追踪（34） | OpenTelemetry 集成 | 内置追踪（默认发到 OpenAI 平台） | 接到自己的后端 |
| 评估、注入防护、护栏、预算（31–39） | — | 输入输出 guardrails | 基本都要自己写 |

最后一行是最重要的：**框架省掉的是第一阶段的活，第四阶段的活几乎都还在**。这也是前 40 天先手写的原因：你知道框架在每一步替你做了什么，出了问题才知道往哪里看。

## 两个 SDK 写出来的 mini-agent

### Vercel AI SDK

```ts
const provider = createOpenAICompatible({ name: 'openai-compatible', baseURL, apiKey, includeUsage: true });
const r = await generateText({
  model: provider.chatModel('my-model'),
  instructions: SYSTEM_PROMPT,
  messages,
  tools: { calculator: tool({ description, inputSchema, execute }) },
  stopWhen: stepCountIs(10),
});
```

`generateText` 自己会循环：调用模型 → 执行工具 → 再调用模型，直到模型不再调用工具，或者满足 `stopWhen`。这正是第 6 天的 `loop()`。

工具审批用 `needsApproval`。AI SDK 不会替你问用户：遇到要审批的调用，它停下来，在 `r.content` 里交回 `tool-approval-request`。你问完用户，把答复做成 `tool-approval-response` 放进一条 tool 消息，带着历史再调一次 `generateText`，它会先执行批准了的工具，再接着循环。和第 29 天的暂停、恢复是同一个设计：**审批是数据，不是回调**，所以可以跨请求、跨进程。

### OpenAI Agents SDK

```ts
setTracingDisabled(true);
const model = new OpenAIChatCompletionsModel(new OpenAI({ baseURL, apiKey }), 'my-model');
const agent = new Agent({ name: 'mini-agent', instructions, model, tools });
let result = await run(agent, question, { maxTurns: 10 });
while (result.interruptions.length) {
  for (const i of result.interruptions) result.state.approve(i); // 或者 reject
  result = await run(agent, result.state);
}
```

接国产模型时要注意三件事：

- **用 Chat Completions**。它默认走 OpenAI 的 Responses API，国产模型服务大多只实现了 Chat Completions，要换成 `OpenAIChatCompletionsModel`
- **关掉默认的追踪**。它默认把每次运行的 trace 发到 OpenAI 的平台：内容里有用户的问题和工具的结果。不需要就 `setTracingDisabled(true)`，需要就换成自己的 exporter（第 34 天）
- **工具参数的 strict 模式**。默认要求所有参数都是必填的（可选参数要写成 nullable），不少模型也不支持。我们直接给 JSON Schema、`strict: false`

`result.state` 可以序列化成字符串存起来，以后再恢复，和第 29 天的 `PausedRun` 一样。

### 共同的接口

[frameworks/common.ts](exercise/frameworks/common.ts) 定义了 `FrameworkRunner`：给一个问题和一组工具，交回 `{ status, answer, steps, toolCalls, usage }`。手写的循环、AI SDK、Agents SDK 都包成它，测试用同一份 mock 脚本跑三遍，[frameworks/compare.ts](exercise/frameworks/compare.ts) 用同一组任务比较。

工具都从我们自己的 `Tool` 转换过去，执行时交给 `executeChecked`：先用工具自己的 zod schema 校验参数（框架只拿到 JSON Schema，不一定校验），再交给第 5 天的 `executeTool` 捕获异常、把结果变成字符串。**工具是你的资产，框架是可以换的**。工具定义、描述、错误信息写在自己的格式里，换框架只要换一个转换函数。

## 什么时候不该用框架

| 情况 | 为什么 |
|---|---|
| 只是调一次模型，没有工具 | 一个 fetch 就够了，框架的依赖、版本升级都是成本 |
| 要对每一步做精细的控制 | 框架的循环是黑盒，比如第 28 天每一步重新生成工具定义、第 37 天的污染跟踪，在框架里要找钩子 |
| 依赖它没覆盖的协议特性 | 比如某家模型的思考内容回传规则（第 8 天），框架跟进有延迟 |
| 团队要长期维护 | 框架的大版本升级常常改 API（AI SDK 每个大版本都改过工具和消息的写法） |
| 运行环境受限 | 依赖多、包体积大，比如边缘函数 |

反过来，下面这些情况，用框架划算：要同时接很多家模型；要前端的流式界面（第 44 天）；团队对 Agent 的内部不熟，需要一个大家都认识的结构；要用它的生态（Mastra 的调试台、Claude Agent SDK 的整套工具）。

折中的做法是：**模型调用和流式这一层用框架，Agent 的护栏、权限、评估这一层留在自己的代码里**。第 42 天就这样把研究助手的模型层换成 AI SDK。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [frameworks/common.ts](exercise/frameworks/common.ts) | 共同的接口、手写循环的 runner | 读懂即可 |
| [frameworks/ai-sdk.ts](exercise/frameworks/ai-sdk.ts) | AI SDK：provider、用量、工具转换、带审批的循环 | TODO 1、2 |
| [frameworks/openai-agents.ts](exercise/frameworks/openai-agents.ts) | Agents SDK：模型、工具转换、interruptions | TODO 3、4 |
| [frameworks/compare.ts](exercise/frameworks/compare.ts) | 同一组任务比较几种实现 | TODO 5 |
| [notes-template.md](notes-template.md) | 一页对比笔记的模板 | 动手第 6 步 |
| 其余文件 | 和第 40 天的参考答案一样 | 不用改 |

今天用到的 `ai`、`@ai-sdk/openai-compatible`、`@openai/agents`、`openai` 已经写进根目录的 `package.json`。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 用了框架就不用懂 Agent 循环了 | 出了问题（死循环、工具参数不对、成本暴涨），还是要知道它每一步在做什么 |
| 框架都差不多，选一个就行 | 它们在不同的层：AI SDK 管调用，Agents SDK 管编排，Claude Agent SDK 是整个运行时 |
| 框架自带护栏，安全就不用管了 | Agents SDK 的 guardrails 只是钩子；注入防护、权限、预算还是你的事 |
| OpenAI 的 SDK 只能用 OpenAI 的模型 | 换成 Chat Completions 模型、改 baseURL 就能接兼容接口，但要关掉默认追踪 |
| 审批是一个回调，问完用户就继续 | 两个 SDK 都把审批做成数据：先停下，交回请求，带着答复再跑。这样才能跨请求 |
| 换框架要重写工具 | 工具留在自己的格式里，写一个转换函数就行 |

## 常见错误

| 报错 | 原因 |
|---|---|
| 测试说 needsApproval 应该是 true | 没有把 `requiresApproval` 传过去，或者传的是 undefined |
| mock 返回 400「tools[0].function.name 必须是字符串」 | 工具的 key 不是工具名 |
| AI SDK 的审批测试一直卡在第一轮 | 答复没有放进 role 为 tool 的消息，或者 `approvalId` 对不上 |
| 测试说步数用完了应该是 max_steps，实际是 completed | 没看 `finishReason` 是不是 `tool-calls` |
| 写文件的测试说文件不存在 | `executeTool` 的 context 里没有 `confirm`，第 10 天的确认把它拒绝了 |
| Agents SDK 报「Max turns (3) exceeded」没被处理 | 没有捕获 `MaxTurnsExceededError` |
| Agents SDK 的用量少算了 | 只算了最后一次 `run()` 的；用量要从 `result.state.usage` 读 |
| 真实模型下 Agents SDK 报 400「additionalProperties」或者「strict」 | 没有关掉 strict |
| 运行 Agents SDK 时看到往 api.openai.com 发请求 | 没有关掉追踪 |

## 动手：用两个 SDK 重写 mini-agent

按顺序做，每做完一步就运行一次 `npm run check 41`：

1. **TODO 1**：AI SDK 的用量和工具转换。转换的测试通过。
2. **TODO 2**：AI SDK 的循环和审批。AI SDK 的四个测试通过。
3. **TODO 3**：Agents SDK 的工具转换。
4. **TODO 4**：Agents SDK 的循环和 interruptions。三种实现的测试都通过。
5. **TODO 5**：比较几种实现。全部测试通过。
6. **写一页对比笔记**（需真实模型）：运行 `node days/day41/exercise/frameworks/compare.ts`，再分别运行 `ai-sdk.ts` 和 `openai-agents.ts` 让它们写一个文件、体验审批，然后照着 [notes-template.md](notes-template.md) 写下你的比较。

## 检查

```bash
npm run check 41
```

三种实现用真实模型各算一道题（需真实模型）：

```bash
npm run check 41 -- --e2e
```

## 小实验

- 在 AI SDK 的版本里把 `generateText` 换成 `streamText`，边生成边打印；对比第 3 天你写的 SSE 解析
- 给 AI SDK 加上 `prepareStep`，第 3 步以后只留 calculator 一个工具（`activeTools`），看看请求里的工具定义怎么变
- 用 Agents SDK 的 `handoffs` 重写第 26 天的分诊 Agent，比较代码量和防循环的做法
- 把 `setTracingDisabled(true)` 去掉，用真实模型跑一次，看看它往哪里发了请求（不要在有真实用户数据的环境里试）
- 让模型故意给出错误的参数（比如 mock 里给 calculator 传数字），看三种实现分别把什么错误交回给模型

## 小结

- 五个框架在不同的层：AI SDK 管调用和 UI 流，Mastra 是应用框架，Agents SDK 管编排，Claude Agent SDK 是完整的运行时，LangGraph.js 是状态图
- 框架省掉的主要是第一阶段的活；评估、注入防护、权限、预算这些第四阶段的活，基本都还要自己做
- 两个 SDK 都把工具审批做成数据：停下、交回请求、带着答复再跑
- 接国产模型：用 OpenAI 兼容的 provider 或 Chat Completions 模型；注意默认的追踪和 strict 模式
- 工具留在自己的格式里，换框架只换转换函数；能用简单方案的就别上框架

## 想一想

- 研究助手的模型层换成 AI SDK，第 7 天的 mock 测试、第 33 天的评估还能不能原样通过？要换掉哪一层，才能让上面的代码都不用改？（第 42 天）
- Claude Agent SDK 自带读写文件、执行命令、子 Agent、权限和 hooks。如果要做一个「代码库问答」的专用 Agent，自己写还是复用它？（第 43 天）
- 前端要实时显示 Agent 在调用哪个工具、读了哪些来源，服务端该推送什么格式的数据？（第 44 天）

## 延伸阅读

- [Vercel AI SDK 文档](https://ai-sdk.dev/docs)：Agents、Tool Calling、Tool Execution Approval 几节
- [AI SDK：OpenAI Compatible Providers](https://ai-sdk.dev/providers/openai-compatible-providers)：接入兼容接口
- [OpenAI Agents SDK（TypeScript）](https://openai.github.io/openai-agents-js/)：Agents、Human in the loop、Tracing、Models 几节
- [Mastra 文档](https://mastra.ai/docs)：基于 AI SDK 的应用框架
- [LangGraph.js 文档](https://langchain-ai.github.io/langgraphjs/)：状态图、检查点和人在回路
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：关于什么时候用框架、什么时候直接写的建议
