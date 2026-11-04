# 第 14 天：MCP（下）：写一个服务器

> 最后核对：2026-11-02（MCP 规范 2026-07-28，官方 TypeScript SDK v2.4.0）

昨天你让 mini-agent 接上了别人写的 MCP 服务器。今天换到另一边：用官方的 TypeScript SDK 写一个服务器，把你本地的 Markdown 笔记目录提供给任何 MCP host，不管是 mini-agent、Claude Desktop、Cursor 还是 Claude Code。

它提供：

- 两个工具：`search_notes` 搜索笔记，`read_note` 分段读一篇笔记
- 资源：每篇笔记是一个 `note://work/release.md` 这样的资源
- 一个提示词模板：`summarize_note`

同一份代码有两种部署方式：作为子进程用 stdio 通信，或者作为 HTTP 服务。

学完今天，你会：

- 用 SDK v2 注册工具、资源和提示词，给工具加上输入输出的 schema
- 按无状态的思路设计服务器：跨调用的进度放进游标，交给 client 保管
- 知道为什么工具的顺序要固定，日志为什么只能写 stderr
- 同时提供 stdio 和 HTTP 两种部署，并防住 DNS 重绑定
- 用 Inspector 调试服务器，发布到 npm（选读：发布到 MCP 目录）

## SDK v2 的结构

SDK v2 跟着 2026-07-28 规范一起发布，把原来的一个包 `@modelcontextprotocol/sdk` 拆成了几个：

| 包 | 用途 |
|---|---|
| `@modelcontextprotocol/server` | 写服务器：`McpServer`、`createMcpHandler()`；`/stdio` 子路径里是 `serveStdio()` |
| `@modelcontextprotocol/client` | 写 host：`Client`、`StreamableHTTPClientTransport`；`/stdio` 子路径里是 `StdioClientTransport`（昨天用的） |
| `@modelcontextprotocol/node`、`express`、`hono` 等 | 可选的适配器，把 MCP 挂到对应的 Web 框架上 |

工具的参数用 zod 写，和你第 5 天以来的写法一样。

## 注册工具

```ts
const server = new McpServer({ name: 'notes-server', version: '0.14.0' });

server.registerTool(
  'search_notes',
  {
    title: '搜索笔记',
    description: '按关键词搜索笔记的标题和正文……',
    inputSchema: z.object({ query: z.string().min(1).describe('关键词'), /* … */ }),
    outputSchema: searchOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => reply(text, structured),
);
```

和第 5 天的工具比，多了三样东西：

**`outputSchema` 和 `structuredContent`。** 工具除了返回给模型看的文字（`content`），还可以返回一份结构化的结果（`structuredContent`），并用 `outputSchema` 声明它的格式。client 拿到以后可以直接用程序处理，SDK 也会按 schema 校验。规范建议同时返回一份文字版，因为有的 client（比如昨天的 mini-agent）只把文字交给模型，老版本的 client 也只认文字。

**`annotations`。** 告诉 host 这个工具的性质：`readOnlyHint` 只读，`destructiveHint` 可能有破坏性，`idempotentHint` 重复调用结果一样，`openWorldHint` 会访问外部世界。昨天的 host 用 `readOnlyHint` 决定要不要确认。如实地标，不要为了让用户少点几次「同意」就把写操作标成只读。

**出错的方式。** 工具执行出错（参数指向不存在的笔记、路径越界），不要抛出异常让整个请求失败，而是返回 `isError: true` 的结果，把原因写在文字里，模型才能看到、才能改正。第 11 天写错误信息的规矩在这里同样适用。参数不符合 `inputSchema` 时，SDK 会自动返回一个 `isError` 的结果。

工具设计的其他原则，第 11 天都讲过了：名字和描述说清楚，参数少而明确，结果精简，长内容分段。今天的两个工具就是照着写的。

## 无状态的服务器

昨天讲过，2026-07-28 规范去掉了握手和会话，每个请求都是独立的。对服务器来说，这意味着**不能在内存里记住「这个 client 上次做到哪了」**：HTTP 部署时，前后两个请求可能落在两台不同的机器上，也可能中间服务器重启了。

`createMcpHandler()` 把这一点做得很彻底：它**每个请求都调用一次工厂函数**，创建一个全新的 `McpServer` 来处理。stdio 部署时，`serveStdio()` 为一个连接只创建一个实例，但你也不应该依赖这一点，同一份代码要在两种部署下表现一样。

可是有些操作天生需要跨调用的状态。比如一篇很长的笔记要分三次读完：第二次调用时，服务器怎么知道从哪里接着读？

答案是**把状态交给 client 保管**：服务器在结果里返回一个游标（`nextCursor`），里面写着「下次从第几个字符开始」；client 下次调用时原样带回来。服务器自己什么都不用记。

```ts
// 游标里是 { v: 1, kind: 'read', path: 'long.md', offset: 2000 }，编码成 base64url
encodeCursor({ kind: 'read', path: 'long.md', offset: 2000 }); // 'eyJ2IjoxLCJraW5kIjoicmVhZCIs…'
```

设计游标的几个要点：

- **对 client 不透明。** client 只是原样传回，不应该去解析它。所以你可以随时改游标的格式，加一个版本号 `v`，旧格式的游标直接拒绝，而不是被读错
- **带上种类和上下文。** `kind` 区分是哪个工具的游标；`query` 和 `path` 记下是哪次查询、哪篇笔记的。拿 `search_notes` 的游标去调 `read_note`，或者换了关键词还带着旧游标，都能发现并报错
- **出错时告诉模型怎么办。** 「cursor 无效或者已经过期。去掉 cursor 参数，从头重新调用」
- **需要时签名。** 今天的游标只记录读到哪里，被改了最多读错位置，不会越权。如果游标里有用户 ID、权限这类信息，就要用 HMAC 签名，防止被篡改

规范里列表类的方法（`tools/list`、`resources/list`）用的也是游标分页，是同一个思路。更一般地说，这叫**显式句柄**：凡是需要跨调用保持的东西（分页进度、一个长任务的 ID、一份临时生成的报告），都做成一个句柄返回，后续调用带着它来。第 29 天讲长任务的持久化时，你会再次用到这个思路。

## 资源和提示词

资源用 URI 标识。笔记很多，不可能一个一个注册，所以用 **URI 模板**：

```ts
server.registerResource(
  'note',
  new ResourceTemplate('note://{+path}', { list: async () => ({ resources: /* 每篇笔记一条 */ }) }),
  { description: '一篇笔记的全文', mimeType: 'text/markdown' },
  async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }),
);
```

`{+path}` 里的 `+` 表示这个变量里可以有 `/`（`work/release.md`），这是 URI 模板标准（RFC 6570）的写法。`list` 回调让 host 能列出所有的笔记，给用户挑选。

提示词模板 `summarize_note` 接受一个路径参数，返回一组消息。host 一般把它做成斜杠命令：用户选择「总结笔记」，填上路径，host 拿到消息后发给模型。

资源和提示词由 host 和用户决定用不用，不像工具那样由模型决定。昨天的 mini-agent 只接了工具，这是很多 host 的现状：资源和提示词的支持程度差别很大，重要的能力最好也做成工具。

## 两个容易踩的坑

### 工具的顺序要固定

`tools/list` 返回的工具列表，会被 host 原样放进每一次模型请求。第 15 天会讲到，模型服务的提示缓存是按**前缀**匹配的：请求开头的内容和上次一模一样，才能命中缓存，享受低得多的价格。工具定义就在请求的最前面。

如果你的服务器每次返回的工具顺序都不一样（比如从一个 `Set` 或者数据库里读出来，顺序不固定），或者描述里带着时间戳、随机数，host 的每一次请求都无法命中缓存。所以：注册顺序固定，描述里不放会变的内容。测试里专门检查了「两次列出的工具一模一样」。

### 日志只能写 stderr

stdio 部署时，标准输出就是协议的通道，host 把每一行都当作一条 JSON-RPC 消息来解析。你在代码里随手写一个 `console.log('收到请求')`，host 就会收到一行不是 JSON 的东西，轻则报错，重则断开连接。

所以服务器里的日志一律写到 stderr：`process.stderr.write()` 或者 `console.error()`。依赖的库也要小心，有的库会往 stdout 打印警告。测试里启动服务器，检查 stdout 里的每一行都能解析成 JSON。

## 两种部署

工具、资源、提示词都定义在 `createNotesServer(root)` 这一个工厂函数里，两种部署共用它。

**stdio**（[server/stdio.ts](exercise/server/stdio.ts)）只有几行：`serveStdio(() => createNotesServer(root))`。host 的配置：

```json
{ "mcpServers": { "notes": { "command": "node", "args": ["days/day14/exercise/server/stdio.ts"], "env": { "NOTES_DIR": "/Users/you/notes" } } } }
```

**HTTP**（[server/http.ts](exercise/server/http.ts)）用 `createMcpHandler()` 得到一个处理标准 `Request`、返回标准 `Response` 的函数，再用 `node:http` 接上。把 Node.js 的请求转成标准的 `Request` 只要二十来行，也可以用官方的 `@modelcontextprotocol/node` 适配器。

HTTP 部署多了一个安全问题：**DNS 重绑定**。你在本机的 3014 端口跑着这个服务器，然后打开了一个恶意网页。这个网页先让你的浏览器把它的域名解析到一个正常的 IP，加载完以后，再把同一个域名解析到 127.0.0.1。浏览器认为这还是同一个网站，于是网页里的 JavaScript 就可以访问你本机的 MCP 服务器，读你的笔记。

防御办法是检查请求头：`Host` 必须是 `localhost`、`127.0.0.1` 这类本机的名字，浏览器发出的请求如果带了 `Origin`，也必须是本机的。SDK 提供了 `hostHeaderValidationResponse()` 和 `originValidationResponse()`，不合格时直接返回 403。另外，服务器默认只监听 `127.0.0.1`，不监听 `0.0.0.0`，局域网里的其他电脑也访问不到。

要让别人通过网络使用你的服务器，还需要认证。MCP 规范定义了基于 OAuth 的授权流程，SDK 也有对应的支持，第 48 天部署上线时再讲。

## 调试：MCP Inspector

官方的 [Inspector](https://github.com/modelcontextprotocol/inspector) 是一个网页版的 MCP client，可以列出服务器的工具、资源和提示词，手动调用并查看每一条消息：

```bash
NOTES_DIR=~/notes npx @modelcontextprotocol/inspector node days/day14/exercise/server/stdio.ts
```

写服务器时，先用 Inspector 把每个工具都手动调一遍，确认参数、结果、出错时的表现都对，再接到 Agent 上。这比通过模型间接地测试快得多，也确定得多。

## 发布到 npm

想让别人用 `npx your-notes-server` 运行，步骤和第 10 天发布 mini-agent 一样：编译成 JavaScript（Node.js 不处理 `node_modules` 里的 `.ts` 文件），在 `package.json` 里写好 `bin` 和 `files`，`stdio.ts` 的第一行加上 `#!/usr/bin/env node`。几点 MCP 服务器特有的注意事项：

- **配置走环境变量。** 笔记目录、API Key 都从环境变量读，host 的配置里通过 `env` 传进来
- **启动要快。** 有的 host 连接时有超时，昨天的版本协商在 stdio 上还会额外启动一次进程试探
- **在 README 里给出配置片段**，用户复制到 `mcp.json` 就能用

### 选读：发布到 MCP 目录

官方的 [MCP Registry](https://registry.modelcontextprotocol.io) 收录公开的 MCP 服务器，很多 host 会从这里发现服务器。发布的大致流程是：在 `package.json` 里加上一个 `mcpName` 字段（比如 `io.github.你的用户名/notes-server`），用官方的 `mcp-publisher` 命令行工具生成描述文件 `server.json`，用 GitHub 账号登录以证明你拥有这个名字，再发布。具体步骤以 [Registry 的文档](https://github.com/modelcontextprotocol/registry/tree/main/docs) 为准。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [server/cursor.ts](exercise/server/cursor.ts) | 游标的编码和解码 | TODO 1 |
| [server/notes.ts](exercise/server/notes.ts) | 笔记的读取、搜索和分段，服务器的工厂函数 | TODO 2、3、4 |
| [server/http.ts](exercise/server/http.ts) | HTTP 部署 | TODO 5 |
| [server/stdio.ts](exercise/server/stdio.ts) | stdio 部署 | 读懂即可 |
| 其余文件 | 和第 13 天的参考答案一样，测试用其中的 `mcp.ts` 连接你的服务器 | 不用改 |

工具的注册已经写好了，它们调用你要写的 `searchNotes()` 和 `readNote()`。读路径用的是第 5 天的 `resolveInside()`，它保证不会读到笔记目录外面的文件。

## 常见误解

| 误解 | 实际上 |
|---|---|
| 服务器可以在内存里记住每个 client 的进度 | 无状态的服务器什么都不记，进度放进游标交给 client |
| 游标给 client 看的，格式要友好 | 游标对 client 不透明，加上版本号，格式可以随时改 |
| 有 `structuredContent` 就不用返回文字了 | 很多 client 只把文字交给模型，两份都要 |
| 工具出错就抛出异常 | 返回 `isError` 的结果，模型才能看到原因 |
| `console.log` 调试一下没关系 | stdio 部署时 stdout 是协议通道，日志只能写 stderr |
| 只监听本机就安全了 | 还要防 DNS 重绑定：检查 Host 和 Origin |

## 常见错误

| 报错 | 原因 |
|---|---|
| 测试说期望 `/^[A-Za-z0-9_-]+$/` | 游标用了普通的 `base64`，里面有 `+`、`/`、`=` |
| 测试说「search 的游标不能拿来 read」 | `decodeCursor` 没检查 `kind` |
| 测试说 calls 期望 3 | `readNote` 的 `nextCursor` 在最后一段也给了，或者 offset 没加上 `READ_CHUNK` |
| 测试说「工作目录之外」 | 读路径时没用 `resolveInside`，直接用了 `join` |
| 列出资源时没有 `note://work/release.md` | URI 模板写成了 `note://{path}`，或者 `list` 返回的 uri 格式不对 |
| 测试说期望 403，实际是 200 | HTTP 服务器没有检查 Host 和 Origin |

## 动手：写一个笔记服务器

按顺序做，每做完一步就运行一次 `npm run check 14`：

1. **TODO 1**：游标。`cursor.test.ts` 通过。
2. **TODO 2**：搜索和分页。
3. **TODO 3**：分段读笔记。`notes.test.ts` 通过，stdio 部署的工具调用也通了。
4. **TODO 4**：注册资源。
5. **TODO 5**：HTTP 部署的 Host 和 Origin 检查。全部测试通过。

## 检查

```bash
npm run check 14
```

今天的测试不调用模型。用真实模型验证的办法，是把服务器接到第 13 天的 mini-agent 上：在 `mcp.json` 里配好，问它你笔记里的内容。

```bash
node days/day14/exercise/cli.ts
```

## 小实验

- 用 Inspector 打开你的服务器，把每个工具、资源、提示词都调一遍
- 在 `search_notes` 的处理函数里加一行 `console.log`，用 stdio 连接，看看 host 那边报什么错
- 把同一个服务器同时配到 mini-agent 和 Claude Desktop（或 Cursor、Claude Code）里，问同一个问题
- 改一下游标的格式，把 `VERSION` 加一，用旧的游标调用，看看模型收到错误后怎么做
- 换成你真正常用的数据源：一个 SQLite 数据库、公司的 wiki、一个 RSS 订阅列表，写一个服务器

## 小结

- SDK v2 拆成了 server 和 client 两个包；工具用 zod 写输入输出的 schema，结果同时返回文字和结构化内容
- 工具出错返回 `isError` 的结果；annotations 如实标注
- 服务器无状态：跨调用的状态做成游标或句柄，交给 client 保管；游标带版本和上下文，需要时签名
- 资源用 URI 模板，提示词是给用户用的模板
- 工具的顺序和描述固定不变，才能命中提示缓存；stdio 部署时日志只能写 stderr
- 一个工厂函数，两种部署；HTTP 部署要防 DNS 重绑定

## 想一想

- 研究助手的一次请求里有 system prompt、十几个工具的定义、长长的对话历史、几个网页的内容。它们各占多少 token？哪些该放前面？（第 15 天）
- 提示缓存到底是怎么计费的？怎么知道有没有命中？（第 15 天）
- 研究进行到一半，上下文就满了。服务器返回的长结果、读过的网页，能不能不留在上下文里？（第 16 天）

## 延伸阅读

- [MCP TypeScript SDK v2：Server 指南](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools)：工具、资源、提示词的完整用法
- [MCP TypeScript SDK v2：部署](https://ts.sdk.modelcontextprotocol.io/v2/serving/http)：stdio、HTTP 和各种框架适配器
- [MCP 规范：Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)：`outputSchema`、`structuredContent`、annotations 的定义
- [MCP 规范：Security Best Practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)：服务器要注意的安全问题
- [RFC 6570：URI Template](https://www.rfc-editor.org/rfc/rfc6570)：`{+path}` 这种写法的来源
