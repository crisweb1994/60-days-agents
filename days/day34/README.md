# 第 34 天：可观测性

> 最后核对：2026-11-07

第 33 天的门禁告诉你「unanswerable-v4 回归了」。为什么？打开记录，你只看到最后的回答：它编了一个发布日期。它搜了什么？读了哪个网页？是哪一步把它带偏的？最后的回答里看不出来。

一次深度研究要调用几十次模型和工具。哪一次慢、哪一次出错、钱花在哪，都需要把**过程**记下来。今天给研究助手加上追踪（tracing）：每一次模型调用、每一次工具调用都是一个 span，span 套着 span 组成一棵树。按 OpenTelemetry 的约定导出，在 Langfuse 里看、在终端里看，从 trace 里定位失败的原因。

```text
$ node days/day34/solution/research.ts --trace "潮汐协议 3.0 的延迟是多少？"
……
invoke_agent research  14.21 秒
  └ chat my-model  2.10 秒 · 输入 3120 / 输出 41 tokens
  └ execute_tool fetch_page  0.04 秒 · ✗ Error：HTTP 404：https://tide.example/perf.html
  └ chat my-model  1.88 秒 · 输入 3260 / 输出 38 tokens
  └ execute_tool web_search  0.92 秒
  └ chat my-model  1.61 秒 · 输入 3801 / 输出 52 tokens
  └ execute_tool fetch_page  0.31 秒
  └ chat my-model  5.97 秒 · 输入 5410 / 输出 186 tokens
```

学完今天，你会：

- 说清楚 trace、span、属性、事件，以及 OpenTelemetry 的 GenAI 语义约定
- 不改 Agent 的代码，给模型和工具包一层追踪
- 用异步上下文让并行的子 Agent 各自挂在正确的父 span 下面
- 导出成 OTLP，自托管 Langfuse 来看 trace
- 从 trace 里找到失败的根源；知道日志里哪些东西不能记

## 日志不够，要追踪

到现在为止，我们一直用 `console.error` 打印「✓ web_search ……」。它有三个问题：

- **没有结构**：想统计「哪个工具最慢」「每次研究平均几次模型调用」，要去解析文字
- **没有父子关系**：三个子 Agent 同时跑，日志交错在一起，分不清哪行属于谁
- **只在终端里**：用户那边出了问题，你看不到

追踪解决的就是这些。几个概念：

| 概念 | 是什么 | 研究助手里的例子 |
|---|---|---|
| trace | 一次完整的运行，一棵树 | 一次 `/deep` |
| span | 树上的一个节点：一件有开始、有结束的事 | 一次模型调用、一次工具调用、一个子 Agent |
| 父 span | 包含它的那件事 | 子 Agent 是它里面每次模型调用的父 span |
| 属性 | span 上的键值对 | 用了哪个模型、多少 token、调用了哪个工具 |
| 事件 | span 里某个时刻发生的事 | 抛出了一个错误 |
| 状态 | unset、ok、error | 工具出错时是 error |

## OpenTelemetry 和 GenAI 语义约定

[OpenTelemetry](https://opentelemetry.io/)（OTel）是可观测性的开放标准：span 长什么样、怎么传输（OTLP 协议）、属性叫什么名字。用了它，换一个可观测平台不用改代码：Langfuse、Jaeger、各家云厂商的平台都接收 OTLP。

它的 [GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)规定了模型调用和工具调用的 span 怎么写。今天用到的：

| span | 名字 | 属性 |
|---|---|---|
| 模型调用 | `chat {模型名}` | `gen_ai.operation.name`（chat）、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.request.temperature`、`gen_ai.response.finish_reasons`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens` |
| 工具调用 | `execute_tool {工具名}` | `gen_ai.operation.name`（execute_tool）、`gen_ai.tool.name`、`gen_ai.tool.type`、`gen_ai.tool.call.id` |
| Agent | `invoke_agent {Agent 名}` | `gen_ai.operation.name`（invoke_agent）、`gen_ai.agent.name` |
| 出错 | — | `error.type`，状态是 error |

**注意**：GenAI 约定目前还是 Development 状态，属性名还在变（比如早期的 `gen_ai.system` 后来改成了 `gen_ai.provider.name`）。今天的代码按 2026 年 11 月的版本写，用之前对照一下最新的规范。

`gen_ai.provider.name` 应该是真正的服务商（deepseek、moonshot……）。我们的模型名是 `openai:my-model`，冒号前面其实是**协议**，所以 `traceModel` 允许你传 `provider` 覆盖它。

## 读懂练习代码

[trace.ts](exercise/trace.ts) 是一个最小的 OTel 实现：不依赖官方的 SDK，为的是看清楚 span 里到底有什么。实际项目里用 `@opentelemetry/sdk-node` 更省事，概念完全一样。

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [trace.ts](exercise/trace.ts) | tracer、给模型和工具加追踪、导出 OTLP、Langfuse、traceparent、看 trace | TODO 1–5 |
| [research.ts](exercise/research.ts) | `research()` 可以传 `tracer`；`--trace` 打印 trace | 读懂即可 |
| [deep-research.ts](exercise/deep-research.ts) | 深度研究的每一步一个 span，每个子 Agent 一个 invoke_agent span | 读懂即可 |
| [tool.ts](exercise/tool.ts) | 执行工具时上下文里带上这次的工具调用 `call`，span 才能记下它的 id | 读懂即可 |
| 其余文件 | 和第 33 天的参考答案一样 | 不用改 |

### 包一层，不改 Agent

```ts
const traced = traceModel(model, tracer);       // 还是一个 Model
const tools = traceTools(createTools(...), tracer); // 还是 Tool[]
await tracer.withSpan('invoke_agent research', {}, () => runAgent(question, { model: traced, tools }));
```

和第 9 天的 `withRetry`、第 21 天的 `countCalls` 一样：Agent 只认 `Model` 接口，套上一层它察觉不到。Agent 循环一行都不用改。

### 父 span 从哪里来：异步上下文

`traceModel` 里开始一个 span 时，它的父 span 是谁？Agent 循环不会把「当前的 span」一路传进来。答案是 Node.js 的 [AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)：

```ts
withSpan(name, attrs, fn) {
  const active = startSpan(name, attrs);       // 父 span 是 storage.getStore()
  return storage.run(active.span, () => fn(active)); // fn 里面，getStore() 拿到的就是 active.span
}
```

`storage.run` 设置的值会跟着 `fn` 里所有的异步操作走：`await`、`setTimeout`、`Promise.all` 里的每一个分支。三个子 Agent 同时跑，每个都在自己的 `withSpan` 里，它们各自的模型调用就会挂在各自下面，不会串。OTel 的官方 SDK 在 Node.js 里也是这么做的。

### 导出：攒一批再发，失败了也不能影响 Agent

span 结束以后先进缓冲区，攒够一批（默认 50 个）或者调用 `flush()` 时才导出。每个 span 都发一次请求太浪费。

**导出失败绝不能让 Agent 失败**。Langfuse 挂了，用户的研究照样要做完。`flush` 里的错误交给 `onExportError`，只记一下。

### OTLP 的 JSON 长什么样

```json
{ "resourceSpans": [{
    "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "research-assistant" } }] },
    "scopeSpans": [{ "scope": { "name": "60-days-agent" }, "spans": [{
      "traceId": "…32 位…", "spanId": "…16 位…", "parentSpanId": "…",
      "name": "chat my-model", "kind": 3,
      "startTimeUnixNano": "1762500000123000000", "endTimeUnixNano": "…",
      "attributes": [{ "key": "gen_ai.usage.input_tokens", "value": { "intValue": "3120" } }],
      "status": { "code": 0 }
    }]}]
}]}
```

几个容易错的地方：时间是**纳秒**，而且写成**字符串**（超出了 JavaScript 数字的精确范围）；整数属性也写成字符串（`intValue`），小数是 `doubleValue`；`kind` 和 `status.code` 是数字。

## 自托管 Langfuse

[Langfuse](https://langfuse.com/) 是一个开源的 LLM 可观测平台，接收 OTLP，把 `gen_ai.*` 的 span 显示成模型调用，带着 token 和花费。用 Docker 在本机跑起来：

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up
```

等几分钟，打开 <http://localhost:3000>，注册一个账号、建一个项目，在项目设置里创建 API Key，把公钥和私钥填进 `.env`：

```bash
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-…
LANGFUSE_SECRET_KEY=sk-lf-…
```

`langfuseExporterFromEnv()` 把 span 发到 `<LANGFUSE_BASE_URL>/api/public/otel/v1/traces`，用 Basic 认证（公钥是用户名，私钥是密码）。Langfuse 的 OTLP 接口支持 HTTP 的 JSON 和 protobuf，不支持 gRPC。用 Langfuse 的云服务也一样，只是地址换成云服务的。

## 从 trace 定位失败

一个工具出错，它的父 span（子 Agent）往往也跟着出错，再往上（深度研究）也是。从根往下看，满屏都是红的。要找的是**最底下那个**：

```ts
findFailures(spans)
// → [{ path: ['invoke_agent deep_research', 'invoke_agent subagent', 'execute_tool fetch_page'],
//      span: { status: { code: 'error', message: 'HTTP 404' }, … } }]
```

状态是 error、子孙里没有别的 error 的 span，才是根源。拿到它，再往前看几步：模型为什么要打开这个网址？是搜索结果里的，还是它自己编的？

trace 能帮你回答的问题：

| 问题 | 看什么 |
|---|---|
| 这次为什么答错了 | 它读了哪些网页、按什么顺序，哪一步拿到了错误的信息 |
| 为什么这么慢 | 最慢的 span 是哪个：模型、网页，还是排队等并发 |
| 钱花在哪了 | 哪些 chat span 的输入 token 最多：多半是上下文里塞了太多网页 |
| 子 Agent 为什么没查完 | 它的 span 下面有几次模型调用，是不是用完了步数 |

评估里的一条失败，配上它的 trace，原因往往一眼就能看出来。这也是 Langfuse 这类平台把评估和 trace 放在一起管理的原因。

## 日志里的隐私

trace 很容易变成一个隐私泄露的地方：用户的问题、读到的网页、模型的回答，可能都有个人信息和密钥。今天的代码：

- **默认不记内容**。`gen_ai.input.messages` 和 `gen_ai.output.messages` 只在 `captureContent: true` 时才记
- **记之前先脱敏**：密钥、邮箱、手机号、身份证号换成占位符，再截断。第 39 天会做更完整的敏感信息识别
- 开发时开着方便排查，上线以后要想清楚：谁能看到 trace？存多久？用户要求删除时能不能删？

GenAI 约定本身也把消息内容设计成「默认不记、可选开启」，理由一样。

## 在服务之间传递 trace（选读）

研究助手调用一个 HTTP 部署的 MCP 服务器（第 14 天），服务器那边也有自己的 span。怎么让它们接到同一棵树上？W3C Trace Context 标准规定了一个请求头：

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             版本 traceId（32 位）                 父 spanId（16 位）  采样
```

调用方把当前 span 写进请求头（`traceparentOf`），服务器读出来（`parseTraceparent`），把它当作自己的根 span 的父 span。官方的 OTel SDK 会自动给 fetch 加上这个头。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 有日志就够了 | 日志没有结构、没有父子关系，统计和定位都难。追踪是有结构的日志 |
| 加追踪要改 Agent 的每一处调用 | 包一层模型和工具就够了，Agent 循环不用改 |
| 父 span 要一层层手动传下去 | 异步上下文会自动跟着 await 走 |
| trace 里记全部内容最方便 | 内容里有隐私。默认不记，要记先脱敏 |
| 导出失败要重试到成功 | 追踪是辅助的，它出问题不能拖垮主流程。记一下就放过 |
| 出错的 span 越多，问题越多 | 一个根源会让上面每一层都变红。找子孙里没有别的错误的那个 |

## 常见错误

| 报错 | 原因 |
|---|---|
| 测试说 chat 的父 span 应该是 invoke_agent | `withSpan` 里没有用 `storage.run` 运行 `fn` |
| 测试说「异步上下文要跟着各自的任务走」 | 用一个普通变量记「当前的 span」：并行的任务会互相覆盖。要用 AsyncLocalStorage |
| 测试说 fn 抛出错误时 span 应该结束 | 出错的时候没有调用 `end()`：要放在 finally 里 |
| 测试说 `gen_ai.response.finish_reasons` 应该是数组 | 写成了字符串。约定里它是一个数组 |
| 测试说 `intValue` 应该是字符串 `'120'` | 写成了数字。int64 在 OTLP 的 JSON 里要写成字符串 |
| 测试说没有父 span 时不应该有 `parentSpanId` 字段 | 写成了 `parentSpanId: undefined`，序列化以后虽然没有，但对象上有这个键 |
| `findFailures` 把每一层都报出来了 | 没有检查子孙里有没有 error |

## 动手：给研究助手装上追踪

按顺序做，每做完一步就运行一次 `npm run check 34`：

1. **TODO 1**：`withSpan`：在异步上下文里运行，出错记下来，最后总要结束。
2. **TODO 2**：给模型加追踪，按 GenAI 约定记属性。
3. **TODO 3**：给工具加追踪。
4. **TODO 4**：导出成 OTLP 的 JSON。
5. **TODO 5**：找出失败的根源。全部测试通过。
6. **在 Langfuse 里看一次 trace**（需 Docker 和真实模型）：按上面的步骤启动 Langfuse，填好 `.env`，运行 `node days/day34/exercise/research.ts --trace "潮汐协议 3.0 有什么变化？"`，在 Langfuse 的 Traces 页面找到它。
7. **定位一次失败**：在第 31 天的评估结果里挑一条没通过的用例，带着 `--trace` 再问一次，从 trace 里找出它是在哪一步走偏的。

## 检查

```bash
npm run check 34
```

用真实模型跑一次研究，打印 trace；配了 `LANGFUSE_*` 就导出过去（需真实模型）：

```bash
npm run check 34 -- --e2e
```

## 小实验

- 跑一次 `/deep`（第 30 天）带着 tracer，在 Langfuse 里看三个子 Agent 的时间线：它们真的是同时跑的吗？谁最慢？
- 把 `deepResearch` 的 `concurrency` 改成 1，再看时间线，体会并行省了多少时间
- 打开 `captureContent`，看看 trace 里的 `gen_ai.input.messages` 有多大；算一算每天一千次研究，trace 存一个月要多少空间
- 故意让一个网页返回 500（改 `data/web.ts`），看 `findFailures` 能不能找到它，以及模型拿到错误以后做了什么
- 统计一次深度研究里输入 token 最多的 5 个 chat span，看看它们的上下文里都是什么

## 小结

- 追踪把一次运行记成一棵 span 的树：每次模型调用、工具调用、每个 Agent 都是一个 span
- 按 OpenTelemetry 的 GenAI 约定写名字和属性，导出 OTLP，换平台不用改代码；这套约定还在变，用前对照规范
- 给模型和工具包一层就能加上追踪；父 span 靠异步上下文自动传递，并行的任务不会串
- 导出要攒批、出错不影响主流程；用 Docker 自托管 Langfuse 来看 trace
- 定位失败找最底下的那个出错的 span；trace 里默认不记内容，要记先脱敏

## 想一想

- trace 显示模型服务返回了一次 503，子 Agent 因此没查完。第 9 天的重试已经试过三次了。能不能换一家模型接着跑？换了以后，报告的质量会不会变？（第 35 天）
- 一次深度研究跑了 4 分钟。用户愿意等吗？如果只给你 1 分钟，你会先放弃哪一步？（第 35 天）
- trace 显示一次研究里 70% 的输入 token 都是网页原文。怎么在不降分的前提下把它减下来？（第 36 天）

## 延伸阅读

- [OpenTelemetry：Semantic conventions for generative client AI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)：今天用到的属性的完整定义
- [OpenTelemetry：Semantic Conventions for GenAI agent and framework spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)：invoke_agent 等 Agent 相关的 span
- [Langfuse：OpenTelemetry](https://langfuse.com/docs/opentelemetry/get-started)：Langfuse 接收 OTLP 的地址、认证和属性的映射
- [Langfuse：Self-hosting](https://langfuse.com/self-hosting)：用 Docker Compose 自托管，以及上线时要注意的配置
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)：traceparent 请求头的标准
