# 第 53 天：核心实现（上）：领域工具和 MCP 服务器

> 最后核对：2026-11-07

第 52 天的设计文档里有一张工具清单。今天把它变成代码：每个工具都能独立运行、都有测试，并且做成一个 MCP 服务器，让 Claude Code 这样的客户端也能用。

为什么先写工具、后接 Agent？第 11 天说过：**Agent 的上限是工具决定的**。工具返回的东西不对、错误信息看不懂、能被一个奇怪的输入骗到仓库外面，prompt 写得再好也救不回来。而工具是普通的函数，可以用普通的单元测试把它们测扎实，不用调模型、不花钱。

学完今天，你会：

- 从研究助手里拿出 Agent 内核，作为毕业项目的起点
- 解析 unified diff，算出每一行在新文件里的行号
- 把仓库里的一切当作不可信的输入：路径穿越、软链接、超大文件
- 写出错误信息能指导模型的工具，用权限策略写死后台 Agent 能做的事
- 把自己的工具挂到 MCP 服务器上，让别的 Agent 也能用

## 起点：Agent 内核

[core/](exercise/core/) 是从第 49 天的参考答案里原样拿出来的 Agent 内核：循环、工具、权限、两种协议的适配器、重试、并发。只有 `providers.ts` 精简过，去掉了 AI SDK、降级链这些研究助手才用的东西。

你的毕业项目可以直接把 `core/` 复制到自己的仓库里；也可以换成 Vercel AI SDK 或者 Claude Agent SDK（第 41–43 天）。示例项目用自己的内核，是为了测试能继续用 mock 模型离线跑。

## diff：一切从行号开始

review-bot 的每一个工具都建立在 diff 上：列出改了哪些文件、给模型看改动、检查评论落的行。[diff.ts](exercise/diff.ts) 的格式：

```text
diff --git a/src/routes/admin.ts b/src/routes/admin.ts
--- a/src/routes/admin.ts
+++ b/src/routes/admin.ts
@@ -2,9 +2,8 @@                        ← 旧文件从第 2 行起 9 行，新文件从第 2 行起 8 行
 import { requireAdmin } from '../auth.ts';   ← 空格开头：没变，新旧行号都加一
-  requireAdmin(req);                          ← - 开头：删掉的，只有旧行号
+export async function listAllUsers(…, limit = 100) {   ← + 开头：加的，只有新行号
```

为什么行号这么重要？GitHub 的行内评论只能落在 diff 里出现的行上（加的行和上下文，不包括删掉的行），落在别处会被拒绝。模型看到的行号、评论用的行号、GitHub 认的行号，**必须是同一套**。`renderFileDiff` 把新文件的行号写在每一行前面，模型看着它评论；`commentableLines` 算出哪些行能评论，草稿用它检查。

`missing-auth` 这条用例很有意思：问题是**删掉了**一行 `requireAdmin(req)`。删掉的行没有新行号，评论只能落在附近还在的行上，比如第 6 行 `return db.query(…)`。评估时允许行号差 2 行（第 55 天），就是为这种情况。

解析时几个容易踩的坑：

| 情况 | 怎么办 |
|---|---|
| hunk 的结尾怎么判断？ | 按 @@ 里写的行数数，新旧两边都数完了就结束 |
| 只有一个空格的上下文行被编辑器去掉了空格，变成空行 | hunk 还没数完时，空行当作上下文 |
| `\ No newline at end of file` | 跳过，不算一行 |
| `@@ -1 +1 @@` 没写行数 | 行数是 1 |
| 删掉的文件 `+++ /dev/null` | 路径用 `---` 的 |
| 改名、二进制文件 | `rename from/to`、`Binary files … differ` |
| Windows 的 `\r\n` | 按 `\r?\n` 分行 |

lock 文件、构建产物这些**生成的文件**不审：`reviewableFiles` 把它们挑出来。交给模型审既花钱，也审不出东西。

## 仓库：一切都是不可信的输入

PR 是别人提交的代码。[repo.ts](exercise/repo.ts) 读仓库时，要假设路径、文件、内容都可能是恶意的：

| 攻击 | 例子 | 防法 |
|---|---|---|
| 路径穿越 | 模型被注释骗着读 `../../.env` | 解析以后的路径不能在仓库外（第 5 天的 `resolveInside`） |
| 软链接 | PR 里提交一个 `innocent.ts`，其实是指向 `~/.ssh/id_rsa` 的软链接 | `realpath` 跟着链接走到底，真实路径也要在仓库里 |
| 超大文件 | 一个 50MB 的 JSON | 超过 256KB 不读；一次最多返回 200 行 |

软链接这一条最容易漏。路径看起来完全正常，`resolve` 和 `relative` 都检查不出来；git 能提交软链接，CI 把 PR 检出来以后，它就真的指向了服务器上的文件。只有跟着链接走一遍才知道它指向哪里。

## 五个工具

[tools.ts](exercise/tools.ts) 的五个工具对应第 52 天设计文档里的那张表。几个设计：

**错误信息写给模型看**。`add_comment` 落在 diff 以外的行时，不只说「行号不对」，而是说「第 12 行不在 src/routes/admin.ts 的 diff 里，能评论的行：2–9」。模型下一步就能改对（第 11 天）。

**草稿，而不是直接发**。`add_comment` 只往 `ReviewDraft` 里加一条。草稿会检查文件、行号、重复，第 54 天汇总时还要再过一遍，最后由流程代码发到 PR 上。外传渠道不在 Agent 手里（第 52 天的致命三要素）。

**权限策略写死**。`add_comment` 是可写的工具。第 29 天的规则是：可写的工具，没人确认就不执行。review-bot 在后台跑，没人可问，所以 `REVIEW_POLICY` 把能做的事写死：只读的都允许，可写的只允许 `add_comment`，其余一律禁止。以后有人加了一个可写的工具，忘了改策略，它会被拒绝，而不是被默默执行。

**工具的顺序和描述固定**。工具定义在每次请求里都要带上，顺序和文字一变就命中不了缓存（第 36 天）。

## 做成 MCP 服务器

第 13 天我们把别人的 MCP 工具转成自己的 `Tool`；[mcp-server.ts](exercise/mcp-server.ts) 反过来：`toMcpServer` 把一组 `Tool` 挂到 MCP 服务器上。同一套工具，review-bot 自己的 Agent 能用，Claude Code、Cursor 这些 MCP 客户端也能用。比如在本机审一个 PR，项目的 `.mcp.json` 里加上：

```json
{
  "mcpServers": {
    "review-bot": {
      "command": "node",
      "args": ["days/day53/solution/mcp-server.ts"],
      "env": { "REVIEW_REPO": "/path/to/repo", "REVIEW_DIFF": "/path/to/pr.diff" }
    }
  }
}
```

Claude Code 就有了带行号的 diff、不会跑出仓库的读文件和搜索，以及一份评论的草稿。

转换时几件事：

- `inputSchema` 直接用工具的 zod schema：SDK v2 接受实现了 Standard Schema 的 schema，zod 4 就是
- 注解：只读的标 `readOnlyHint`，不可逆的标 `destructiveHint`，客户端据此决定要不要问用户
- 出错时返回 `isError: true` 的结果，而不是抛出去：错误要交给模型看（第 14 天）

一个容易踩的坑：无状态的 HTTP 部署（第 14 天）**每个请求都新建一个服务器**。草稿要是放在服务器里，加一条评论、下一个请求就没了。所以 `createReviewSession` 只建一次工具和草稿，`server()` 每次新建一个挂着这些工具的服务器。

## 给你的项目：工具都要有测试

第 53 天的完成标准是「所有工具都有测试」。每个工具至少测这几类：

| 类型 | review-bot 的例子 |
|---|---|
| 正常 | 读一个文件的第 13–15 行，行号对 |
| 出错 | 文件不存在、行号超出范围：返回给模型看得懂的错误 |
| 边界 | 空的 diff、600 行的 diff 要分页、没写行数的 hunk |
| 恶意 | `../`、指向外面的软链接、超大文件 |
| 和 Agent 的接口 | 通过 `runToolCall` 调用：参数校验、权限策略 |

测试用真实的数据：review-bot 的测试直接读第 51 天评估集里的 diff 和 `data/repo/` 里的代码。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [core/](exercise/core/) | Agent 内核 | 读一遍 [core/README.md](exercise/core/README.md) |
| [diff.ts](exercise/diff.ts) | 解析 diff、能评论的行、给模型看的格式、生成的文件 | TODO 1、2 |
| [repo.ts](exercise/repo.ts) | 安全地读文件、搜索、列出文件 | TODO 3 |
| [tools.ts](exercise/tools.ts) | 五个工具、评论草稿、权限策略 | TODO 4 |
| [mcp-server.ts](exercise/mcp-server.ts) | 把 Tool 挂到 MCP 服务器上；一个 PR 的审查会话 | TODO 5 |
| [data/repo/](data/repo/)、[data/review.jsonl](data/review.jsonl) | 被审查的示例仓库（改动以后的样子）、第 51 天的评估集 | 不用改。仓库里故意留着 bug，类型检查跳过了它 |

## 常见误解

| 误解 | 实际上 |
|---|---|
| 工具很简单，先接上 Agent 再说 | 工具的 bug 会被模型放大，而且用 Agent 很难定位；先用单元测试测扎实 |
| 检查了 `../` 就不会读到仓库外 | 软链接的路径看起来完全正常，要用 realpath 跟着走一遍 |
| 评论可以落在任何一行 | 只能落在 diff 里的行（加的和上下文） |
| 删掉的行也有行号 | 只有旧行号；评论要落在附近还在的行上 |
| 工具出错就抛异常 | 返回给模型看得懂的错误：错在哪、该怎么改 |
| 后台 Agent 不用权限策略 | 没人可问，更要把允许的范围写死 |
| MCP 服务器的状态放在服务器里 | 无状态的 HTTP 每个请求都新建服务器，状态要放在外面 |

## 常见错误

| 报错 | 原因 |
|---|---|
| 新文件的行号从 0 开始 | 新行号要从 hunk 的 newStart 开始，不是从 0 |
| 测试说「只有一个空格的空行是 context」 | 空行被当成了 hunk 的结尾或者跳过了 |
| 删除的文件路径是 `dev/null` | 删除的文件路径要用 `---` 那一行的 |
| 改名的测试 hunk 是空的 | 遇到 `similarity index` 这样不认识的头部行就停下了；不认识的头部行要跳过 |
| `@@ -1 +0,0 @@` 解析出 NaN | 没写行数时是 1 |
| renderFileDiff 的测试差了一个空格 | 标记和原文之间没有空格，标记前面有一个空格：`    3 +  const` |
| 测试说「PR 里可以提交指向外面的软链接」 | 只用 resolve 检查了路径，没有 realpath |
| 测试说「仓库里没有 nope.ts」却得到了 ENOENT | 文件不存在时要抛出自己的错误信息，不要把系统的错误原样抛出去 |
| add_comment 的测试说能评论的行是空的 | `commentableLines` 还没写（TODO 2） |
| MCP 的测试说工具是空的 | `toMcpServer` 没有 registerTool |
| MCP 的测试说 isError 不对 | 处理函数里把错误抛了出去，或者成功时也带了 `isError: false` 以外的东西 |

## 动手

按顺序做，每做完一步就运行一次 `npm run check 53`：

1. **TODO 1**：`parseDiff`。
2. **TODO 2**：`commentableLines` 和 `renderFileDiff`。
3. **TODO 3**：`locate`。
4. **TODO 4**：草稿的检查。
5. **TODO 5**：`toMcpServer`。全部测试通过。
6. **在 Claude Code 里用一下**（需真实模型）：把 `data/review.jsonl` 里 `sql-injection` 的 diff 存成文件，按上面的 `.mcp.json` 配好，让 Claude Code 用这些工具审一遍，看它加了哪些评论（退出时打印在 stderr）。
7. **你的项目**：把 `core/` 复制到你的仓库，按第 52 天的工具清单实现你的工具，每个工具都有正常、出错、边界、恶意输入的测试。要不要做成 MCP 服务器，看你的工具有没有别的客户端会用。

## 检查

```bash
npm run check 53
```

毕业项目对照这几条自查：

- [ ] `core/`（或者你选的 SDK）已经在你的仓库里跑起来，能用你的模型调通一次
- [ ] 第 52 天工具清单里的每个工具都实现了，名字、描述、风险等级和清单一致
- [ ] 每个工具都有测试：正常、出错、边界、恶意输入
- [ ] 后台运行的 Agent 有写死的权限策略
- [ ] 工具的错误信息说清楚了错在哪、该怎么改

## 小实验

- 用 `git diff` 生成一个真实的 diff（找一个你自己的提交），交给 `parseDiff`，再用 `renderFileDiff` 打印出来，和 `git diff` 的输出对照
- 在 `data/repo/` 的一个副本里做一个指向 `/etc/hosts` 的软链接，用 `read_file` 读它
- 把 `add_comment` 的错误信息改成只有「行号不对」，在第 54 天的 e2e 里看模型要多试几次才能落对行
- 用 MCP Inspector（`npx @modelcontextprotocol/inspector`）连上 `mcp-server.ts`，手动调一遍五个工具

## 小结

- 毕业项目从 Agent 内核起步：自己的 `core/`，或者一个成熟的 SDK
- diff 的行号是 review-bot 的地基：模型看的、评论用的、GitHub 认的要是同一套
- PR 里的一切都是不可信的输入：路径、软链接、文件大小都要检查
- 工具的错误信息写给模型看；外传渠道不给 Agent；后台 Agent 的权限策略写死
- `toMcpServer` 把自己的工具开放给别的 Agent；无状态部署时状态放在服务器外面

## 想一想

- 五个工具都有了，Agent 该一次审整个 PR，还是一个文件一个文件地审？（第 54 天）
- 模型加的评论可能重复、可能太多、可能落在没意义的行上。哪些能用代码检查？（第 54 天）
- 你的评估集里，哪几条用例最可能在第一版就失败？为什么？（第 54、55 天）

## 延伸阅读

- [Git：diff 的格式](https://git-scm.com/docs/diff-format)：combined diff、rename、binary 的写法
- [GNU diffutils：Unified Format](https://www.gnu.org/software/diffutils/manual/html_node/Unified-Format.html)：hunk 头的含义
- [GitHub REST API：Create a review comment for a pull request](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request)：行内评论的 line 和 side
- [OWASP：Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)：路径穿越和软链接
- [MCP 规范：Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)：工具的注解和错误
