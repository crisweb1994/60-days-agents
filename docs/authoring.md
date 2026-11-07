# 写课指南

写给课程作者和贡献者：每一天的目录怎么组织、练习和测试怎么写、讲义怎么写、提交前要跑什么。

## 每一天的目录

```
days/day05/
  README.md      讲义，开头标注最后核对日期
  exercise/      学员的起点
  solution/      参考答案
  tests/         exercise 和 solution 共用一套测试
```

- 新的一天从上一天的 `solution/` 开始：先复制到 `exercise/`，再把当天要学的部分挖掉，写成 TODO。这样学员从哪一天开始都可以。
- `exercise/` 和 `solution/` 的文件名和导出要完全一致，同一套测试才能测两边。
- exercise 和 solution 都用到、但不是当天重点的数据，放在当天目录下，比如第 1–3 天的 `glossary.ts`、第 4 天的 `samples.ts`。
- 个别天有自己的配置，比如第 7 天的 `vitest.config.ts`：它运行学员自己写的测试，并负责变异测试时替换模块。

## 第一阶段的代码结构

第 1–10 天的代码一天天长成 mini-agent。文件只增不改名，后面的天沿用前面的文件：

| 文件 | 从第几天起 | 内容 |
|---|---|---|
| `agent.ts` | 1 | Agent 循环。第 2 天统计用量，第 3 天流式，第 5 天通用工具，第 6 天三道护栏，第 7 天注入模型，第 10 天多轮和确认 |
| `types.ts` | 2 | 消息、请求、回复的类型。第 3 天加 `ChatOptions`，第 4 天加 `ResponseFormat`、`ToolChoice`，第 7 天加 `Model`，第 8 天加 `thinking_blocks` |
| `errors.ts` | 2 | `ModelError`、`toModelError()`；第 9 天加 `NetworkError` |
| `usage.ts` | 2 | 统一的 `Usage`、计算花费、读取单价 |
| `openai.ts` | 2 | OpenAI 兼容接口。第 3 天加流式，第 7 天改成 `createOpenAIModel(config)` |
| `sse.ts` | 3 | 解析 SSE |
| `job.ts`、`extract.ts` | 4 | 结构化输出，只在第 4 天出现 |
| `tool.ts`、`tools/` | 5 | 工具的定义、校验和执行，四个工具；第 10 天加确认 |
| `testing/` | 7 | 脚本化的假模型、录制和回放 |
| `anthropic.ts`、`providers.ts` | 8 | Anthropic 协议的适配器，按协议创建模型 |
| `retry.ts` | 9 | 错误分类和重试 |
| `session.ts`、`cli.ts` | 10 | 多轮对话和命令行界面 |

## 第二阶段的代码结构

第 11–20 天接着第 10 天的代码，长成研究助手。只在某一天出现的示例文件（第 11 天的文献库和 `bench.ts`）不往后带；`data/` 是 exercise 和 solution 共用的数据，第 18 天起每天都带着：

| 文件 | 从第几天起 | 内容 |
|---|---|---|
| `tool.ts` | 11 | 叫错工具名时提示最像的、参数不对时列出要求、`paginate()`；第 12 天加 `body` 和 `footer`，第 13 天加 `parameters`（直接给 JSON Schema） |
| `data/articles.ts`、`data/tasks.ts`、`tools/library*.ts`、`bench.ts` | 11 | 工具设计的对照实验，只在第 11 天出现 |
| `html.ts`、`search.ts`、`web.ts` | 12 | 网页清洗、三家搜索 API、`web_search` 和 `fetch_page`、缓存、来源登记 |
| `mcp.ts` | 13 | MCP host：读配置、连接服务器、转换工具 |
| `server/` | 14 | 用 SDK v2 写的笔记 MCP 服务器，stdio 和 HTTP 两种部署 |
| `context.ts`、`prompts.ts` | 15 | 估算 token、按预算组装上下文、缓存统计；研究助手的 system prompt 从第 15 天起放在 `prompts.ts` |
| `compact.ts` | 16 | 清理工具输出、大结果写入文件、摘要压缩 |
| `rag/` | 17 | embedding、切分、向量库、增量索引；第 18 天加 BM25、混合检索、重排、改写、grep、评估 |
| `tools/docs.ts`、`data/docs/`、`data/qa.ts` | 18 | `search_docs`、`grep_docs`、`read_doc`，测试和评估用的文档与问答集 |
| `memory.ts`、`tools/memory.ts`、`session-store.ts` | 19 | 长期记忆、会话的保存和恢复 |
| `citations.ts`、`research.ts`、`docs-setup.ts` | 20 | 统一的来源和引用检查，组装研究助手 |

第 13、14 天用到官方的 MCP TypeScript SDK v2（`@modelcontextprotocol/client`、`@modelcontextprotocol/server`），已经写进根目录的 `package.json`。

## 第三阶段的代码结构

第 21–30 天接着第 20 天的代码，长成研究助手 v2。只在某一天用到的数据（第 21 天的 `data/compare-tasks.ts`、第 22 天的 `data/routes.ts`）不往后带；第 28 天的两个示例 skill 放在 `days/day28/skills/`，exercise 和 solution 共用：

| 文件 | 从第几天起 | 内容 |
|---|---|---|
| `workflow.ts`、`compare.ts` | 21 | 固定流程版的研究助手；同一组任务对比两种做法的效果、成本、延迟。第 22 天搜索和打开网页改成并行 |
| `parallel.ts`、`router.ts` | 22 | 有并发上限的 `mapLimit`、多数投票；用便宜的模型分类、按类别回答、评估准确率。`providers.ts` 加 `createCheapModel()` |
| `plan.ts` | 23 | 计划工具 `update_plan`；先规划后执行、失败后重新规划。`research.ts` 加 `planResearch()` |
| `verify.ts` | 24 | 引用核查（数字对照、模型评审、校验评审）、生成 → 核查 → 修改的循环。来源登记从这天起保存读到的内容 |
| `subagent.ts` | 25 | 子 Agent、`delegate_research`。`research.ts` 加 `orchestrate()`，`prompts.ts` 加 `ORCHESTRATOR_PROMPT` |
| `handoff.ts` | 26 | 交接和防循环、研究助手的三人团队。`agent.ts` 加 `stopOn` |
| `browser.ts`、`browser-playwright.ts` | 27 | 浏览器工具（无障碍树、编号、网址检查）和 Playwright 的实现 |
| `skills.ts`、`tool-search.ts` | 28 | skill 加载器、AGENTS.md、按需检索工具。`agent.ts` 每一步重新生成工具定义 |
| `permissions.ts`、`run-store.ts`、`tools/ask-user.ts` | 29 | 风险分级和权限策略、`ask_user`、暂停的运行存进文件。`agent.ts` 加 `paused` 和 `resumeAgent()` |
| `deep-research.ts` | 30 | 研究助手 v2：规划 → 确认 → 并行子 Agent → 写报告 → 核查 |

第 27 天用到 Playwright，已经写进根目录的 `package.json`；浏览器要单独下载（`npx playwright install chromium`），没下载时真浏览器的测试自动跳过，CI 里也是这样。

第 22 天起，mock 模型的 `reply()` 可以带 `match`：只回复第一条 user 消息里包含这段文字的请求。并行的子 Agent、同时核查的几句话，请求到达的顺序不固定，用它把回复和请求对上号。

## 第四阶段的代码结构

第 31–40 天接着第 30 天的代码，长成研究助手服务。第 31 天把假互联网从 `tests/web-fixture.ts` 挪到了 `data/web.ts`（`tests/web-fixture.ts` 只剩 vitest 的钩子），评估在测试之外也能启动它；评估集和人工标注放在 `data/eval/`，每天都带着：

| 文件 | 从第几天起 | 内容 |
|---|---|---|
| `data/web.ts`、`eval/dataset.ts`、`eval/run.ts`、`eval/env.ts`、`eval/cli.ts`、`data/eval/research.jsonl` | 31 | 假互联网；评估集的 schema、解析和校验；运行器、检查期望、汇总；评估的环境；命令行 |
| `eval/graders.ts`、`data/eval/judge-labels.jsonl` | 32 | 事实、引用、轨迹三个代码评分器；评分细则评审、两两比较、和人工标注校准、方差。第 37 天加 `safetyGrader` |
| `eval/regression.ts`、`eval/ci.ts`、`eval/bakeoff.ts`、`ci/eval.yml` | 33 | 评估集的版本、回归对比、门禁、横评；CI 的脚本和工作流模板（`ci/` 只在第 33 天）。`providers.ts` 加 `createAltModel()` |
| `trace.ts` | 34 | tracer、GenAI 语义约定、OTLP 导出、Langfuse、从 trace 定位失败。`research()` 和 `deepResearch()` 可以传 `tracer`；`tool.ts` 的上下文带上 `call` |
| `failover.ts`、`deadline.ts`、`checkpoint.ts`、`idempotency.ts`、`testing/faults.ts` | 35 | 递增冷却和故障转移、总时间预算、检查点、幂等、故障注入。`deepResearch()` 加时间预算、优雅降级和检查点；`providers.ts` 加 `createFailoverModel()` |
| `cost.ts`、`batch.ts`、`eval/optimize.ts` | 36 | 预算、成本分解、缓存省了多少、延迟；批处理接口；两种配置的成本对比。`ResearchSetup` 加 `pageSize` |
| `injection.ts` | 37 | 可疑文字、污染跟踪和外传检查、清理回答。研究助手默认开启（`guard: false` 关掉）；`data/web.ts` 加三个恶意网页，评估集加 `forbiddenCalls` 和红队用例 |
| `sandbox.ts`、`security.ts` | 38 | Docker 代码沙箱和 `run_code`；网络白名单、密钥、MCP 工具审核和指纹。`ResearchSetup` 加 `sandbox`、`allowHosts`、`secrets` |
| `guardrails.ts`、`compliance.ts` | 39 | 敏感信息、输入输出护栏、内容审核、拒答和兜底；生成内容的显式和隐式标识。`saveReport` 可以带标识 |

第 38 天真的 Docker 沙箱的测试，只在本机有 Docker、镜像（默认 `python:3.12-slim` 和 `node:22-alpine`）也已经下载好时才跑，测试不会替学员下载镜像；CI 里一般会跳过。第 37 天起，`data/web.ts` 的网页里可以写 `{{BASE}}`，返回时换成假互联网的地址。

## 练习怎么写

- **TODO 编号**：按建议的完成顺序编号，跨文件连续编号。文件开头注明「第 N 天的练习：TODO 几到几在哪里。检查：npm run check N」。
- **TODO 注释写步骤，不写答案**：说明要做什么、要注意什么（比如「id 和 name 有值就赋值，不要拼接」），但不给出代码。
- **起始状态**：要让测试失败，而且失败信息能把学员引到对应的 TODO。占位代码二选一：直接抛出 `new Error('TODO 3：还没有……')`；或者给一个能跑、但不对的实现（比如串行而不是并行、不加缓存的 usage），让后面的步骤能先跑起来。
- **能分步完成**：完成前几个 TODO 时，对应的测试应该先通过。写完练习后，把参考答案的文件逐个复制过去，确认通过的测试数一步步增加。
- **核对常见错误**：讲义里「常见错误」表的每一行，都要真的把参考答案改错一次，跑测试看报错和讲义写的一致。

## 测试怎么写

测试从 `#testing` 引入工具：

```ts
import { expect, test } from 'vitest';
import { describeE2E, describeMock, loadTarget, setupModel } from '#testing';

// 先启动 mock 模型，再加载被测代码：被测代码在 import 时读到的就已经是 mock 的地址
const llm = await setupModel();
const { runAgent } = await loadTarget<typeof import('../solution/agent.ts')>(import.meta.url, 'agent.ts');

describeMock('mock 模型', () => {
  test('调用工具后把结果交回模型', async () => {
    llm.reply({ toolCalls: [{ name: 'lookup_term', arguments: { term: 'MCP' } }] }).reply({ content: '…' });
    await runAgent('什么是 MCP？');
    expect(llm.requests[1].messages.at(-1), '工具结果要放进 role 为 tool 的消息').toMatchObject({ role: 'tool' });
  });
});

describeE2E('真实模型', () => {
  test('用到了工具才能知道的信息', async () => {
    expect(await runAgent('…')).toContain('…');
  });
});
```

- `loadTarget` 按运行模式加载 `exercise/` 或 `solution/` 里的同名模块，类型从 `solution/` 取。
- `describeMock` 里的断言可以精确到每一条消息。`describeE2E` 面对的是真实模型，输出不固定，只检查关键结果：调用了哪个工具，或者答案里有没有只有工具才查得到的信息（比如第 1 天虚构的术语「潮汐窗口」）。不调用模型的纯函数测试用普通的 `describe`，两种模式下都会跑。
- 给 `expect` 写第二个参数，说明失败的原因，最好点出是哪个 TODO。学员看到报错就知道该改哪里。
- 测试脚本的最后多准备一轮回复：正确的实现用不到它，有 bug 的实现会用到，失败信息就是「期望 truncated，实际是 completed」，而不是一个让人摸不着头脑的「mock 脚本已用完」。
- 涉及时间的逻辑（重试的等待、退避）注入 `sleep` 和 `random`，测试里换成假的；只有测超时本身时才真的计时。
- 用到文件的测试，每个测试用 `mkdtemp` 建一个临时目录。

### mock 模型

[shared/mock-llm](../shared/mock-llm/index.ts) 是一个本地的模型服务器，同时实现了两种协议：OpenAI 兼容接口（`…/chat/completions`）和 Anthropic 协议（`…/v1/messages`）。两种协议共用同一份脚本，每个请求按顺序用掉一条，每个测试开始前会自动清空。

| 用法 | 作用 |
|---|---|
| `llm.reply({ content, reasoning, toolCalls, finishReason, usage, delayMs, chunkDelayMs, disconnectAfter })` | 追加一轮回复。请求带 `stream: true` 时自动切成小块返回 |
| `llm.fail({ status, message, type, code, headers, body, disconnect, delayMs })` | 追加一次失败：比如带 `Retry-After` 的 429、Anthropic 的 529、一页 HTML，或者直接断开连接 |
| `llm.requests`、`llm.anthropicRequests` | 两种协议各自收到的请求体，用来断言消息历史 |
| `llm.baseURL`、`llm.anthropicBaseURL` | 两种协议的地址，`setupModel()` 会把它们设进 `OPENAI_*` 和 `ANTHROPIC_*` 环境变量 |
| `llm.pending` | 还没用掉的脚本条数 |

`reply()` 的几个字段：

- `reasoning`：思考内容。OpenAI 兼容接口放在 `reasoning_content` 里，Anthropic 协议是一个带签名的 `thinking` 块
- `finishReason`：用 OpenAI 的叫法，Anthropic 协议会自动换算（`length` → `max_tokens`，`content_filter` → `refusal`），其他取值原样返回
- `usage`：可以带上 `prompt_tokens_details` 之类的额外字段，会原样返回
- `chunkDelayMs`：流式返回时每块之间的间隔，用来测试中途取消
- `disconnectAfter`：流式返回时发完这么多块就断开连接
- `match`：只回复第一条 user 消息里包含这段文字的请求（第 22 天起）。请求先找对得上的 `match`，找不到再按顺序用没有 `match` 的回复

它还会像真实接口一样检查请求，出问题时返回 400 并用中文说明原因：

- OpenAI 兼容接口：缺少 `Authorization` 返回 401；tool 消息对不上工具调用、工具调用没交回结果、`tools` 格式不对或是空数组、`tool_choice` 指定了不存在的工具、`json_object` 模式的提示词里没有 json、`stream_options` 没有配合 `stream`
- Anthropic 协议：缺少 API Key 返回 401，缺少 `anthropic-version`、`max_tokens`；messages 里出现 system 或 tool 角色；工具定义用了 OpenAI 的写法；工具结果没有放进下一条 user 消息、没排在最前面；带思考的工具调用回复，回传时没有原样带上 `thinking` 块和签名
- 脚本用完时返回 500，并提示 Agent 可能陷入了循环

第 17 天起它还实现了 OpenAI 兼容的 `…/embeddings`：不用脚本，按文本算出固定的 256 维向量（英文和数字按单词、中文按单字和相邻两字哈希），字面上越像的文本向量越接近。它不懂意思，能测切分、索引、检索的流程，测不了「换一种说法也能找到」，那要靠 e2e。和真实接口一样，空文本和一次超过 32 条都返回 400。收到的请求在 `llm.embeddingRequests` 里；测试里要算同样的向量，从 `#testing` 引入 `mockEmbedding`。`setupModel()` 会把 `EMBEDDING_*` 也指向它。

需要搜索服务、网页、MCP 服务器的测试，在当天的 `tests/` 里起一个本地的假服务（比如第 12 天的 `tests/fixtures.ts`、第 13 天的 `tests/fixtures/notes.ts`）。e2e 模式下也用这些假服务，只把模型换成真的：不需要搜索的 Key，答案也只在假数据里。

## 讲义怎么写

- **结构**：开头一段说明今天做什么，以及「学完今天，你会」；然后是概念、读懂练习代码、常见误解、常见错误、动手（分步）、检查、小实验、小结、想一想、延伸阅读。篇幅大约在 3500 到 4500 个汉字，另有代码和表格。
- **最后核对日期**：每一课开头写明。涉及各家模型服务的说法，都要对照官方文档核实，必要时用不带 API Key 的请求实际探测一下，再写进讲义。
- **不写死模型名**：模型名统一放在 [docs/models.md](models.md)。示例里需要模型名时用占位名，比如 `my-model`。
- **各家的差异**：在讲义里讲清楚「为什么会这样、怎么应对」，具体的差异清单同步记到 [docs/models.md](models.md)。
- **链接**：相对链接和外部链接都要能打开。

## 提交前

```bash
npm run typecheck                 # 类型检查
npm test                          # 所有天的参考答案，加上 mock 模型自身的测试
npm run check 5                   # 确认练习的初始状态确实会失败
npm run check 5 -- --solution     # 只测某一天的参考答案
```

CI 会在每次 push 和 PR 时运行类型检查和 `npm test`（第 27 天真浏览器的测试在 CI 里跳过）。另外每周会用真实模型跑一次 `npm test -- --e2e`，前提是在仓库设置里配好了变量 `OPENAI_BASE_URL`、`OPENAI_MODEL` 和密钥 `OPENAI_API_KEY`；第 8 天起还要 `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 和密钥 `ANTHROPIC_API_KEY`；第 17 天起还要变量 `EMBEDDING_MODEL`（地址和 Key 不配时沿用 `OPENAI_*`）；第 22 天起可选的变量 `CHEAP_MODEL`（不配时沿用 `OPENAI_MODEL`）；第 33 天起可选的变量 `ALT_MODEL`、`ALT_BASE_URL` 和密钥 `ALT_API_KEY`（横评用的第二家模型，不配时用 `CHEAP_MODEL`）。
