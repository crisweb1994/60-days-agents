# 第 44 天：流式界面与生成式 UI

> 最后核对：2026-11-07

一次研究要十几秒到几分钟。如果网页上只有一个转圈的图标，用户会以为它卡住了；如果能看到「正在搜索潮汐协议 3.0 默认端口 → 读了 3 个网页 → 正在写回答」，等待就变成了**看着它干活**。第 36 天说过：流式输出和进度展示减少的是等待感，不是实际的延迟。

今天给研究助手做一个 Web 界面：服务端把研究的过程推成一条 **UI 消息流**，前端实时画出调研的时间线、工具调用、每一步的文字、引用的来源和最终的回答，能中途停止、能重试。

```text
研究助手
┌──────────────────────────────────────────────┐
│ 潮汐协议 3.0 的默认端口是多少？      [快速回答] [提问] │
└──────────────────────────────────────────────┘
正在调研……
│ ● web_search · 完成  {"query":"潮汐协议 3.0 默认端口"}   ▸ 结果
│ ● fetch_page · 调用中 {"url":"https://tide.example/article.html"}
│ ○ 3.0 的默认端口是 7443 [1]……
```

学完今天，你会：

- 设计 Agent 的流式界面要推送哪些东西：文字、工具调用、进度、来源、最终结果
- 用 Vercel AI SDK 的 UI Message Stream 协议推送 SSE，并验证兼容性
- 写一个纯函数的前端状态归并，让 React 和原生 JavaScript 都能用
- 处理中断和重试：用户停止时服务端跟着取消，长连接用心跳保活
- 知道生成式 UI 是什么，以及安全地渲染模型的输出

## 推什么

研究助手一次运行里，界面关心的事情：

| 发生了什么 | 推送的块 | 界面怎么画 |
|---|---|---|
| 开始 | `start` | 清空，显示「正在调研」 |
| 模型决定调用工具 | `tool-input-available` | 时间线上加一行，闪烁的圆点，显示参数 |
| 工具执行完 | `tool-output-available` / `tool-output-error` | 圆点变实心或变红，结果折叠起来 |
| 模型说话 | `text-start` → `text-delta`… → `text-end` | 一步一段文字，边生成边显示 |
| 深度研究换了阶段 | `data-progress`（自定义） | 「子问题 2 查完了」「正在写报告」 |
| 引用的来源 | `source-url` | 回答下面的来源列表 |
| 最终的回答 | `data-answer`（自定义） | 回答卡片：带来源列表和生成内容标识的全文 |
| 结束 / 出错 / 停止 | `finish` / `error` / `abort` | 状态栏 |

为什么最后还要单独推一次 `data-answer`？流式的文字是模型的**原始输出**，而交给用户的回答经过了第 24 天的核查、第 37 天的清理（去掉不明来源的图片和链接）、第 20 天的来源列表、第 39 天的标识。界面最终显示的必须是处理过的那一份。

### 用现成的协议

格式用的是 Vercel AI SDK 的 **UI Message Stream** 协议：SSE，每个事件的 `data` 是一个 JSON 块，最后一个是 `[DONE]`，响应头带 `x-vercel-ai-ui-message-stream: v1`。

```text
data: {"type":"start"}

data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"web_search","input":{"query":"…"},"dynamic":true}

data: {"type":"text-delta","id":"text-1","delta":"默认端口"}

data: {"type":"data-answer","data":{"text":"…","status":"completed"}}

data: [DONE]
```

用现成的协议有两个好处：前端可以直接用 AI SDK 的 `useChat`；协议里的块已经覆盖了大多数场景（工具、来源、文件、自定义数据、中止），不用自己发明。我们没有用 `streamText().toUIMessageStreamResponse()` 生成它，因为研究助手的循环是自己的（第 42 天），所以 [ui-stream.ts](exercise/ui-stream.ts) 从回调里一块块拼出来：

- `onToolStart`（今天给第 6 天的循环加的回调，工具开始执行之前调用）→ `tool-input-available`
- `onToolCall`（执行完）→ `tool-output-available`
- `onText` → `text-delta`；`onUsage`（一次模型调用结束）→ `text-end`
- 深度研究的 `onEvent` → `data-progress`

工具都标了 `dynamic: true`：前端事先不知道研究助手有哪些工具（MCP 服务器的工具是运行时才知道的）。

测试里有一条专门检查兼容性：用 AI SDK 自己的 `uiMessageChunkSchema` 校验我们发的每一块，再交给 `readUIMessageStream` 拼成一条 `UIMessage`。哪天 AI SDK 改了协议，这条测试会先失败。

## 前端的状态：一个纯函数

前端收到的是一块块的增量，要画的是一张完整的时间线。[timeline.ts](exercise/timeline.ts) 的 `applyChunk(状态, 块) → 新状态` 把它们归并起来：

```ts
let state = initialTimeline();
for (const chunk of decoder.push(text)) state = applyChunk(state, chunk);
render(state);
```

写成纯函数（不改旧的状态、不碰 DOM、不发请求）的好处：

- **测试不用浏览器**：一串块进去，一个状态出来，`toEqual` 就能比
- **React 直接能用**：就是 `useReducer` 的 reducer
- **前后端共用**：服务端用它在测试里检查推送的结果，浏览器用它画界面

最后一点用了个小技巧：Node 22.13 起自带 `stripTypeScriptTypes`，[web-server.ts](exercise/web-server.ts) 把 `timeline.ts` 去掉类型，直接作为 `/timeline.js` 发给浏览器，不用打包工具。代价是这个文件不能 import 别的模块、只能用能直接擦掉的类型语法。

几个归并的细节：

- **按 id 归并**：`text-delta` 接到同一个 `id` 的文字后面；`tool-output-*` 找同一个 `toolCallId`。块可能交错到达（第 25 天的并行子 Agent）
- **带 id 的进度替换旧的**：同一个子问题先「没查完」后「查完了」，只留一行
- **不认识的块忽略**：协议以后加了新的块，旧的界面不会坏
- **停止时收尾**：还在「调用中」的工具改成「已停止」，不然圆点会一直闪

## 中断、重试、保活

| 情况 | 服务端 | 前端 |
|---|---|---|
| 用户点「停止」 | 连接断开（`res` 的 `close`）→ `AbortController.abort()` → 研究停下，不再调用模型 | `fetch` 的 `signal` 取消，状态改成「已停止」 |
| 用户关掉网页 | 同上 | — |
| 网络中断 | 同上 | 流没等到 `finish` 就结束了：提示可以重试 |
| 研究出错 | 发 `error`（兜底的答复，不带内部细节）再发 `finish` | 显示错误，「重试」可用 |
| 长时间没有新的块 | 每 15 秒写一行 `: ping` | 解析时忽略注释 |

心跳是因为很多代理、负载均衡、浏览器会断开「一段时间没有数据」的连接。深度研究的子 Agent 查一个问题可能要一分钟，期间没有任何块可发。还有一个响应头 `x-accel-buffering: no`：告诉 nginx 别攒满缓冲区再发，否则用户看到的是一次性蹦出来的全部内容。

今天的重试是「从头再来一次」。要做到关掉网页再打开、接着看进度，研究就不能跟着连接走，要放进后台任务，进度存下来，重连时从断开的地方接着推：这是第 45 天的事。

## 安全地渲染模型的输出

模型的输出、工具的结果都是**不可信的内容**（第 37 天）。研究助手读过的网页里可能写着 `<img src=x onerror=…>`，模型可能原样复述。[public/app.js](exercise/public/app.js) 的规矩：

- 一律用 `textContent`，**不用 `innerHTML`**。测试里让 mock 模型的回答带一段 `onerror` 脚本，用真的 Chromium 检查它没有被执行
- 链接只接受 `http:` 和 `https:`，`javascript:` 当作文字；外链加 `rel="noopener noreferrer"`
- 要渲染 Markdown 时，用会做清理的渲染器（比如 Markdown 转 HTML 以后再用 DOMPurify），并且不自动加载图片：图片地址就是第 37 天说的外传渠道

## 用 React 和 Next.js

今天的界面没有用框架，`public/` 下面只有一个 HTML 和一个脚本。换成 React，结构不变：

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export function Research() {
  const { messages, sendMessage, stop, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/research',
      // 我们的接口要的是 { question, mode }，不是聊天记录
      prepareSendMessagesRequest: ({ messages }) => ({ body: { question: lastText(messages), mode: 'quick' } }),
    }),
  });
  return messages.map((m) =>
    m.parts.map((part, i) => {
      if (part.type === 'dynamic-tool') return <ToolStep key={i} name={part.toolName} state={part.state} input={part.input} />;
      if (part.type === 'data-answer') return <Answer key={i} {...part.data} />;
      if (part.type === 'source-url') return <Source key={i} url={part.url} title={part.title} />;
      if (part.type === 'text') return <p key={i}>{part.text}</p>;
      return null;
    }),
  );
}
```

`useChat` 内部做的就是今天的 `createSSEDecoder` 加 `applyChunk`：读流、按块归并成 `UIMessage` 的 `parts`。在 Next.js 里，`/api/research` 写成一个 Route Handler，把 `streamResearch` 的块写进一个 `ReadableStream` 返回。部署时要注意：Serverless 平台的函数有执行时长上限，长时间的流式连接未必合适（第 48 天）。

## 生成式 UI

上面的 `if (part.type === 'dynamic-tool') return <ToolStep />` 其实就是**生成式 UI** 的雏形：界面的结构由模型的行为决定。更进一步：

- **按工具渲染组件**：`web_search` 的结果画成一组搜索卡片，`run_code` 的结果画成代码和输出，深度研究的计划画成可以勾选、编辑的清单（第 30 天的确认）
- **模型直接选组件**：给模型一个「展示图表」的工具，参数是数据和图表类型，前端把它渲染成真正的图表
- **MCP Apps（选读）**：MCP 的一个扩展，让 MCP 服务器连同工具一起提供一段交互式的界面（比如一个可以拖动的日程表），由宿主放在沙箱里渲染。它把「生成式 UI」从你的应用扩展到了任何 MCP 服务器

不管哪种，原则都一样：模型选的是**你事先写好的组件**和它的参数，而不是直接生成 HTML。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [ui-stream.ts](exercise/ui-stream.ts) | 回调变成块、推送一次研究 | TODO 1、2 |
| [timeline.ts](exercise/timeline.ts) | 前端的状态归并、SSE 解码 | TODO 3 |
| [web-server.ts](exercise/web-server.ts) | 网页、脚本和 SSE 接口 | TODO 4 |
| [public/](exercise/public/) | 网页和脚本（原生 JavaScript） | 读懂即可 |
| [agent.ts](exercise/agent.ts)、[research.ts](exercise/research.ts) | 加了 `onToolStart`，`research()` 可以传 `onToolStart` 和 `onUsage` | 读懂即可 |
| 其余文件 | 和第 43 天的参考答案一样 | 不用改 |

装了 Playwright 的 Chromium（第 27 天）时，测试会真的打开网页提问；没装就跳过。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 把模型的输出流式推给前端就行 | 还要推工具调用和进度；最终显示的回答要用处理过的那一份 |
| 前端收到什么就 append 什么 | 块会交错到达，要按 id 归并 |
| 用户点了停止，前端不显示就好了 | 服务端要跟着取消，否则还在花钱 |
| SSE 连接会一直保持 | 代理和浏览器会断开空闲的连接，要发心跳 |
| 用 innerHTML 渲染 Markdown 更好看 | 模型的输出不可信，会执行网页里夹带的脚本、加载外传的图片 |
| 生成式 UI 就是让模型生成 HTML | 模型选的是你写好的组件和参数 |
| 自己定义一套推送格式更灵活 | 用现成的协议，前端的库直接能用，块的种类也够用 |

## 常见错误

| 报错 | 原因 |
|---|---|
| 测试说文字块的 id 应该是 text-2 | 每一步的文字用了同一个 id；`onUsage` 时没有 `text-end` |
| 测试说调用工具之前要先结束文字 | `onToolStart` 里没有 `closeText` |
| 工具结果的测试说应该截断 | 没用 `previewOutput` |
| AI SDK 的 schema 校验失败 | 块的字段名不对，比如写成了 `toolCallID`、`text`（应该是 `delta`） |
| 测试说出错时不应该有 10.0.0.5 | `errorText` 用了原始的错误信息 |
| 测试说不改旧的状态 | 用了 `push`、直接改了 item 的字段 |
| 测试说同一个子问题只留一行 | data-progress 没有按 id 替换 |
| 停止的测试说不应该再调用模型 | `res` 的 `close` 没有触发 `abort`，或者 signal 没有传给研究 |
| 心跳的测试失败 | 没有定时写 `: ping`，或者写在了 `[DONE]` 之后 |
| 浏览器测试一直等不到「完成」 | 流最后没有 `finish`，或者没有 `res.end()` |

## 动手：给研究助手做一个 Web 界面

按顺序做，每做完一步就运行一次 `npm run check 44`：

1. **TODO 1**：`createChunkEmitter`。
2. **TODO 2**：`streamResearch`。推送研究过程的测试通过，AI SDK 的解析器也认得。
3. **TODO 3**：`applyChunk`。前端状态的测试通过。
4. **TODO 4**：`pipeResearch`。全部测试通过。
5. **打开网页**（需真实模型）：`node days/day44/exercise/web-server.ts`，打开 http://localhost:8788，问一个快速的问题、一个深度研究的问题；中途点停止，看终端里是不是显示「研究结束：aborted」。

## 检查

```bash
npm run check 44
```

真实模型下推送一次研究的过程（需真实模型）：

```bash
npm run check 44 -- --e2e
```

## 小实验

- 用浏览器开发者工具的 Network 面板看 `/api/research` 的响应，数一数一次研究推了多少块、多少字节
- 在终端用 `curl -N -X POST localhost:8788/api/research -H 'content-type: application/json' -d '{"question":"你好"}'` 看原始的 SSE
- 把心跳的间隔调成 1 秒，前面加一个 nginx（不设 `x-accel-buffering`），看看块是不是攒在一起才到
- 给 `fetch_page` 的结果画一个专门的组件：显示网页标题、字数、有没有触发第 37 天的安全提示
- 新建一个 Next.js 项目，用上面的 `useChat` 代码接上今天的接口

## 小结

- 流式界面要推的不只是文字：工具调用、进度、来源和处理过的最终回答
- 用 AI SDK 的 UI Message Stream 协议，前端的库直接能用；用它自己的 schema 测兼容性
- 前端状态写成纯函数的 reducer：按 id 归并、不改旧状态、忽略不认识的块；React 和原生 JS 都能用
- 停止要让服务端跟着取消；长连接要心跳；代理的缓冲要关掉
- 模型的输出不可信：`textContent` 渲染，链接只认 http(s)；生成式 UI 让模型选组件，不让它写 HTML

## 想一想

- 用户关掉网页，研究就被取消了。要是希望「提交以后可以离开，查完了再回来看」，研究该在哪里跑？进度存在哪里？（第 45 天）
- 重新打开网页时，怎么只补推断开以后的那些块，而不是从头再来？（提示：SSE 的 `id` 和 `Last-Event-ID`）
- 现在谁都能打开这个网页提问。多个用户以后，怎么保证 A 看不到 B 的研究过程？（第 46 天）

## 延伸阅读

- [AI SDK：Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)：UI Message Stream 的每一种块
- [AI SDK：Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)：`useChat`、transport、message parts
- [AI SDK：Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)：按工具渲染组件
- [MDN：Using server-sent events](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events)：事件格式、注释行、重连
- [Node.js：module.stripTypeScriptTypes](https://nodejs.org/api/module.html#modulestriptypescripttypescode-options)：去掉 TypeScript 的类型
- [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)：MCP 服务器提供交互式界面的扩展
- [OWASP：Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)：安全地渲染不可信的内容
