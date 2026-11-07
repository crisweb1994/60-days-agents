# 第 29 天：人在回路

> 最后核对：2026-11-04（MCP 规范 2026-07-28，官方 TypeScript SDK v2.4.0）

第 10 天的 mini-agent 在写文件之前会问一句「允许吗？(y/N)」。这已经是「人在回路」（human in the loop），但很粗糙：

- 所有要确认的工具一视同仁。改个笔记文件和把数据 POST 到外部服务，问法一样
- 只能当场问。研究跑到一半要确认，用户去开会了，程序就一直卡在那里；程序一重启，进度全丢
- Agent 不会反过来问用户。「帮我查一下那个协议」，它只能猜是哪个

今天把这三件事做好：

```text
$ node days/day29/exercise/run-store.ts start "把潮汐协议 3.0 的变化整理成笔记"
运行 run-20261104T013000-k3f9 暂停了，在等你：
  call_2：回答问题：笔记存成什么文件名？（tide-3.0.md / notes.md）

$ node days/day29/exercise/run-store.ts resume run-20261104T013000-k3f9 call_2=tide-3.0.md
运行 run-20261104T013000-k3f9 暂停了，在等你：
  call_5：批准执行 write_file（可写）：{"path":"tide-3.0.md","content":"# 潮汐协议 3.0……"}

$ node days/day29/exercise/run-store.ts resume run-20261104T013000-k3f9 call_5=y
笔记已经存到 tide-3.0.md。
```

两次命令之间可以隔一个小时，程序可以重启：现场存在文件里。

学完今天，你会：

- 按风险给工具分级，用权限策略决定允许、询问还是禁止
- 让 Agent 循环在等用户时暂停，把现场存下来，以后从停下的地方接着跑
- 让 Agent 主动向用户澄清
- 说清楚 MCP 2026-07-28 规范的「多轮输入」（`input_required`）和今天的暂停为什么是同一个思路

## 按风险分级

[permissions.ts](exercise/permissions.ts) 把工具分成三级：

| 等级 | 含义 | 例子 |
|---|---|---|
| read（只读） | 没有副作用 | 搜索、读网页、读文件、计算、查文档 |
| write（可写） | 有副作用，但可以撤销，或者影响有限 | 写工作目录里的文件、改记忆 |
| irreversible（不可逆） | 做了就收不回来 | POST 请求（数据已经发出去了）、提交表单、付款、发邮件 |

工具用 `risk` 声明自己的等级，可以按参数判断：`http_request` 是 GET 时只读，POST 时不可逆；`browser_type` 只输入时只读，按回车提交时不可逆。没有声明的老工具，`requiresApproval` 为真的算可写，其他的算只读。

每一级怎么处理，由**权限策略**决定：

```ts
export const DEFAULT_POLICY: PermissionPolicy = {
  read: 'allow',
  write: 'ask',
  irreversible: 'ask',
  tools: { remember: 'allow', forget: 'allow' },   // 按工具名覆盖
};
```

分级的好处是**把决定权交给使用的人**。个人用的研究助手可以宽松一点；放在公司里给大家用，可以把 `irreversible` 改成 `deny`，Agent 根本没机会发出 POST 请求；某个 MCP 服务器不放心，可以按工具名单独禁掉。

### 「以后都可以」

每次写文件都问一遍，用户很快就会烦，然后不看内容就按 y。这比不问还糟：确认变成了走过场。所以命令行多了一个选项：

```text
要执行 write_file {"path":"notes.md", …}（可写）
允许吗？(y 允许 / a 这次会话里都允许 / N 不允许)
```

回答 `a`，这个工具在这次会话里就不再问（`grants`）。但**不可逆的操作不提供这个选项**，每次都要问：「以后都可以」很容易在不经意间放过一次付款。

## 暂停、保存、恢复

当场问的前提是有人在。后台跑的研究任务（第 45 天会做）、一个要跑十分钟的调研，用户不可能一直盯着。这时更好的做法是：**遇到要确认的事就暂停，把现场存下来，通知用户；用户什么时候回来答复，就什么时候接着跑。**

### 中断

第一步是让「要等用户」变成一种结果，而不是一个卡住的 `await`。[tool.ts](exercise/tool.ts) 的 `runToolCall()`：要问用户，但没有 `confirm`、又允许暂停（`pausable`）时，不执行工具，返回一个**中断**：

```ts
{ content: '', isError: false, interrupt: { kind: 'approval', tool: 'write_file', input: {...}, risk: 'write' } }
```

中断有两种：`approval` 是等批准，`input` 是等回答（下面的 `ask_user`）。

### 现场

[agent.ts](exercise/agent.ts) 的循环看到中断，就停下来，`status` 是 `paused`，把**现场**交给调用方：

```ts
interface PausedRun {
  messages: Message[];      // 历史，停在发起工具调用的那条 assistant 消息上
  calls: { call; result?; interrupt? }[];   // 这一轮的每个调用：执行完的带着结果，在等用户的带着中断
  steps: number;            // 护栏的计数，恢复以后接着算
  usage: Usage;
  seen: [string, number][];
  toolErrors: number;
}
```

几个要点：

- **同一轮里不用批准的调用照常执行**。模型同时调用了 `calculator` 和 `write_file`，计算的结果先存在现场里
- **历史里先不放工具结果**。第 6 天的 `finish()` 会给没执行的调用补一条「没有执行」，暂停时不能补：这些调用等用户回来还要接着执行
- **护栏的计数也要存**。不然恢复以后步数从零开始，暂停一次就能绕过 `maxSteps`
- **全是普通的数据**。`Map` 转成数组，这样才能存成 JSON

### 恢复

`resumeAgent(paused, resolutions, options)` 带着用户的答复接着跑：

- 批准的：执行它，**不再检查权限**（用户刚批准过，再检查又会暂停）。`always` 还会把工具加进 `grants`
- 拒绝的：结果是一条错误，模型看到以后换个办法
- 回答的：用户的回答就是 `ask_user` 的结果

所有调用都有了结果，按**原来的顺序**放进历史，再接着调用模型。为了不把循环写两遍，`runAgent` 和 `resumeAgent` 共用同一个 `loop()`：一个从空的状态开始，一个从现场开始。

### 存进文件

[run-store.ts](exercise/run-store.ts) 每次运行一个 JSON 文件。暂停了就存，跑完了就删。写文件时先写临时文件再改名：写到一半程序崩了，也不会留下一个坏掉的现场。运行的 id 只能是字母、数字和连字符，免得有人用 `../../` 读到别的文件。

## 主动澄清

人在回路不只是「Agent 问能不能做」，还有「Agent 问该怎么做」。[tools/ask-user.ts](exercise/tools/ask-user.ts) 的 `ask_user`：

```text
✓ ask_user {"question":"你说的是哪个协议？","options":["潮汐协议","浪花协议"]}
```

它的实现很简单，有意思的是它在三种环境下的表现：

| 环境 | 怎么问 |
|---|---|
| 命令行 | 直接问（`context.ask`），和确认排在同一个队里 |
| 后台运行（`pausable`） | 抛出中断，暂停，等用户回答 |
| 都不行（比如第 25 天的子 Agent） | 告诉模型「按最合理的理解接着做，在回答里说明你的假设」 |

最难的是让模型**不要问得太多**。每一个问题都在打断用户。system prompt 里写清楚：只在含糊、不问就会做错时问；能自己查到的不要问；一次只问一个，给出选项。

## MCP 的多轮输入

MCP 服务器的工具也会遇到同样的问题：一个「订会议室」的工具，要问用户选哪个时间。早期的 MCP 是有状态的长连接，服务器可以在工具执行的中途反过来给客户端发请求（elicitation）。2026-07-28 规范改成了无状态（第 13 天），于是换了一种做法，叫**多轮输入**：

1. 客户端调用 `tools/call`
2. 服务器发现要用户提供信息，不是卡在那里等，而是直接返回一个结果，`resultType` 是 `input_required`，里面有要问的问题（`inputRequests`），还有一个服务器生成的、不透明的字符串 `requestState`
3. 客户端去问用户，拿到回答
4. 客户端**重新**调用同一个工具，带上回答（`inputResponses`）和原样的 `requestState`

是不是很眼熟？这和今天的暂停是同一个思路：**不在原地等，把「还缺什么」和「做到哪了」交出去，信息齐了再来一次**。`requestState` 就是服务器的「现场」，只不过存在客户端那里。规范特别提醒：`requestState` 经过了客户端，服务器要把它当作不可信的输入，涉及权限的部分要签名校验。今天的现场存在我们自己的磁盘上，信任问题小一些；到第 45、46 天现场存进数据库、多个用户共用服务时，同样要考虑。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [permissions.ts](exercise/permissions.ts) | 风险等级、权限策略 | TODO 1 |
| [tool.ts](exercise/tool.ts) | 按策略允许、询问、禁止；中断 | TODO 2 |
| [agent.ts](exercise/agent.ts) | 暂停、恢复 | TODO 3、4 |
| [run-store.ts](exercise/run-store.ts) | 存进文件；从命令行开始、列出、恢复 | TODO 5 |
| [tools/ask-user.ts](exercise/tools/ask-user.ts) | 主动澄清 | 读懂即可 |
| [cli.ts](exercise/cli.ts) | 确认时显示风险、`a` 这次会话里都允许、`ask_user` 直接问、`/permissions` | 读懂即可 |
| 其余文件 | 和第 28 天的参考答案一样；几个工具加上了 `risk` | 不用改 |

## 常见误解

| 误解 | 实际上 |
|---|---|
| 每个有副作用的操作都问一遍最安全 | 问太多，用户就不看内容直接按 y。按风险分级，只问真正要问的 |
| 「以后都可以」对所有工具都适用 | 不可逆的操作每次都要问 |
| 暂停就是 `await` 一个用户输入 | 那要求进程一直活着、有人在。真正的暂停是把现场存下来，进程可以退出 |
| 恢复以后从头再跑一遍就行 | 已经执行过的工具会再执行一次（第 9 天讲过重复执行的危害）。要从停下的地方接着跑 |
| 恢复时再检查一遍权限更保险 | 用户刚批准过，再检查又会暂停，永远跑不完 |
| Agent 不确定时就问用户 | 能自己查到的不要问，每个问题都在打断用户 |

## 常见错误

| 报错 | 原因 |
|---|---|
| 测试说不可逆的操作说过「以后都可以」也要问 | `grants` 对不可逆的操作也生效了 |
| 测试说 deny 的时候不该问用户 | 先问了用户，再看策略 |
| 测试说期望返回中断，实际是「用户没有同意」 | 没有处理 `pausable` |
| 暂停以后，历史里多了「没有执行：Agent 已经停止」 | `finish()` 暂停时也给工具调用补了结果 |
| 把现场存成 JSON 再恢复，报 `seen` 不是可迭代的 | `seen` 是 `Map`，存之前要转成数组 |
| 恢复以后又暂停在同一个调用上 | 批准的调用又走了一遍权限检查，要用 `executeTool` 直接执行 |
| 测试说「跑完就删掉」 | 没有暂停时没有从 `store` 里删掉 |

## 动手：权限、暂停和恢复

按顺序做，每做完一步就运行一次 `npm run check 29`：

1. **TODO 1**：风险等级和权限策略。
2. **TODO 2**：执行工具时按策略处理，没人可问时返回中断。
3. **TODO 3**：Agent 循环看到中断就暂停，交出现场。
4. **TODO 4**：带着用户的答复恢复。
5. **TODO 5**：存进文件，跑完就删。全部测试通过。

## 检查

```bash
npm run check 29
```

用真实模型试一个含糊的请求，看它会不会先问清楚：

```bash
npm run check 29 -- --e2e
```

然后试试后台运行的流程：开始、退出、过一会儿再恢复：

```bash
node days/day29/exercise/run-store.ts start "把潮汐协议 3.0 的变化整理成笔记，存进工作目录"
node days/day29/exercise/run-store.ts list
```

## 小实验

- 把默认策略的 `irreversible` 改成 `deny`，让研究助手往一个网址 POST 数据，看它被拒绝以后怎么回答
- 用 `run-store.ts` 开始一次运行，暂停以后用 `Ctrl+C` 退出，改一改 `.env` 里的模型，再恢复。现场里有什么、没有什么？
- 在一次恢复里拒绝写文件，看模型会不会换个文件名再试（`用户没有同意` 的错误信息里写了什么？）
- 问几个含糊程度不同的问题，统计它问了几次。是问多了，还是问少了？改一改 prompt 里「和用户确认」一节
- 读一读 MCP SDK 里 `InputRequiredResult` 的类型定义（`node_modules/@modelcontextprotocol/client`），对照今天的 `PausedRun`

## 小结

- 按风险分级：只读、可写、不可逆。权限策略决定每一级允许、询问还是禁止，可以按工具名覆盖
- 「以后都可以」减少打扰，但不可逆的操作每次都要问
- 暂停：工具要等用户时返回中断，循环停下，交出现场（历史、这一轮的调用和结果、护栏的计数）
- 恢复：带着答复，从停下的地方接着跑；批准过的不再检查权限
- 现场存进文件，进程可以退出、可以重启
- 主动澄清：含糊的时候问一句，但别问太多
- MCP 的多轮输入是同一个思路：不在原地等，把缺什么、做到哪交出去，信息齐了再来一次

## 想一想

- 第 21–29 天做的东西，怎么组装成一个完整的研究流程：先列计划给用户确认，再派子 Agent 并行调研，最后核查引用、生成报告？（第 30 天）
- 研究助手做得好不好，现在全靠我们一个个问题地看。能不能有一套题，每次改完 prompt 都自动跑一遍、打个分？（第 31 天）
- 暂停的现场存在本地文件里。多个用户、多台机器的时候，该存在哪里？（第 45、46 天）

## 延伸阅读

- [MCP 规范 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)：无状态的协议，以及多轮输入的模式
- [LangGraph：Human-in-the-loop](https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/)：另一个框架怎么做中断和恢复，对照着看
- [OpenAI Agents SDK：Human in the loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)：工具审批、暂停的运行状态可以序列化以后再恢复
- [Anthropic：Claude Code 的权限设置](https://code.claude.com/docs/en/iam)：一个编程 Agent 怎么给工具分级、怎么配置允许和禁止的规则
