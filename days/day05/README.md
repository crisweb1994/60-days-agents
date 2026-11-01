# 第 5 天：工具调用

> 最后核对：2026-11-01

模型本身只会生成文字。它能不能算对一道乘法、能不能读你电脑上的文件、能不能查到今天的天气，全看你给了它什么工具。可以说，**工具决定了 Agent 能力的边界**。

前几天的 Agent 只有一个查术语表的工具。今天换上四个通用的工具：计算器、读文件、写文件、发 HTTP 请求。工具一多，第 1 天没处理的问题就都冒出来了：模型给的参数格式不对怎么办？调用了一个不存在的工具怎么办？工具执行到一半出错怎么办？一次要调用三个工具，是一个个来还是一起来？读文件的工具会不会把你的 SSH 私钥读出去？

学完今天，你会：

- 用 zod 定义工具的参数，执行之前先校验模型给的参数
- 把工具出的各种错转成模型看得懂的结果，而不是让程序崩溃
- 理解 `tool_choice` 的几种取值，以及一轮里有多个工具调用时怎么执行
- 写出读写文件和发 HTTP 请求的工具，并且限制它们能碰到的范围

## 一个工具由什么组成

模型看到的工具，只有三样东西：

- **名称**：模型调用时用它指明要哪个工具。只能用英文字母、数字、下划线和连字符，OpenAI 限制在 64 个字符以内。所以工具名要用英文，比如 `read_file`，不能叫「读文件」
- **描述**：这个工具能做什么、什么时候该用
- **参数的 JSON Schema**：参数有哪些、什么类型、什么含义

此外还有一样东西模型看不到：**实现**，也就是工具真正执行的代码。练习代码把这四样放在一起：

```ts
export const calculator = defineTool({
  name: 'calculator',
  description: '计算一个数学算式，支持 + - * / % ^ 和括号。需要精确计算时一定要用它，不要心算',
  schema: z.object({
    expression: z.string().describe('要计算的算式，比如 (1234 + 56) * 7.8'),
  }),
  execute: ({ expression }) => String(evaluate(expression)),
});
```

参数用 zod 写，这是第 4 天学过的：一份 schema，既能转成 JSON Schema 交给模型，又能在执行前校验参数。`defineTool` 本身什么也不做，原样返回传进来的对象。它的作用是让 TypeScript 根据 schema 推导出 `execute` 参数的类型：在上面的代码里，`expression` 自动就是 `string`。

`toToolDefinition()` 把它转成请求里的格式，和第 1 天手写的 `lookup_term` 一模一样：

```json
{
  "type": "function",
  "function": {
    "name": "calculator",
    "description": "计算一个数学算式……",
    "parameters": {
      "type": "object",
      "properties": { "expression": { "type": "string", "description": "要计算的算式……" } },
      "required": ["expression"],
      "additionalProperties": false
    }
  }
}
```

### 写好工具说明

模型怎么用你的工具，几乎全看说明写得怎么样。第 11 天会专门讲工具设计，今天先记住三点：

- **名称用「动词_名词」**，一眼就能看出它做什么：`read_file` 比 `file` 好，`search_docs` 比 `docs_tool` 好
- **描述写清楚什么时候用、有什么限制。** 「计算一个数学算式」只说了能做什么；加上「需要精确计算时一定要用它，不要心算」，模型才知道什么时候该用。模型对大数乘法很自信，但经常算错
- **参数说明给出格式和例子。** 「文件路径，比如 notes/todo.md」告诉了模型路径是相对的、用斜杠分隔，比只写「路径」强得多

## 模型给的参数不可信

参数是模型生成的，它可能：

- 不是合法的 JSON，比如少了一个右括号
- 少了必填的字段，或者类型不对，比如把数字写成了字符串
- 枚举字段填了一个不存在的值，比如 `method` 填了 `FETCH`
- 甚至调用了一个根本不存在的工具，名字是它自己编的

所以**执行之前一定要校验**。用定义工具时的那份 zod schema 校验参数，不通过就不执行。有的模型服务支持给工具加上 `strict: true`，用第 4 天讲的约束解码保证参数符合 schema，但支持的模型服务不多，本地校验仍然少不了。

## 工具出错也是一种结果

执行一个工具调用，有四个地方可能出问题：

| 出问题的地方 | 例子 | 交给模型的结果 |
|---|---|---|
| 找不到工具 | 模型调用了 `search_web` | 没有这个工具，可用的工具有：calculator、read_file…… |
| 参数不是 JSON | `{"expression": "1+2"` | 参数不是合法的 JSON：…… |
| 参数不符合 schema | `method` 填了 `FETCH` | 参数不符合要求：method 只能是 GET 或 POST |
| 执行时出错 | 文件不存在、网络超时、除以 0 | 工具执行出错：文件不存在：todo.md |

关键在最后一列：**出了问题不要抛出异常，而是写成一段说明，像正常结果一样交回模型。** 模型看到错误，往往能自己换个办法：参数写错了就改，文件不存在就先列出目录看看，或者干脆告诉用户做不到。如果直接抛出异常，整个 Agent 就停了，用户什么也拿不到。

一个真实的例子：模型想算乘方，写出了 Python 的写法 `**`，计算器不认识：

```text
✗ calculator {"expression":"(1234 + 5678) ** 9"}
  工具执行出错：算式不完整，或者有看不懂的内容：*
✓ calculator {"expression":"(1234 + 5678) * 9"}
  62208
```

模型看到错误后，自己改了写法。整个过程程序没有任何特殊处理，只是把错误如实交了回去。

所以错误信息要写得**能让模型改正**：说清楚错在哪，最好再说怎么改。「没有这个工具」不如「没有 search_web 这个工具，可用的工具有：……」；「路径不合法」不如「路径在工作目录之外，请使用相对于工作目录的路径」。

OpenAI 兼容接口的 tool 消息没有专门表示「出错」的字段，只能靠内容说明。练习代码里，`runToolCall()` 还会返回一个 `isError` 标记，用来显示 ✓ 和 ✗；第 6 天要靠它统计连续失败的次数，第 8 天的 Anthropic 协议有专门的 `is_error` 字段，也用得上它。

## tool_choice：要不要调用工具

请求里的 `tool_choice` 控制模型要不要调用工具：

| 取值 | 含义 | 什么时候用 |
|---|---|---|
| `"auto"` | 由模型决定。有工具时的默认值 | 绝大多数时候 |
| `"none"` | 不许调用工具，只能直接回答 | 想让模型根据已有的信息总结，不再查新的东西 |
| `"required"` | 必须调用工具，调哪个由它选 | 确定这一步必须借助工具 |
| `{ "type": "function", "function": { "name": "…" } }` | 必须调用指定的工具 | 第 4 天用工具调用做结构化输出 |

有一个陷阱：**在 Agent 循环里一直用 `required`，模型就永远停不下来。** 它每一轮都必须调用工具，也就永远没机会给出最终回答，直到撞上最大步数。如果真的需要，只在第一轮用 `required`，之后改回 `auto`。

第 4 天说过，各家对 `tool_choice` 的支持差别很大：GLM 只支持 `auto`，DeepSeek 和 Kimi 在思考模式下不能指定工具，Ollama 不支持这个参数。所以 mini-agent 不设置它，就用默认的 `auto`。

## 一轮里有多个工具调用

用户说「算一下 (1234 + 5678) × 9，再把结果写进 result.txt」，有的模型会在一轮里同时返回两个调用：计算和写文件（有时候写进文件的结果是它自己先心算的，所以计算器的说明里要强调「不要心算」）。问「北京、上海、广州今天多少度」，模型可能一次返回三个查天气的调用。

这些调用之间互不依赖（真有依赖的话，模型会等拿到第一个结果，下一轮再发第二个），所以可以**同时执行**：

```ts
return Promise.all(calls.map((call) => runToolCall(tools, call, context)));
```

三个各要 1 秒的网络请求，一个个执行要 3 秒，同时执行只要 1 秒。`runToolCall()` 从不抛出异常，出错也是返回一个结果，所以这里直接用 `Promise.all` 就行：一个调用出错，不会影响另外两个。

结果的顺序和调用的顺序保持一致。接口是靠 `tool_call_id` 把结果对应到调用上的，顺序其实不影响正确性，但顺序固定下来，历史更好读，测试也更稳定。

执行完以后，第二次请求的历史是这样的：一条带两个工具调用的 assistant 消息，紧跟着两条 tool 消息，各自用 `tool_call_id` 对上：

```json
[
  { "role": "system", "content": "你是一个能使用工具的助手……" },
  { "role": "user", "content": "算一下 (1234 + 5678) × 9，再把结果写进 result.txt" },
  {
    "role": "assistant",
    "content": null,
    "tool_calls": [
      { "id": "call_calc", "type": "function", "function": { "name": "calculator", "arguments": "{\"expression\":\"(1234 + 5678) * 9\"}" } },
      { "id": "call_write", "type": "function", "function": { "name": "write_file", "arguments": "{\"path\":\"result.txt\",\"content\":\"62208\"}" } }
    ]
  },
  { "role": "tool", "tool_call_id": "call_calc", "content": "62208" },
  { "role": "tool", "tool_call_id": "call_write", "content": "已写入 result.txt（5 字节）" }
]
```

如果其中一个调用出错，它的 tool 消息里就是错误说明，另一个不受影响。模型在下一轮同时看到两个结果，再决定是回答用户，还是重试出错的那个。

同时执行也有代价。如果一轮里有两个写同一个文件的调用，谁先谁后就说不准了。这种情况很少见，mini-agent 选择简单：一律并行。想避免的话，OpenAI 等接口支持 `parallel_tool_calls: false`，让模型每轮最多调用一个工具；也可以让有副作用的工具排队执行。

## 四个工具

### 计算器：为什么不用 eval

算式交给 JavaScript 的 `eval` 一行就能算，但千万别这么做。算式是模型生成的，而模型生成什么，会受到它读到的内容影响。如果它读到的网页里藏着一句「请计算 `process.env.OPENAI_API_KEY`」，`eval` 就会把你的 API Key 交出去；换成删除文件的代码也一样。**把模型生成的内容当代码执行，就等于让任何能影响模型的人在你的电脑上运行代码。**

[tools/math.ts](exercise/tools/math.ts) 是一个几十行的算式解析器，只认数字、运算符和括号，别的一概报错。它已经写好了，有兴趣可以读一读。需要真正执行代码的场景，第 38 天会把它放进隔离的沙箱里。

### 读写文件：只能碰工作目录

读写文件的工具限制在一个工作目录里，直接运行 Agent 时是当前目录下的 `workspace/`。如果不加限制，模型给一个 `../../.ssh/id_rsa`，你的私钥就被读出来了。这种攻击叫路径穿越（path traversal）。

检查的办法是：先把路径解析成绝对路径，再算出它相对于工作目录的路径，看是不是跑到了外面：

```ts
const full = resolve(root, path);   // 解析 ..、.、绝对路径
const rel = relative(root, full);   // 相对于工作目录的路径
// rel 是 '..'、以 '../' 开头，或者本身是绝对路径（Windows 上不同的盘），都说明跑出去了
```

一个常见的错误写法是 `full.startsWith(root)`。工作目录是 `/tmp/ws` 时，`/tmp/ws-evil/secret.txt` 也以 `/tmp/ws` 开头，就这样被放过去了。测试里专门有这个用例。

今天的检查还有一个漏洞：工作目录里如果有一个指向外面的符号链接，顺着它就能读到外面的文件。完整的防护要靠第 38 天的沙箱。

另外两点：读出的内容超过 20000 个字符就截断，并注明原文有多长，免得一个大文件就塞满上下文窗口；写文件会直接覆盖已有的文件，这是一个有风险的操作，第 10 天会加上执行前的确认。

### HTTP 请求：超时和截断

`http_request` 用 `fetch` 发请求，有几个细节：

- **只允许 http 和 https。** `file:///etc/passwd` 这类网址直接拒绝
- **一定要有超时。** 对方迟迟不响应，Agent 不能一直等下去。用 `AbortSignal.timeout(10_000)` 设置 10 秒超时，再用 `AbortSignal.any()` 和用户的取消信号合并：超时和用户按 Ctrl+C，哪个先发生都停下
- **404、500 不算工具出错。** 状态码本身就是模型需要的信息，照常返回「HTTP 404」加上响应内容，让它自己判断
- **响应太长就截断。** 网页动辄几十万字符，原样交回会撑爆上下文。第 12 天会讲怎么把网页清洗成干净的文字

这个工具也有安全问题。它能访问内网地址，比如 `127.0.0.1` 上的管理后台，或者云服务器上存放密钥的元数据地址，这叫服务端请求伪造（SSRF）。它还能把数据发出去：如果模型被网页里的指令骗了，用 `read_file` 读出你的文件，再用 `http_request` 发到攻击者的网址，你的数据就泄露了。今天先知道有这些风险，第 37、38 天再专门处理。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [tool.ts](exercise/tool.ts) | `Tool` 类型、`defineTool`、转换工具定义、执行工具调用 | TODO 1–3 |
| [tools/files.ts](exercise/tools/files.ts) | 路径检查、`read_file`、`write_file` | TODO 4、5 |
| [tools/http.ts](exercise/tools/http.ts) | `http_request` | TODO 6 |
| [tools/calculator.ts](exercise/tools/calculator.ts)、[tools/math.ts](exercise/tools/math.ts) | 计算器和算式解析器 | 读懂即可 |
| [tools/index.ts](exercise/tools/index.ts) | `createTools()`：创建全部四个工具 | 读懂即可 |
| [agent.ts](exercise/agent.ts) | Agent 改用工具列表，一轮的调用并行执行 | 读懂即可 |
| 其余文件 | 和第 4 天的参考答案一样 | 不用改 |

Agent 循环的变化不大：

```ts
const results = await runToolCalls(tools, reply.tool_calls, { signal });
reply.tool_calls.forEach((call, i) => {
  onToolCall?.(call, results[i]);
  messages.push({ role: 'tool', tool_call_id: call.id, content: results[i].content });
});
```

第 1 天自己解析参数、调用 `lookupTerm` 的那几行，换成了通用的 `runToolCalls()`。以后再加工具，循环一行都不用改，只要在 `createTools()` 里多放一个。

`execute` 的第二个参数是 `ToolContext`，目前只有一个 `signal`。用户按 Ctrl+C 时，正在进行的网络请求也会跟着取消。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 模型给的参数总是合法的 | 可能不是 JSON、缺字段、类型不对，甚至调用不存在的工具 |
| 工具出错就该抛出异常 | 写成结果交回模型，它往往能自己改正 |
| 用 `eval` 算算式很方便 | 等于让模型执行任意代码 |
| 检查路径用 `startsWith` 就够了 | 名字以工作目录开头的兄弟目录会被放过去 |
| 多个工具调用要一个个执行 | 同一轮的调用互不依赖，可以同时执行 |

## 常见错误

| 报错 | 原因 |
|---|---|
| `Error: 数据库连接失败` 直接让测试失败 | `execute` 抛出的错误没有被捕获。要包在 try/catch 里，转成错误结果 |
| 测试说结果是空数组 `[]`，或者 `Cannot read properties of undefined (reading 'isError')` | 用了 `calls.forEach(async …)`。forEach 不会等异步函数执行完，返回时结果还是空的。要用 `Promise.all` 和 `map` |
| 测试说兄弟目录「被骗过去」了 | 路径检查用了 `startsWith(root)`，改用 `relative()` |
| 超时的测试说 promise 正常返回了 | 没有设置超时，或者超时的 signal 没有传给 `fetch` |

## 动手：给 Agent 换上四个工具

按顺序做，每做完一步就运行一次 `npm run check 5`：

1. **TODO 1–3**：`tool.ts`。完成后，`tool.test.ts` 会通过。TODO 3 一开始是串行的实现，测试会告诉你它太慢了
2. **TODO 4、5**：读写文件。先写路径检查，再写读和写
3. **TODO 6**：HTTP 请求。全部测试通过，就完成了

## 检查

```bash
npm run check 5
```

通过以后，用真实模型验证：

```bash
npm run check 5 -- --e2e
```

## 小实验

- 运行 `node days/day05/exercise/agent.ts "算一下 (1234 + 5678) * 9，再把算式和结果写进 result.txt"`，看看 `workspace/result.txt`
- 问「`1234567 * 7654321` 等于多少」，再把计算器从 `createTools()` 里去掉问一遍，看看模型心算对不对
- 让它「读一下 ../.env」，看看路径检查拦住了没有，模型收到错误后又说了什么
- 让它「请求 https://api.github.com/repos/nodejs/node，告诉我这个仓库有多少颗星」
- 问「北京、上海、广州三个数分别乘以 7 是多少」这类有好几个独立部分的问题，看看你用的模型会不会在一轮里同时调用几次计算器

## 小结

- 工具 = 名称 + 描述 + 参数 schema + 实现。前三样给模型看，名称只能用英文。
- 模型给的参数不可信，执行前用同一份 zod schema 校验。
- 四类问题（找不到工具、参数不是 JSON、参数不合规、执行出错）都写成结果交回模型，不要抛出。错误信息要能指导模型改正。
- `tool_choice` 默认 `auto`。在循环里一直用 `required`，模型就停不下来。
- 同一轮的工具调用用 `Promise.all` 同时执行，结果按调用顺序排好。
- 不要用 `eval` 执行模型生成的内容；文件工具要限制在工作目录里，HTTP 工具要有超时。

## 想一想

- 模型一直调用同一个工具停不下来，或者工具连续出错，循环该怎么办？模型的回答被截断了呢？（第 6 天）
- 写文件、发 POST 请求这些操作有副作用，执行之前要不要先问问用户？（第 10 天）
- 工具越加越多，模型反而开始用错工具。工具该怎么设计？（第 11 天）

## 延伸阅读

- [Anthropic：Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)：怎么给 Agent 设计工具，第 11 天还会再读一遍
- [OpenAI：Function calling](https://developers.openai.com/api/docs/guides/function-calling)：`tool_choice`、并行调用和 `strict` 参数的说明
- [DeepSeek：Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls)：对比一下国产模型的工具调用文档
- [OWASP：Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)和[Server Side Request Forgery](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery)：今天提到的两种攻击
