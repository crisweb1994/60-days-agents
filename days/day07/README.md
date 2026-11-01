# 第 7 天：让 Agent 可测试

> 最后核对：2026-11-01

第 6 天的循环有七种结局：正常完成、步数用完、原地打转、工具连续出错、截断、拦截、异常停止。怎么确认每一种都处理对了？

用真实模型测，几乎做不到。你没法让模型「这一次请返回 content_filter」；就算是最普通的问答，它每次的输出也不一样，测试时好时坏；而且每跑一次都要花钱、要等好几秒。第 1 天起，课程一直在用 mock 模型帮你检查练习。今天轮到你自己动手：把 Agent 改造得容易测试，再亲手给第 6 天的循环写测试。

学完今天，你会：

- 用依赖注入把模型从 Agent 里拆出来，测试时换成假的
- 写一个脚本化的假模型，精确控制每一轮的回复，检查 Agent 发出的每一个请求
- 把真实模型的一次运行录下来，在测试里离线回放
- 用变异测试检查：你写的测试到底能不能发现 bug

## Agent 为什么难测

普通的函数，同样的输入总是得到同样的输出，写测试很直接。Agent 的核心是一个模型，它带来了三个麻烦：

- **输出不固定**：同一个问题问两遍，措辞不同，调用的工具也可能不同
- **又慢又贵**：每个测试都要调用真实模型，跑一遍测试要好几分钟、花好几块钱
- **罕见的分支触发不了**：截断、拦截、奇怪的 `finish_reason`，你没法让模型按需出现

所以 Agent 的测试要分层，每一层解决不同的问题：

| 层次 | 模型从哪来 | 测什么 | 特点 |
|---|---|---|---|
| 单元测试 | 脚本化的假模型 | 循环的每个分支、发出的请求、工具的执行 | 快、免费、结果固定，什么情况都能造出来 |
| 回放测试 | 录下来的真实回复 | 真实模型的一次完整运行，在代码改动后还能不能走通 | 快、免费，回复是真实的 |
| 评估 | 真实模型 | 回答得好不好、成功率多少 | 慢、要花钱，要跑很多次看统计结果（第 31–33 天） |

今天做前两层。

课程的 mock 模型（`shared/mock-llm`）也是一种假模型，但它工作在 HTTP 这一层：你的代码照常发 HTTP 请求，它按脚本回复。这样连请求格式、SSE 解析都一起测到了，代价是要启动服务器、要走网络。今天写的假模型工作在 `Model` 接口这一层，直接在进程里返回结果，更简单、更快，专门用来测循环本身的逻辑。

## 依赖注入：别让 Agent 自己找模型

第 6 天的 Agent 是这样调用模型的：

```ts
import { chatStream } from './openai.ts';
// ……
const result = await chatStream({ messages, tools: definitions }, { onText, onReasoning, signal });
```

`chatStream` 写死在 Agent 里，它又在调用时读取 `OPENAI_BASE_URL` 这些环境变量。想在测试里换成假模型，没有任何入口。

办法是让 Agent **不自己找依赖，而是由调用方传进来**，这就是依赖注入：

```ts
export interface Model {
  readonly name: string;
  chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult>;
}

export async function runAgent(question: string, options: AgentOptions) {
  const { model, tools } = options;
  // ……
  const result = await model.chat({ messages, tools: definitions }, { onText, onReasoning, signal });
}
```

`Model` 是一个接口，只规定了「能调用」这一件事。真实的模型用 `createOpenAIModel()` 创建，测试用的假模型只要也有一个同样签名的 `chat()`，Agent 就分不出区别。

读环境变量这件事，也从 `openai.ts` 的深处挪到了程序的入口：

```ts
// openai.ts：配置作为参数传进来
export function createOpenAIModel(config: OpenAIConfig = openAIConfigFromEnv()): Model

// agent.ts 直接运行时：只有入口才读环境变量
await runAgent(question, { model: createOpenAIModel(), tools: createTools(workspace) });
```

其实你已经用过依赖注入了：第 5 天起，工具就是通过 `tools` 参数传进去的，测试里可以传入绑定到临时目录的文件工具。今天只是把模型也这样处理。第 8 天还会看到它的另一个好处：再写一个 Anthropic 协议的 `Model`，Agent 一行都不用改。

## 脚本化的假模型

假模型按事先写好的脚本，一步步返回回复：

```ts
const model = createScriptedModel([
  { toolCalls: [{ name: 'calculator', arguments: { expression: '6 * 7' } }] }, // 第 1 次调用：调用计算器
  { text: '答案是 42。' },                                                      // 第 2 次调用：给出回答
]);
const result = await runAgent('6 乘 7 是多少？', { model, tools });

expect(result.status).toBe('completed');
expect(model.requests[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '42' });
```

脚本里的每一步可以指定文字、工具调用、`finish_reason`、用量和思考内容，没写的字段取合理的默认值。想测截断，就写 `finishReason: 'length'`；想测调用失败，就在脚本里放一个 `new Error('网络错误')`。真实模型几乎不会出现的情况，这里一行就能造出来。

它还会记下收到的每个请求，测试可以检查 Agent 发给模型的内容对不对。这里有一个隐蔽的坑：**记下的必须是副本**。

Agent 每次调用模型时，传的都是同一个 `messages` 数组，之后还会接着往里面追加回复和工具结果。如果假模型只是把请求对象存起来，存的就是这个数组的引用：等 Agent 跑完再去看，第一次请求的 `messages` 也变成了完整的历史，你根本看不出当时发了什么。所以要用 `structuredClone(request)` 存一份当时的副本。

这个坑很容易踩，编写这一课的测试时就真的踩了一次：一个检查依赖注入的测试，断言第一次请求的最后一条消息是用户的问题，结果总是失败。原因正是测试里的假模型存了引用，等到断言的时候，后来追加的回复早已排在了那条消息后面。

脚本用完了还被调用，假模型要抛出一个说得清楚的错误：「脚本已用完：只准备了 2 步，这是第 3 次调用模型」。这通常意味着 Agent 多调用了一次模型，或者陷入了循环。和课程的 mock 模型一样。

## 测什么、怎么断言

给 Agent 写测试，主要检查四类东西：

- **结果**：`status`、`answer`、`steps`
- **副作用**：文件有没有被写出来，工具执行了几次（用 `onToolCall` 记下来）
- **发出的请求**：历史的结构对不对，比如带工具调用的 assistant 消息后面，是不是紧跟着 `tool_call_id` 对得上的 tool 消息
- **调用的次数**：`model.remaining` 是不是 0，有没有多调用或少调用

断言要**刚好够用**。比如检查历史，用 `.at(-1)`、按 `role` 过滤、`toMatchObject` 只比较关心的字段，而不是把整个 `messages` 数组逐字比较。后者在你改一个字的 system prompt 时就会全部失败，这样的测试很快就没人愿意维护了。

还有一个小技巧。测「重复调用要停下」时，脚本里除了三次一样的调用，最后再多放一步 `{ text: '…' }`。正确的 Agent 用不到它；有 bug 的 Agent 会继续往下走，用到这一步，以 `completed` 结束。这样测试失败时报的是「期望 repeated_calls，实际是 completed」，一眼就知道错在哪；而不是一个「脚本已用完」，还得再猜原因。

## 录制和回放

假模型的脚本是你写的，反映的是**你以为**模型会怎么回复。真实的模型常常不按你想的来：调用工具的同时说了一句话，一次调用两个工具，参数的写法和你预期的不一样……

回放测试补上了这一块：先用真实模型完整地跑一次，把每次调用的请求和回复都存进一个 JSON 文件；之后的测试按顺序重放这些回复。这种做法在测试领域叫 VCR，录下的文件叫 cassette（磁带）。

```bash
node days/day07/exercise/record.ts calculator "计算 (1234 + 5678) * 9，再把结果写进 result.txt"
```

`record.ts` 用 `recordModel()` 包装真实的模型：照常调用，同时记下每一次的请求和回复，最后存到 `cassettes/calculator.json`。测试里用 `replayModel()` 读出来，交给 Agent：

```ts
const model = replayModel(await loadCassette(file));
const result = await runAgent(question, { model, tools });
expect(result.answer).toBe(录制时的最终回答);
```

回放时，每收到一个请求，都要和录制时的请求比较。一样，就返回录下的回复；不一样，就报错，指出第几次调用、哪条消息变了。请求不一样，说明你的代码改变了发给模型的内容，比如改了 system prompt、改了工具说明，或者不小心弄乱了历史。这时录下的回复已经对不上了，需要重新录制。这反倒成了回放测试的另一个用处：**你无意中改变了发给模型的内容，它会第一个发现**。

几点要注意：

- **工具要能重现。** 回放时工具会真的执行，结果要和录制时一样，请求才对得上。计算器没问题；文件工具每次都用空的临时目录；访问网络的工具结果会变，录制时最好避开它
- **录制里不该有密钥。** 我们只记录请求体和回复，API Key 在请求头里，不会被记下来。但对话内容会被原样记下，提交到仓库之前看一眼有没有敏感信息
- **录制会过期。** 换了模型、改了提示词，就重新录一次，顺便看看新的回复和以前比有什么变化

练习里已经放了一份 `cassettes/calculator-mock.json`，它是用课程的 mock 模型录的，只是格式示例。用 `record.ts` 录一份你自己的真实模型的，这是今天唯一需要真实模型的地方。

## 你的测试真的有用吗

写完测试，全部通过，就说明代码没问题吗？不一定。一个什么都不检查的测试也能通过。

变异测试回答的就是这个问题：**故意往代码里放一个 bug，看你的测试能不能发现**。如果放了 bug 测试还是全部通过，说明测试漏掉了这种情况。每个放了 bug 的版本叫一个变异体（mutant）；测试发现了它，叫「杀死」了这个变异体。

`npm run check 7` 就是这样检查你的 `agent.test.ts` 的。`tests/mutants/` 里有 6 个变异体，每个都只和参考答案差一处：

| 变异体 | 藏的 bug |
|---|---|
| `no-max-steps` | 循环没有步数上限 |
| `ignore-truncation` | 输出被截断时照常执行工具、当成正常完成 |
| `no-repeat-check` | 不检查重复的工具调用 |
| `blocked-as-completed` | 被内容审核拦截时当成正常完成 |
| `no-tool-error-limit` | 工具连续出错也不停下 |
| `no-assistant-in-history` | 没有把模型的回复放回历史 |

检查分两步：先在正确的 Agent 上跑你的测试，必须全部通过；再把 Agent 依次换成每个变异体，每一次都必须有测试失败。

最后一个变异体，练习里给的回放测试就能发现：历史里少了模型的回复，第二次请求就和录制时对不上了。其他五个，要靠你给每一种停下的原因写测试。

实际项目里，变异体是由工具自动生成的，比如 JavaScript 生态的 [Stryker](https://stryker-mutator.io/)：它会把 `<` 改成 `<=`、把 `true` 改成 `false`、删掉某个函数调用，生成成百上千个变异体，再统计有多少被杀死了。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [types.ts](exercise/types.ts) | 新增 `Model` 接口 | 读懂即可 |
| [openai.ts](exercise/openai.ts) | 改成 `createOpenAIModel(config)`，配置从外面传进来 | 读懂即可 |
| [agent.ts](exercise/agent.ts) | 第 6 天的循环，加上 `model` 参数 | TODO 1 |
| [testing/scripted-model.ts](exercise/testing/scripted-model.ts) | 脚本化的假模型 | TODO 2 |
| [testing/cassette.ts](exercise/testing/cassette.ts) | 录制和回放 | TODO 3 |
| [agent.test.ts](exercise/agent.test.ts) | 你写的测试 | TODO 4 |
| [record.ts](exercise/record.ts) | 用真实模型录制一次运行 | 用它录一份自己的 |
| [cassettes/](exercise/cassettes) | 录下的运行 | 放你录的文件 |
| 其余文件 | 和第 6 天的参考答案一样 | 不用改 |

`agent.test.ts` 不会被 `npm run check` 直接运行，因为它是你写的测试，而不是检查你的测试。直接运行它：

```bash
npx vitest --config days/day07/vitest.config.ts
```

这会进入监听模式，改完文件自动重跑，按 `q` 退出。`npm run check 7` 运行变异测试时，用的也是这个配置文件：它在配置里加了一个小插件，设置了 `MUTANT` 环境变量时，把 `agent.ts` 换成对应的变异体。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 测 Agent 必须用真实模型 | 循环的逻辑用假模型测更好：快、免费、什么情况都能造 |
| 假模型直接存请求对象就行 | 要存副本，否则记下的请求会跟着 Agent 一起变 |
| 断言越详细越好 | 太细的断言，改一个字的提示词就全部失败 |
| 回放测试和真实模型测试等价 | 它只覆盖录下的那一条路径，模型换了要重新录 |
| 测试全部通过，就说明测试写得好 | 变异测试能检验它：放进 bug，看能不能发现 |

## 常见错误

| 报错 | 原因 |
|---|---|
| `报错了：缺少 OPENAI_BASE_URL、OPENAI_API_KEY 或 OPENAI_MODEL` | `runAgent` 里还在自己创建模型，没有用 `options.model` |
| 测试说「要用 structuredClone 存一份副本」 | 假模型或录制模型存的是请求对象本身 |
| `第 2 次调用的请求和录制时不一样` | 改了提示词、工具或者历史的结构。确认改动是有意的，就重新录制 |
| `No test found in suite` | `describe` 里一个测试都没有。可以先写成 `test.todo('…')` |
| 「你的测试仍然全部通过」 | 对应的停下原因还没有测试，或者测试没有检查 `status` |

## 动手：给第 6 天的循环写测试

按顺序做，每做完一步就运行一次 `npm run check 7`：

1. **TODO 1**：依赖注入。删掉 `runAgent` 里创建模型的那一行，改用 `options.model`。
2. **TODO 2**：脚本化的假模型。`scripted-model.test.ts` 会通过。
3. **TODO 3**：录制和回放。`cassette.test.ts` 会通过，这时 `agent.test.ts` 里给出的两个测试也能跑了。
4. **TODO 4**：在 `agent.test.ts` 里，把每个 `test.todo` 换成真正的测试。边写边用 `npx vitest --config days/day07/vitest.config.ts` 看结果，最后用 `npm run check 7` 看你的测试杀死了几个变异体。
5. **需真实模型**：用 `record.ts` 录一份你自己的运行，放进 `cassettes/`。回放测试会自动把它也跑一遍。

## 检查

```bash
npm run check 7
```

用真实模型验证。e2e 测试会用真实模型录一次运行，再离线回放，检查结果是否一致：

```bash
npm run check 7 -- --e2e
```

## 小实验

- 录一份你自己的运行，打开 JSON 看看真实模型的回复：它调用工具时有没有顺便说话？`finish_reason` 是什么？用了多少 token？
- 改一个字的 system prompt，再跑回放测试，看看报错是怎么指出差别的
- 把 `scripted-model.ts` 里的 `structuredClone` 去掉，看看哪些测试会失败、为什么
- 打开 `tests/mutants/` 里的任意一个变异体，和参考答案对比，找出那一处不同
- 自己写一个新的变异体，比如「工具结果的顺序反了」，看看你的测试能不能发现它

## 小结

- Agent 的测试分层：假模型测逻辑，回放测真实的运行路径，评估测质量。
- 依赖注入：Agent 不自己找模型，由调用方通过 `Model` 接口传进来；环境变量只在入口读取。
- 脚本化的假模型能造出任何情况，还能检查发出的每个请求。记下的请求必须是副本。
- 断言刚好够用；脚本最后多放一步，让有 bug 的实现给出清楚的失败信息。
- 回放测试离线重放真实模型的回复；请求对不上就说明录制过期，或者你无意中改了发给模型的内容。
- 变异测试检验测试本身：放进 bug，看测试能不能发现。

## 想一想

- 今天的 `Model` 只有一个 OpenAI 兼容的实现。再加一个 Anthropic 协议的实现，要处理哪些差异？同一组测试能不能同时测两个？（第 8 天）
- 假模型怎么模拟「第一次调用返回 429，第二次成功」？重试的逻辑该怎么测？（第 9 天）
- 回放测试能告诉你 Agent 还能不能走通，却不能告诉你回答得好不好。后者怎么测？（第 31、32 天）

## 延伸阅读

- [Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html)：Martin Fowler 讲测试替身的几种类型，今天的假模型属于哪一种？
- [Vitest：Mocking](https://vitest.dev/guide/mocking)：vitest 自带的模拟工具。想一想，为什么今天没有用 `vi.mock` 替换模块，而是用了依赖注入
- [VCR](https://github.com/vcr/vcr) 和 [Polly.js](https://github.com/Netflix/pollyjs)：录制回放 HTTP 请求的经典工具，一个是 Ruby 的，一个是 JavaScript 的
- [Stryker Mutator](https://stryker-mutator.io/)：JavaScript 和 TypeScript 的变异测试工具
