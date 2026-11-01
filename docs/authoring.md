# 写课指南

写给课程作者和贡献者：每一天的目录怎么组织、测试怎么写、提交前要跑什么。

## 每一天的目录

```
days/day01/
  README.md      讲义，开头标注最后核对日期
  glossary.ts    exercise 和 solution 都用到、但不是当天重点的代码，放在当天目录下
  exercise/      学员的起点
  solution/      参考答案
  tests/         exercise 和 solution 共用一套测试
```

- 新的一天从上一天的 `solution/` 开始：先复制到 `exercise/`，再把当天要学的部分挖掉，写成 TODO。这样学员从哪一天开始都可以。
- `exercise/` 和 `solution/` 的文件名和导出要完全一致，同一套测试才能测两边。
- `exercise/` 的初始状态要让测试失败，而且报错要能把学员引到对应的 TODO。

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
- `describeMock` 里的断言可以精确到每一条消息。`describeE2E` 面对的是真实模型，输出不固定，只检查关键结果：调用了哪个工具，或者答案里有没有只有工具才查得到的信息（比如第 1 天虚构的术语「潮汐窗口」）。
- 给 `expect` 写第二个参数，说明失败的原因，学员看到报错就知道该改哪里。

### mock 模型

[shared/mock-llm](../shared/mock-llm/index.ts) 是一个本地的 OpenAI 兼容服务器。每个请求按顺序用掉一条脚本，每个测试开始前会自动清空。

| 用法 | 作用 |
|---|---|
| `llm.reply({ content, toolCalls, finishReason, usage, delayMs })` | 追加一轮回复。请求带 `stream: true` 时自动按 SSE 切成小块返回 |
| `llm.fail({ status, message, headers, delayMs })` | 追加一次失败，比如带 `Retry-After` 的 429，或者 503 |
| `llm.requests` | 收到的每个请求体，用来断言消息历史 |
| `llm.pending` | 还没用掉的脚本条数 |

它还会像真实接口一样检查请求：

- 缺少 `Authorization` 时返回 401
- tool 消息对不上工具调用、工具调用没交回结果、`tools` 格式不对时，返回 400
- 脚本用完时返回 500，并提示 Agent 可能陷入了循环

报错信息都是中文，会说明错在哪里。

## 提交前

```bash
npm run typecheck                 # 类型检查
npm test                          # 所有天的参考答案，加上 mock 模型自身的测试
npm run check 1                   # 确认练习的初始状态确实会失败
npm run check 1 -- --solution     # 只测某一天的参考答案
```

CI 会在每次 push 和 PR 时运行类型检查和 `npm test`。另外每周会用真实模型跑一次 `npm test -- --e2e`，前提是在仓库设置里配好了变量 `OPENAI_BASE_URL`、`OPENAI_MODEL` 和密钥 `OPENAI_API_KEY`。
