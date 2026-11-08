# 第 57 天：开源与发布

> 最后核对：2026-11-08

review-bot 上线了，但现在只有你知道它。今天让别人也能找到它、看懂它、用上它：写一份好的 README、录一段演示、定好版本号和更新日志、发布到 GitHub（和 npm），再想办法让第一批用户知道。

学完今天，你会：

- 写一份让陌生人 30 秒看懂、5 分钟跑起来的 README
- 用约定式提交（Conventional Commits）自动算出版本号、生成更新日志
- 发布前检查 package.json，不把测试、评估集、`.env` 发出去
- 完成一次正式发布，并且让第一批用户找到你

## README：30 秒和 5 分钟

一个陌生人打开你的仓库，大概只给你 30 秒。这 30 秒里他要知道三件事：**这是什么、跑起来什么样、跟我有没有关系**。决定试一试以后，他愿意花 5 分钟把它跑起来；5 分钟跑不起来，他就走了。

[release.ts](exercise/release.ts) 的 `checkReadme` 按这个顺序检查：

| 位置 | 内容 | 为什么 |
|---|---|---|
| 一级标题 + 一句话 | 给谁、解决什么问题，120 字以内 | 30 秒里的第一眼 |
| 一张图或者一段录屏 | 跑起来的样子 | 比任何文字都快 |
| 快速开始 | 能直接复制运行的命令 | 5 分钟跑起来 |
| 配置 | 要哪些 Key，哪些可选 | 卡住最多的地方 |
| 工作原理 | 一张图或者几句话 | 让人信得过 |
| 效果 | **数字**：在多少条用例上达到了多少 | Agent 项目最缺、也最有说服力的一节 |
| 局限 | 做不好什么、不做什么 | 诚实，也省得别人拿它做不该做的事 |
| 数据与隐私 | 数据发给谁、存多久 | 第 56 天的清单 |
| License | 用什么许可证 | 没写就是「保留所有权利」，别人不敢用 |

「效果」一节是 Agent 项目和普通开源项目最大的不同。大部分 Agent 项目的 README 只有「支持 XX、YY、ZZ」，没有一个数字。你有第 51 天的评估集和第 55 天的分数，写出来：多少条用例、什么指标、用的什么模型、跑了几次。**能拿出评估结果的项目，在一堆 demo 里一眼就能看出来**。

[example/README.md](example/README.md) 是 review-bot 的 README，[templates/README.md](templates/README.md) 是模板（它故意没写效果的数字，`checkReadme` 会提醒你填）。

### 演示

录一段 10–30 秒的动图或者视频，放在一句话介绍下面：

- **只录一件事**：review-bot 就录「提一个有 SQL 注入的 PR → 一分钟后出现一条评论」
- **加速等待的部分**：Agent 跑一分钟，没人想看一分钟
- **用真实的场景**，不要用 hello world
- 工具：macOS 的截屏加 [Gifski](https://gif.ski/)，或者终端录屏用 [VHS](https://github.com/charmbracelet/vhs)、asciinema

## 版本号和更新日志

### 约定式提交

如果你的提交信息写成这样：

```text
feat(review): 支持仓库根目录的 REVIEW.md
fix: 删掉的行造成的问题，评论落在附近的行
refactor!: 配置 SPEND_LIMIT 拆成 SPEND_DAILY 和 SPEND_MONTHLY
docs: README 加上效果一节
```

那么版本号和更新日志都可以从提交记录里算出来。`类型(范围): 描述`，类型后面的 `!` 或者正文里的 `BREAKING CHANGE:` 表示不兼容的改动。

`parseCommits` 读 `git log` 的输出。格式用 `%H%x1f%s%x1f%b%x1e`：用 ASCII 的单元分隔符（`\x1f`）和记录分隔符（`\x1e`）隔开，比用换行、逗号可靠，提交信息里不会出现它们。

### 语义化版本

`nextVersion` 按语义化版本（SemVer）算下一个版本号：

| 有什么提交 | 1.x 以后 | 0.x 的时候 |
|---|---|---|
| 不兼容的改动 | 主版本 +1：1.4.2 → 2.0.0 | 次版本 +1：0.4.2 → 0.5.0 |
| feat | 次版本 +1：1.4.2 → 1.5.0 | 次版本 +1 |
| fix、perf | 修订号 +1：1.4.2 → 1.4.3 | 修订号 +1 |
| 只有 docs、chore、test | 不用发版 | 不用发版 |

0.x 表示「还没稳定，随时可能改」，所以不兼容的改动只加次版本。毕业项目从 0.1.0 开始，等你愿意承诺接口不随便变了，再发 1.0.0。

对 Agent 项目，什么算「不兼容的改动」？除了接口和配置，**换了默认的模型、大改了 prompt** 也可能让用户看到的结果明显不同。在更新日志里写清楚，必要时当作不兼容的改动处理。

`renderChangelog` 生成这一版的更新日志：不兼容的改动放最前面，然后是新功能、修复、性能；docs、chore 不写，用户不关心。

## 发布到 npm

不是每个项目都要发到 npm：review-bot 是一个服务，用 Docker 部署（第 48 天）；如果你的项目是命令行工具或者库，发到 npm 别人用起来最方便。

`checkPackage` 发布前检查 package.json：

- `private: true` 不会被发布（课程仓库就是这样）
- `files` 列出要发布的文件。不写的话，测试、评估集、示例数据都会被发出去；`.npmignore` 写漏了，`.env` 都可能被发出去。**白名单比黑名单安全**
- `bin`（命令行工具）或者 `exports`（库）
- `engines.node`：我们用了 Node 22.18 才有的直接运行 .ts，要写明
- `description`、`license`、`repository`

发布前用 `npm pack --dry-run` 看一眼到底会发哪些文件。推荐在 CI 里发布（GitHub Actions 加 `npm publish --provenance`）：包上带着「由哪个仓库的哪次构建生成」的证明，npm 的令牌也不用放在你的电脑上。

## 一次正式的发布

[cli.ts](exercise/cli.ts) 把上面的检查串起来，算出下一个版本号和更新日志，**打印**发布的命令：

```bash
node days/day57/exercise/cli.ts /path/to/your/project
```

它不替你执行。打 tag、推送、`npm publish`、GitHub Release 都是不可逆的（npm 的版本号发布以后就不能再用），由人来看过、按下按钮（第 29 天）。

## 让第一批用户找到你

开源不等于有人用。几个对 Agent 项目有效的渠道：

| 渠道 | 怎么做 |
|---|---|
| 你自己的圈子 | 先装给自己的团队、朋友的团队用。第 50 天的三位试用者就是最好的第一批用户 |
| 写一篇文章 | 不要写「我做了一个 XX」，写**你踩过的坑和数字**：「我的审查机器人第一版有 40% 的评论是废话，我是怎么降下来的」 |
| 社区 | V2EX、掘金、少数派、即刻、Hacker News 的 Show HN、Reddit 的相关版块。照着各自的规矩发，别刷屏 |
| 列表 | awesome 系列的仓库、MCP 服务器的目录（你的项目有 MCP 服务器的话，第 53 天） |
| 这门课 | 提 PR 加到[学员作品墙](../../SHOWCASE.md)（第 60 天） |

发出去以后，**回复每一个 issue**，尤其是第一批。第一个提 issue 的人，很可能就是你的第一个贡献者。

## 读懂练习代码

| 文件 | 内容 | 今天要做的 |
|---|---|---|
| [release.ts](exercise/release.ts) | README 检查、提交记录、版本号、更新日志、package.json 检查 | TODO 1–5 |
| [cli.ts](exercise/cli.ts) | 串起来，打印发布的命令 | 读懂即可 |
| [example/README.md](example/README.md) | review-bot 的 README | 对照上面的表读一遍 |
| [templates/README.md](templates/README.md) | README 的模板 | 复制到你的项目里填 |

## 常见误解

| 误解 | 实际上 |
|---|---|
| 代码写得好，自然有人用 | 开源不等于有人知道；要写 README、录演示、去社区讲 |
| README 越详细越好 | 前 30 秒决定一切：一句话、一张图、快速开始放最前面 |
| Agent 项目列功能就行 | 写出评估的数字，这是最有说服力的一节 |
| 局限不要写，显得不够好 | 写局限让人信得过，也省得别人用错 |
| 版本号随便定 | 按语义化版本，用户才知道升级有没有风险 |
| 换模型、改 prompt 只是内部改动 | 用户看到的结果会变，要写进更新日志 |
| 用 .npmignore 排除不想发的文件就行 | 白名单（files）比黑名单安全 |

## 常见错误

| 报错 | 原因 |
|---|---|
| splitSections 的测试把代码块里的注释当成了标题 | 没有跟踪是不是在 ``` 里面 |
| 测试说一级标题下面要有一句话介绍，但没报 | 把图片当成了一句话介绍 |
| 一句话介绍的字数不对 | 用了 `.length`；要用 `[...文字].length` 数字数 |
| 「效果」里的数字明明在小节里，还是报了 | 没有把更深的小节算进这一节 |
| 提交记录的测试 `Fix:` 的类型是 Fix | 类型要转小写 |
| 正文里的 BREAKING CHANGE 没认出来 | 正则没加 m 标志，只匹配了正文的第一行 |
| 0.x 的 feat 算成了修订号 | 0.x 时 feat 也加次版本 |
| 1.2.3 加了 feat 变成 1.3.3 | 加了前面的，后面的要归零 |
| 更新日志多了 docs | 只写 GROUPS 里的四组 |

## 动手

1. **TODO 1**：`checkReadme`。
2. **TODO 2**：`parseCommits`。
3. **TODO 3**：`nextVersion`。
4. **TODO 4**：`renderChangelog`。
5. **TODO 5**：`checkPackage`。全部测试通过。
6. **写你的 README**：照着模板写，`checkReadme` 没有问题。请一位没见过你项目的朋友看 30 秒，问他这是什么；再请他照着快速开始跑一遍，记下他卡在哪里。
7. **录演示**：10–30 秒，只录一件事。
8. **发布 0.1.0**：开源（选一个许可证），用 `cli.ts` 检查，按它打印的步骤打 tag、写 GitHub Release（是库或者命令行工具的话发到 npm）。
9. **告诉别人**：至少一个渠道，写一篇有数字、有踩坑经历的文章或者帖子。

## 检查

```bash
npm run check 57
```

毕业项目对照这几条自查：

- [ ] 仓库公开了，有许可证
- [ ] README 通过 `checkReadme`；一位陌生人看懂了它是什么，并且照着跑起来了
- [ ] 有一段演示（动图或者视频）
- [ ] 发布了第一个版本，有 tag、GitHub Release 和更新日志
- [ ] 至少在一个渠道告诉了别人

## 小实验

- 用 `git log --format=%s` 看看你这十天的提交信息，有多少是约定式的？用 `cli.ts` 算一下，如果都写规范了会是什么版本
- 给你的仓库加一个 commitlint 或者 PR 标题检查，让约定式提交变成规矩
- `npm pack --dry-run` 看看你的包会发出去哪些文件，有没有不该发的
- 找三个 star 多的 Agent 项目，用 `checkReadme` 检查它们的 README。有几个写了评估的数字？

## 小结

- README 的前 30 秒：一句话、一张图；5 分钟：快速开始和配置；Agent 项目要写出评估的数字和局限
- 约定式提交让版本号和更新日志可以自动算出来；0.x 时不兼容的改动只加次版本
- 换模型、大改 prompt 也会改变用户看到的结果，要写进更新日志
- 发布到 npm 用 files 白名单，在 CI 里带来源证明发布；发布是不可逆的，命令由人来执行
- 开源不等于有人用：先给身边的人用，写有数字的文章，回复每一个 issue

## 想一想

- 如果面试官让你设计一个「给一万个仓库用的代码审查机器人」，review-bot 哪些地方要改？（第 58 天）
- 一万个仓库、每天十万个 PR，要多少并发、多少钱、模型服务的限流够不够？（第 58 天）

## 延伸阅读

- [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：约定式提交规范
- [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)：版本号的规则，包括 0.x
- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：更新日志写给人看
- [npm Docs：Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)：在 CI 里带来源证明发布
- [Make a README](https://www.makeareadme.com/)：README 写什么
- [choosealicense.com](https://choosealicense.com/)：怎么选许可证
