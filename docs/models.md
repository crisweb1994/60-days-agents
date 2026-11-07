# 模型接入说明

> 最后核对：2026-11-07

课程代码默认通过 OpenAI 兼容接口调用模型，第 8 天起同时支持 Anthropic 兼容接口。模型名和接口细节变化很快，讲义里不写死，统一以本页和 `.env.example` 为准。

<!-- TODO: 写明默认模型，以及 CI 用哪个模型跑 e2e 验证 -->
<!-- TODO: 逐家补上是否提供 embedding 和视觉模型 -->

## 接口地址

| 模型服务 | OpenAI 兼容接口（OPENAI_BASE_URL） | Anthropic 兼容接口（ANTHROPIC_BASE_URL） |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `https://api.deepseek.com/anthropic` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/apps/anthropic` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `https://open.bigmodel.cn/api/anthropic` |
| Kimi | `https://api.moonshot.cn/v1` | `https://api.moonshot.cn/anthropic` |
| MiniMax | `https://api.minimaxi.com/v1` | `https://api.minimaxi.com/anthropic` |
| 本地 Ollama | `http://localhost:11434/v1` | `http://localhost:11434` |

以上地址都在 2026-11-01 用不带 API Key 的请求验证过：返回的是 401 或 403（地址存在、需要认证），而不是 404。Anthropic 兼容接口的地址不带 `/v1`，客户端会在后面加上 `/v1/messages`。

注意：通义千问、智谱 GLM 等模型服务的编程套餐（Coding Plan）有单独的接口地址和 API Key，和按量计费的不通用。

## 已知的兼容差异

「兼容」只是说请求和响应的格式大体一样，细节上各家差别不小。下面是课程里遇到、并核对过官方文档的差异。

### OpenAI 兼容接口

- **usage 的字段名**：缓存命中的 token 一般在 `prompt_tokens_details.cached_tokens`，DeepSeek 另有 `prompt_cache_hit_tokens`；思考 token 在 `completion_tokens_details.reasoning_tokens`，GLM 的文档里没有这个字段。（第 2 天）
- **流式时 usage 在哪一块**：OpenAI、Kimi、通义千问放在单独的最后一块（`choices` 为空数组）；DeepSeek 和 GLM 挂在带 `finish_reason` 的最后一块上。（第 3 天）
- **思考内容的回传**：DeepSeek 在请求带了 `tools` 时，要求之后的每次请求都完整传回 `reasoning_content`，否则返回 400；Kimi 的新模型要求原样传回完整的 assistant 消息；GLM 在交错思考配合工具调用时要求传回。所以课程代码总是把回复原样放回历史。（第 2 天）
- **采样参数**：temperature 的范围 OpenAI 和 DeepSeek 是 0–2，GLM 是 0–1；Kimi 的新模型固定 temperature，传别的值会报错；DeepSeek 在思考模式下忽略 temperature。（第 2 天）
- **response_format**：DeepSeek 和 GLM 只支持 `text` 和 `json_object`；Kimi 和通义千问还支持 `json_schema`（通义千问只有部分模型支持）。`json_object` 要求提示词里出现 json，DeepSeek 在这个模式下可能返回一段空白。（第 4 天）
- **tool_choice**：GLM 只支持 `auto`；DeepSeek 和 Kimi 在思考模式下不能指定工具；通义千问不支持 `required`；Ollama 不支持这个参数。（第 4、5 天）
- **finish_reason 的额外取值**：GLM 有 `sensitive`（内容审核拦截）、`network_error`（推理异常）、`model_context_window_exceeded`；DeepSeek 有 `insufficient_system_resource`、`aborted`；Kimi 的内容审核以 HTTP 400 错误返回，不是 `finish_reason`。（第 6 天）
- **工具参数的流式发送**：GLM 默认不分块发送工具参数，要加 `tool_stream` 参数。（第 3 天）

### Anthropic 兼容接口

- **认证方式**：官方接口以 `Authorization: Bearer` 为主、`x-api-key` 兼容保留；DeepSeek 和智谱 GLM 两种都接受；Kimi 和 Ollama 云端用 Bearer；MiniMax 只认 `x-api-key`，只带 Bearer 会被拒绝。课程代码两个请求头都带上。（第 8 天）
- **错误格式各不相同**：同样是缺少 API Key，DeepSeek 返回纯文本，智谱 GLM 和 Kimi 返回 OpenAI 风格的 `{ "error": { … } }`，通义千问把 `message` 放在最外层，MiniMax 返回 Anthropic 风格的 `{ "type": "error", "error": { … } }`。（第 8 天）
- **忽略的字段**：DeepSeek 忽略 `anthropic-version`、`cache_control`、`budget_tokens`、`disable_parallel_tool_use`，并且把 `tool_choice: any` 当作 `auto`，不支持 `redacted_thinking`；Ollama 不支持 `tool_choice` 和 `cache_control`，出错时不发 SSE 的 error 事件。（第 8 天）
- **模型名**：有的服务会把 Claude 的模型名映射成自己的模型（比如 DeepSeek），但最好在 `ANTHROPIC_MODEL` 里明确写上它自己的模型名。
- **停止原因**：有的服务只返回一部分取值，比如 Kimi 的文档只列了 `end_turn`、`max_tokens`、`tool_use`、`refusal`。

## Embedding（第 17 天起）

embedding 走 OpenAI 兼容的 `POST …/embeddings`：`{ model, input: [文字……] }` → `{ data: [{ index, embedding }] }`。配置在 `EMBEDDING_*` 里，地址和 Key 不填时沿用 `OPENAI_*`。

| 模型服务 | 接口地址（EMBEDDING_BASE_URL） | 说明 |
|---|---|---|
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 和对话同一个地址、同一个 Key |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 和对话同一个地址、同一个 Key |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 提供多种开源的 embedding 和重排模型 |
| 本地 Ollama | `http://localhost:11434/v1` | 先 `ollama pull` 一个 embedding 模型 |
| DeepSeek | — | 文档里没有 embedding 接口，要另选一家 |

以上地址在 2026-11-02 用不带 API Key 的请求验证过（返回 400 或 401，接口存在）。

<!-- TODO: 逐家写上推荐的 embedding 模型名、维数和单次条数上限 -->

- **单次条数上限各不相同**，超出会返回 400，客户端要分批（课程代码默认每批 16 条）。mock 模型的上限是 32 条。（第 17 天）
- **空字符串会被拒绝**，课程代码在发请求之前就检查。（第 17 天）
- **`dimensions` 参数**：只有部分模型支持指定维数，不支持的会报错或忽略，用 `EMBEDDING_DIMENSIONS` 配置。（第 17 天）
- **返回的 `data` 不保证和输入同样的顺序**，要按 `index` 放回去。（第 17 天）

## 重排（第 18 天起）

不少服务提供格式相近的 `POST …/rerank`：`{ model, query, documents, top_n }` → `{ results: [{ index, relevance_score }] }`，比如硅基流动（`https://api.siliconflow.cn/v1/rerank`）和 Jina（`https://api.jina.ai/v1/rerank`），2026-11-02 验证过接口存在（未带 Key 时返回 401）。没有重排服务时，课程代码可以直接让对话模型来排。

## 便宜的模型（第 22 天起）

第 22 天用一个便宜的模型给问题分类、回答简单的问题，配置在 `CHEAP_MODEL`：和 `OPENAI_*` 同一个服务、同一个 Key，只换模型名，不填就用 `OPENAI_MODEL`。多数服务都有同一系列里更小、更快的模型，也可以是同一个模型关掉思考的版本。分类的准确率要用第 22 天的评估集测出来再决定。

<!-- TODO: 逐家写上推荐的便宜模型 -->

## 第二家模型（第 33 天起）

第 33 天横评、第 35 天的降级链要用到第二家模型，配置在 `ALT_*`：OpenAI 兼容接口，`ALT_BASE_URL`、`ALT_API_KEY` 不填时沿用 `OPENAI_*`（同一家服务的另一个模型只填 `ALT_MODEL`）。横评的结论只对你的评估集成立，换了评估集要重新跑。

<!-- TODO: 写上课程用来横评的两个模型，以及第 33 天的横评结果 -->

## 批处理（第 36 天起）

不着急要结果的请求可以用 OpenAI 定下的批处理格式：JSONL 文件 → `POST /files`（purpose=batch）→ `POST /batches` → 轮询 → 下载结果文件。

- **通义千问**提供 OpenAI 兼容的批处理接口（地址同对话接口），文档写明按实时调用价格的 50% 计费，单个任务最多 5 万个请求、文件最大 100 MB（2026-11-07 核对文档）
- 其他几家是否支持、格式是否兼容、怎么计费，以各自的文档为准

<!-- TODO: 逐家核对批处理接口 -->

## 联网搜索（第 12 天起）

| 服务 | 接口 | 认证 | 结果在哪 |
|---|---|---|---|
| Tavily | `POST https://api.tavily.com/search`，`{ query, max_results }` | `Authorization: Bearer` | `results[].title / url / content / published_date` |
| 博查 | `POST https://api.bochaai.com/v1/web-search`，`{ query, count, summary }` | `Authorization: Bearer` | `data.webPages.value[].name / url / snippet / summary / datePublished` |
| Brave | `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…` | `X-Subscription-Token` | `web.results[].title / url / description`（带 HTML 标签） |
| 智谱 Web Search | `POST https://open.bigmodel.cn/api/paas/v4/web_search` | `Authorization: Bearer` | 课程代码没有接入，可以照着前三个写一个适配器 |

以上接口在 2026-11-02 用不带 Key 的请求验证过：Tavily 和博查返回 401，Brave 返回 422（缺少 `X-Subscription-Token`），智谱返回 401。

- **博查**出错时可能是 HTTP 200，错误写在返回体的 `code` 和 `msg` 里，要检查 `code`。（第 12 天）
- **Brave** 的摘要里带着 `<strong>` 等标签和字符实体，要清洗。（第 12 天）

## 框架和 SDK（第 41 天起）

- **Vercel AI SDK**：国产模型用 `@ai-sdk/openai-compatible` 接入（`createOpenAICompatible({ baseURL, apiKey, includeUsage: true })`）。它会把思考内容写回 `reasoning_content`。默认只发 `response_format: { type: "json_object" }`，确认模型支持 `json_schema` 以后加上 `supportsStructuredOutputs: true` 才会发 schema。（第 42 天）
- AI SDK 的 `maxRetries` 默认是 2，和第 9 天的 `withRetry` 叠加会把请求数乘起来，课程里设成 0。流式时接口错误在 `fullStream` 的 error 部分里，不会直接抛出。（第 42 天）
- **OpenAI Agents SDK**：默认走 Responses API，国产模型要换成 `OpenAIChatCompletionsModel`；默认把 trace 发到 OpenAI 的平台，用 `setTracingDisabled(true)` 关掉；工具参数默认是 strict 模式，课程里关掉。（第 41 天）
- **Claude Agent SDK**：运行时用 Anthropic 协议，读 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`）和 `ANTHROPIC_MODEL`。多家国产模型服务写了接入 Claude Code 的说明，可以照着配；它在后台还会用一个小模型，也要映射到能用的模型，环境变量以 Claude Code 的文档为准。`total_cost_usd` 按 Anthropic 的价格估算。许可是商业条款，不是开源许可。（第 43 天）

<!-- TODO: 逐家用 AI SDK 和 Claude Agent SDK 实测一遍，记下不兼容的地方 -->

## 视觉模型（第 47 天起）

读截图、读图片要用支持图片输入的模型，配置在 `VISION_*`：`VISION_MODEL` 必填，`VISION_BASE_URL`、`VISION_API_KEY` 不填时沿用 `OPENAI_*`。

| 协议 | 图片的写法 |
|---|---|
| OpenAI 兼容接口 | user 消息的 `content` 是数组：`{ "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }`，也可以是公网能访问的网址 |
| Anthropic 协议 | `{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "…" } }` |

- 不是每个模型都支持图片：同一家服务里，视觉模型往往是单独的型号
- 图片的大小、分辨率、一次几张都有上限，图片也按 token 计费，超大的图片先缩小再发
- 图片里的文字和网页一样是不可信的内容，可能夹带提示注入（第 37、47 天）

<!-- TODO: 逐家写上视觉模型的型号、图片大小上限和计费方式 -->
