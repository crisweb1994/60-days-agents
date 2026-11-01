# 第 2 天：拆开一次模型调用

> 最后核对：2026-11-01

第 1 天的 `chat()` 只有十来行，我们把它当成黑盒在用。今天把它拆开：请求里的每个字段是什么意思，回复里还藏着哪些信息，出错时接口会告诉你什么，一次调用到底花了多少钱。

写完以后，你的 Agent 每调用一次模型，都会打印这一次用了多少 token、花了多少钱：

```text
第 1 次调用：输入 326 tokens · 输出 38 tokens · 0.0010 元
第 2 次调用：输入 433 tokens（缓存命中 320） · 输出 112 tokens · 0.0012 元

MCP（Model Context Protocol）是一个开放协议……

合计 2 次调用：输入 759 tokens（缓存命中 320） · 输出 150 tokens · 0.0021 元
```

学完今天，你会：

- 不借助 SDK，写出一次完整的模型调用：请求、响应和错误处理
- 知道 messages 里的几种角色、system prompt 的作用，以及常用的采样参数
- 理解 token、上下文窗口和推理模型的思考 token
- 根据 usage 算出每次调用的花费，看清 Agent 的钱花在了哪里

## 先用 curl 发一次请求

调用模型就是发一个 HTTP 请求，用什么语言都一样。先在终端里用 curl 试一次，看看原始的请求和响应。

把 `.env` 里的变量导入当前终端，再发请求：

```bash
set -a; source .env; set +a

curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "'"$OPENAI_MODEL"'",
    "messages": [
      { "role": "system", "content": "你是一个说话简洁的助手。" },
      { "role": "user", "content": "用一句话介绍杭州。" }
    ]
  }'
```

返回的 JSON 大致是这样（不同的模型服务会多几个或少几个字段）：

```json
{
  "id": "chatcmpl-7f3a…",
  "object": "chat.completion",
  "created": 1793500000,
  "model": "…",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "杭州是浙江省会，以西湖和互联网产业闻名。" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 21,
    "completion_tokens": 14,
    "total_tokens": 35,
    "prompt_tokens_details": { "cached_tokens": 0 }
  }
}
```

整个过程没有任何魔法：一个 POST 请求，带一个 JSON 请求体，拿回一个 JSON。SDK 做的事情，就是帮你拼请求、解析响应、处理错误和重试。今天我们自己来做前三件，重试留到第 9 天。

## 请求：发给模型什么

### 地址和请求头

- **地址**：`{OPENAI_BASE_URL}/chat/completions`。各家的 OpenAI 兼容接口都用这个路径，区别只在前面的 base URL。
- **`Content-Type: application/json`**：告诉服务器请求体是 JSON。
- **`Authorization: Bearer <API Key>`**：证明你的身份，费用记在这个 Key 的账上。API Key 等同于密码，不要写进代码，也不要提交到 Git。课程把它放在 `.env` 里，`.gitignore` 已经排除了这个文件。

### messages：一段对话

`messages` 是一个数组，按时间顺序放着整段对话。每条消息都有 `role`，表示是谁说的：

| role | 谁说的 | 用来做什么 |
|---|---|---|
| `system` | 开发者 | 设定身份、规则和输出要求，通常放在第一条 |
| `user` | 用户 | 用户的问题和指令 |
| `assistant` | 模型 | 模型之前的回复，包括它发起的工具调用 |
| `tool` | 工具 | 工具的执行结果，用 `tool_call_id` 对应到某次调用 |

第 1 天说过，接口不保存对话。多轮对话的「记忆」完全来自你每次发过去的 `messages`：想让模型知道上一轮聊了什么，就把上一轮的问答也放进去。反过来，你也可以随意改写历史，比如删掉没用的工具结果、把很长的旧对话换成摘要。第 16 天会专门讲怎么做。

有的接口还支持 `developer` 角色，作用和 `system` 类似，但不是每家都支持。课程统一用 `system`。

### system prompt

system prompt 是你对模型的「岗位说明」。写好它，比调任何参数都管用。几条经验：

- **具体，可执行。** 「回答要专业」很难执行；「先查术语表；查不到就直说查不到，不要编造」容易执行，也容易检查。
- **说清楚边界。** 什么情况下该调用工具，什么情况下直接回答，不确定时怎么办。
- **把稳定的内容放在前面。** 很多模型服务会缓存请求开头相同的部分（后面讲花费时会细说），system prompt 和工具定义每次都一样，放在最前面最容易命中缓存。

它也没有什么特殊的魔力。它只是一条排在最前面的消息，模型会比较重视它，但不保证每条规则都照做。重要的约束，最好在代码里再检查一遍。

### 采样参数

模型生成文字时，每一步都会算出下一个 token 的概率分布，再从中抽一个。采样参数控制怎么抽：

| 参数 | 作用 | 常见用法 |
|---|---|---|
| `temperature` | 随机程度。越低越倾向于选概率最高的 token，越高越多样 | 抽取信息、调用工具时调低；写文案、头脑风暴时调高 |
| `top_p` | 只在累计概率排前 p 的 token 里抽 | 一般和 temperature 只调一个 |
| `max_tokens` | 这次最多输出多少 token | 防止输出过长；太小会被截断 |
| `stop` | 生成到这些字符串时停止 | 按固定格式生成时偶尔用到 |

几点要注意：

- **能不传就不传。** 各家的默认值一般就是推荐值。而且取值范围并不统一：OpenAI 和 DeepSeek 的 temperature 是 0–2，智谱 GLM 是 0–1；Kimi 的新模型固定 temperature，传了别的值会报错。
- **推理模型往往不认这些参数。** 比如 DeepSeek 在思考模式下会忽略 temperature，传了也不报错，但不起作用。
- **temperature 设成 0 也不保证每次输出完全一样。** 服务端的并行计算、批处理都会带来细微差异。想要稳定的结果，要靠提示词、结构化输出（第 4 天）和评估（第 31 天），不能只靠参数。

## 响应：模型回了什么

回到前面那段 JSON：

- **`choices`**：一个数组。请求里可以用参数 `n` 让模型一次生成多个候选，但几乎用不到，所以我们总是取 `choices[0]`。
- **`choices[0].message`**：模型这一轮的回复，结构和你发过去的 assistant 消息完全一样，所以可以原样追加到 `messages` 里。
- **`choices[0].finish_reason`**：模型为什么停下。`stop` 是正常说完，`length` 是达到 `max_tokens` 被截断，`tool_calls` 是要调用工具。各家还有一些自己的取值，第 6 天专门讲怎么处理。
- **`usage`**：这次用了多少 token，算钱就靠它。
- **`id` 和 `model`**：出问题找客服时，`id` 能帮对方定位请求；`model` 是实际处理请求的模型，有时和你填的名字不完全一样，比如你填的是别名，返回的是具体版本。

## token 与上下文窗口

### token 是什么

模型不直接处理字符，而是先用分词器把文字切成 token。常见的词往往是一个 token，生僻的字词会被切成好几块。计费、上下文长度、`max_tokens` 都按 token 算。

一段文字有多少 token，取决于模型用的分词器，同一段话在不同模型上算出来的数不一样。以 DeepSeek 的说明为例：1 个中文字符约 0.6 个 token，1 个英文字符约 0.3 个 token。估算可以用这个比例，准确的数字以接口返回的 `usage` 为准。

### 上下文窗口

上下文窗口是模型一次能处理的 token 上限，**输入和输出加在一起**不能超过它。超过了，接口要么直接报错，要么提前截断输出。

对 Agent 来说，这个限制来得比你想象的快。每一轮都要带上完整的历史：system prompt、工具定义、用户的问题、模型的每一次回复、每一个工具结果。工具结果尤其占地方，读一个网页、查一次数据库，随手就是几千 token。第 15、16 天会专门讲怎么在有限的窗口里放进最有用的内容。

## 推理模型与思考 token

推理模型回答之前，会先生成一段思考过程。DeepSeek、通义千问、GLM、Kimi 都把思考内容放在 `reasoning_content` 字段里，和 `content` 并列：

```json
{
  "role": "assistant",
  "reasoning_content": "用户问的是 MCP，术语表里应该有，先查一下……",
  "content": null,
  "tool_calls": [{ "id": "call_1", "…": "…" }]
}
```

和推理模型打交道，有四件事要知道。

**思考也要花钱。** 思考 token 按输出单价计费，算在 `completion_tokens` 里，有的模型服务还会在 `completion_tokens_details.reasoning_tokens` 里单独列出来。一个简单的问题，模型可能先想上几百个 token。

**思考一般也算在 `max_tokens` 里。** `max_tokens` 设得太小，模型可能还没想完就被截断，`content` 是空的，`finish_reason` 是 `length`。

**怎么开关，各家不一样。** 下表只是举例，参数随版本变化很快，以各家文档为准：

| 模型服务 | 开关思考的方式 |
|---|---|
| DeepSeek | 默认开启；`thinking: { "type": "disabled" }` 或 `reasoning_effort: "none"` 关闭 |
| 通义千问 | 混合思考模型用 `enable_thinking` 开关 |
| 智谱 GLM | `thinking: { "type": "enabled" }` 或 `"disabled"`，有的模型强制开启 |
| Kimi | 新模型始终开启，用 `reasoning_effort` 调节思考的深度 |

**思考内容要不要传回去，规则也不一样。** 这一条最容易出错：

- DeepSeek：请求里带了 `tools`，后面的每次请求都必须把 `reasoning_content` 完整传回去，否则直接返回 400
- Kimi：新模型在多轮对话和工具调用里都要求原样传回完整的 assistant 消息
- GLM：交错思考配合工具调用时，必须在返回工具结果时一并带上思考内容

结论很简单：**把模型的回复原样放回历史，不要只挑 `content` 和 `tool_calls`。** 第 1 天的 `messages.push(reply)` 恰好就是这么做的。今天写 `chat()` 时也要注意：返回整个 `message` 对象，不要自己重新拼一个。第 8 天讲 Anthropic 协议时，还会看到另一套思考内容的回传规则。

## 一次调用花多少钱

### 单价

模型按 token 计费，单价一般写成「每百万 token 多少钱」，分三档：

- **输入（未命中缓存）**：正常价格
- **输入（命中缓存）**：通常只要正常价格的几分之一，甚至更低
- **输出**：通常是输入单价的好几倍

### 提示缓存

很多模型服务会自动缓存请求开头的内容。后一次请求的开头和之前的某次请求一样时，相同的部分直接从缓存里取，按缓存价计费，也更快。DeepSeek 的上下文硬盘缓存就默认对所有用户开启，不用改代码。缓存是「尽力而为」的，不保证每次都命中，建立缓存也需要几秒钟。

Agent 天生适合缓存：每一轮的请求，开头都是同样的 system prompt、同样的工具定义、同样的历史，只在末尾多出几条新消息。开头那个例子里，第 2 次调用的 433 个输入 token 里有 320 个命中了缓存。前提是你不去改动前面的内容。比如在 system prompt 里放一个每次都变的时间戳，后面的内容就全都命不中了。第 15 天会细讲怎么让缓存命中率更高。

### 计算公式

```text
花费 = (输入 − 缓存命中) × 输入单价
     + 缓存命中 × 缓存单价
     + 输出 × 输出单价
     （单价按百万 token 计，最后除以 1,000,000）
```

假设单价是输入 2 元、缓存命中 0.2 元、输出 8 元（每百万 token，只是举例，真实价格以价格页为准），开头那个例子的第 2 次调用：

```text
(433 − 320) × 2 + 320 × 0.2 + 112 × 8 = 226 + 64 + 896 = 1186
1186 / 1,000,000 ≈ 0.0012 元
```

注意输出那一项：112 个输出 token 的花费，比 433 个输入 token 加起来还多。回答写得越长、模型想得越多，越贵。

### 各家的 usage 字段

`prompt_tokens` 和 `completion_tokens` 各家都有，缓存和思考的字段名却不统一：

| 字段 | 含义 | 谁在用 |
|---|---|---|
| `prompt_tokens_details.cached_tokens` | 命中缓存的输入 token | OpenAI、DeepSeek、Kimi、GLM、通义千问 |
| `prompt_cache_hit_tokens` | 同上 | DeepSeek 自己的字段，值和上一行相同 |
| `completion_tokens_details.reasoning_tokens` | 思考 token | OpenAI、DeepSeek、Kimi、通义千问 |

所以要写一个 `parseUsage()`，先把各家的写法统一成自己的 `Usage` 类型，后面的代码只认 `Usage`。这是第一次遇到「兼容接口不完全一样」，后面还会遇到很多次，第 8 天会系统地讲。

### Agent 的钱花在哪

Agent 每一轮都要把完整的历史重新发一遍，输入会越滚越大：

| 调用 | 输入里有什么 | 输入 token |
|---|---|---|
| 第 1 次 | system + 工具定义 + 问题 | 326 |
| 第 2 次 | 上面这些 + 工具调用 + 工具结果 | 433 |
| 第 n 次 | 上面这些 + 每一轮新增的内容 | 越来越多 |

第 n 次调用的输入，包含了前面所有轮次的内容。粗略地说，一个跑 n 轮的 Agent，输入 token 的总量随 n 的平方增长。这就是为什么缓存和上下文管理对 Agent 格外重要，也是为什么第 36 天要专门讲成本。

## 出错的时候

请求失败时，HTTP 状态码说明了大致的原因：

| 状态码 | 常见原因 | 该怎么办 |
|---|---|---|
| 400 | 请求格式不对、参数不合法、上下文超长 | 看错误信息，改请求。重试没用 |
| 401 | API Key 不对或没填 | 检查 Key |
| 402 | 余额不足（DeepSeek） | 充值 |
| 422 | 参数错误（DeepSeek） | 看错误信息，改请求 |
| 429 | 请求太快，或者额度用完了 | 前者等一会儿再试，后者重试没用 |
| 500、503 | 服务端出错或过载 | 等一会儿再试 |

错误体通常是这样的 JSON：

```json
{ "error": { "message": "Incorrect API key provided", "type": "invalid_request_error", "code": "invalid_api_key" } }
```

但也不一定。请求可能还没到模型服务，就被中间的网关或代理拦下了，返回的是一页 HTML。所以解析错误体时，JSON 解析失败要退回到原文。

429 值得多说一句。它不一定是「太快了」：OpenAI 额度用完会返回 429 和 `insufficient_quota`，智谱 GLM 欠费是 429 加业务码 1113，Kimi 也把额度用尽归在 429 下面。这种情况重试一万次也没用。所以今天的 `ModelError` 除了状态码，还要把错误体里的 `code`、`type` 和响应头都留下来，第 9 天写重试时要靠它们判断。

## 读懂练习代码

今天的代码从第 1 天的 `agent.ts` 里拆出了几个文件：

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [types.ts](exercise/types.ts) | 消息、工具定义、请求和回复的类型 | 读懂即可 |
| [openai.ts](exercise/openai.ts) | 调用 OpenAI 兼容接口的 `chat()` | TODO 1、2 |
| [errors.ts](exercise/errors.ts) | `ModelError` 和 `toModelError()` | TODO 3 |
| [usage.ts](exercise/usage.ts) | 解析用量、计算和显示花费 | TODO 4、5 |
| [agent.ts](exercise/agent.ts) | 第 1 天的 Agent，改用新的 `chat()`，并统计用量 | 读懂即可 |

### 请求和回复的类型

```ts
export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface ChatResult {
  message: AssistantMessage;
  finishReason: string;
  usage: Usage;
}
```

`ChatRequest` 用的是 TypeScript 习惯的驼峰命名，发请求前再转成接口要的 `top_p`、`max_tokens`。`ChatResult` 只留下 Agent 用得到的三样东西。这样上层的代码不用关心接口的具体格式，第 8 天接入第二种协议时，只要把这一层换掉。

### openai.ts：拼请求，读响应

`toRequestBody()`（TODO 1）把 `ChatRequest` 转成请求体。有个小技巧：值为 `undefined` 的字段，`JSON.stringify` 会直接跳过：

```ts
JSON.stringify({ model: 'x', temperature: undefined }); // '{"model":"x"}'
```

所以没传的参数直接写成 `temperature: request.temperature` 就行，不用写一堆 `if`。只有 `tools` 要特别处理：有的接口不接受空数组，没有工具时干脆不带这个字段。

`chat()`（TODO 2）发出请求后：状态码不是 2xx，就用 `toModelError()` 生成错误抛出去；成功的话，取出 `choices[0]`，把 `message`、`finish_reason` 和转换后的 `usage` 交回去。

### errors.ts：读出错误信息

`ModelError` 已经写好了，它比普通的 `Error` 多了 `status`、`code`、`type` 和 `headers` 四个字段。你要写的是 `toModelError()`（TODO 3）：先用 `res.text()` 读出响应体，再试着解析 JSON。注意响应体只能读一次，先 `res.json()` 失败了再 `res.text()` 是读不出来的。

### usage.ts：从 token 到钱

`parseUsage()`（TODO 4）把各家的 usage 统一成：

```ts
export interface Usage {
  inputTokens: number;     // 输入 token，包括命中缓存的部分
  cachedTokens: number;    // 输入里命中缓存的部分
  outputTokens: number;    // 输出 token，包括思考的部分
  reasoningTokens: number; // 输出里思考的部分
}
```

`calcCost()`（TODO 5）按上面的公式算钱。`addUsage()`、`parsePrice()` 和 `formatUsage()` 已经写好了。

### agent.ts：统计每次调用

Agent 的循环和第 1 天一样，只多了几行：每次调用完，把这一次的用量累加起来，再通过 `onUsage` 回调交给调用方；最后返回回答和总用量：

```ts
const result = await chat({ messages, tools });
usage = addUsage(usage, result.usage);
onUsage?.(result.usage);
```

想看到花费，在 `.env` 里填上单价，格式是「输入,缓存命中的输入,输出」，单位是元/百万 token：

```bash
OPENAI_PRICE=2,0.2,8
```

单价以你所用模型服务的价格页为准。不填也能运行，只是不显示花费。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 用 SDK 才能调模型 | 就是一个 HTTP 请求，SDK 只是帮你拼请求、处理错误和重试 |
| temperature 设成 0，输出就完全固定 | 只是更稳定，不保证完全一样 |
| system prompt 里写了，模型就一定照做 | 它会更重视，但不保证。重要的约束要在代码里检查 |
| 只有回答才花钱 | 输入也花钱，而且 Agent 每一轮都重发完整的历史；思考也按输出计费 |
| 429 就是请求太快 | 额度用完、欠费也可能返回 429，这时重试没用 |

## 常见错误

| 报错 | 原因 |
|---|---|
| `tools 不能是空数组` | 没有工具时也带上了 `tools: []`。没有工具就不要带这个字段 |
| `Body is unusable: Body has already been read` | 先调用了 `res.json()`，失败后又调用 `res.text()`。响应体只能读一次，先 `text()` 再 `JSON.parse` |
| 测试说返回的 `message` 是 `undefined` | 写成了 `data.choices.message`。`choices` 是数组，要取 `choices[0]` |
| 测试说 `reasoning_content` 不见了 | 自己拼了一个只有 `content` 和 `tool_calls` 的新对象。直接返回 `choices[0].message` |
| 花费大得离谱 | 忘了除以 1,000,000。单价是按百万 token 算的 |

## 动手：手写 chat()，算出每次调用的花费

建议按顺序做，每做完一步就运行一次 `npm run check 2`：

1. **TODO 1、2**：拼请求体、处理成功的响应。完成后，发请求、返回回复的几个测试会先通过。
2. **TODO 3**：读出错误信息。完成后，三个错误处理的测试会通过。
3. **TODO 4**：解析 usage。先处理 OpenAI 的写法，再补上 DeepSeek 的 `prompt_cache_hit_tokens`。
4. **TODO 5**：计算花费。全部测试通过，就完成了。

## 检查

```bash
npm run check 2
```

通过以后，用真实模型验证一次：

```bash
npm run check 2 -- --e2e
```

## 小实验

先在 `.env` 里填好 `OPENAI_PRICE`，然后：

- 运行 `node days/day02/exercise/agent.ts "Agent 和 MCP 有什么关系？"`，看看每一次调用的输入是怎么增长的，第二次调用有没有命中缓存
- 同一个问题马上再问一遍，缓存命中的 token 是不是变多了
- 在 `runAgent` 里把 `chat({ messages, tools })` 改成带上 `maxTokens: 20`，看看回答是怎么被截断的
- 用 curl 发同一个问题，分别设 `"temperature": 0` 和 `"temperature": 1.5`（GLM 最高是 1），各发三次，比较回答的差异
- 如果你用的是推理模型，看看 `reasoningTokens` 占了输出的多少
- 把 `.env` 里的 API Key 故意改错一个字母再运行，看看你的 `ModelError` 给出的信息够不够清楚

## 小结

- 调用模型就是一个 HTTP POST：地址、两个请求头、一个 JSON 请求体。
- `messages` 是整段对话，接口不保存任何状态，记忆全靠你发过去的历史。
- 采样参数能不传就不传；各家的范围不同，推理模型往往不认。
- token 是计费和长度的单位。输入、输出、缓存命中三档分别计价，思考 token 按输出计费。
- 推理模型的回复要原样放回历史，包括 `reasoning_content`。
- 出错时留下状态码、错误码和响应头，后面的重试要靠它们判断。

## 想一想

- 模型要好几秒才能生成完一段长回答，用户只能干等。能不能边生成边显示？（第 3 天）
- 想让模型返回一个 JSON 对象，而不是一段话，怎么保证格式一定对？（第 4 天）
- 一个跑 20 轮的 Agent，输入 token 的总量大约是跑 5 轮的多少倍？有什么办法降下来？（第 15、16、36 天）

## 延伸阅读

- [DeepSeek：Token 用量计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage)和[上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache)：缓存怎么命中、怎么查看命中情况
- [DeepSeek：思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)：思考内容的回传规则，以及思考模式下哪些参数不生效
- [Kimi：使用思考模型](https://platform.kimi.com/docs/guide/use-thinking-models)、[智谱：深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[通义千问：深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)：对比一下各家的开关方式和回传规则
- [How to generate text](https://huggingface.co/blog/how-to-generate)：用图解释 greedy、beam search、temperature 和 top-p 采样
