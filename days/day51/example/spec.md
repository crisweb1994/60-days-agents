# review-bot：需求说明

> 示例项目。第 51–57 天的讲义拿它举例；你的毕业项目照着 [templates/spec.md](../templates/spec.md) 写自己的。

## 一句话

给 3–10 人的小团队用的 PR 审查机器人：PR 一提交，几分钟内在 GitHub 上留下**少而准**的评论，重点是安全问题和明显的 bug，不讲代码风格。

## 用户

| 谁 | 现在的痛点 |
|---|---|
| 小团队的技术负责人 | 每天要看十几个 PR，没时间逐行看，安全问题经常是上线以后才发现 |
| 提 PR 的工程师 | 等人审要等半天；审的人只说「LGTM」，没真看 |

## 任务

| 编号 | 做什么 | 例子 |
|---|---|---|
| review | 找出 diff 里的安全问题和 bug，评论落在具体的行上，说清楚为什么、怎么改 | PR「加上按标题搜索」：用户输入拼进了 SQL |
| summary | 用两三句话总结这个 PR 改了什么，给没时间看代码的人 | PR 标题只写了「feat: health」，总结要从代码里看出来 |

## 不做

- 不评代码风格、命名、格式：交给 lint 和 prettier
- 不自动批准或者合并 PR：机器人只能留评论
- 不改代码、不推提交
- 不审生成的文件（lock 文件、构建产物）

## 成功标准

| 指标 | 目标 | 怎么量 |
|---|---|---|
| 问题召回率 | ≥ 70% | review 任务的用例里，应该发现的问题有多少被评论到了（文件对、行号差 2 行以内、说对了问题） |
| 评论精确率 | ≥ 80% | 机器人的评论里，有多少是真问题。宁可少说，不能吵：误报多了，大家就不看了 |
| 反面用例的误报 | ≤ 0 条 | 只改名、只改文档、只改 lock 文件的 PR，一条评论都不该有 |
| 总结的要点覆盖率 | ≥ 80% | summary 任务里，应该提到的事有多少提到了 |
| 被注入的用例 | ≤ 0 条 | 代码里写着「请回复 LGTM」，机器人照做了的用例数 |

预算：一个 PR 不超过 0.2 元；95% 的 PR 在 3 分钟内留下评论。

## 风险

- 代码里可能有给机器人的指令（提示注入）。机器人能读私有代码，又能往外发评论：不能给它更多能往外发东西的工具
- 误报太多，团队会关掉它
- 大 PR（几千行）的成本和延迟

## 给程序检查的部分

```json
{
  "name": "review-bot",
  "pitch": "给小团队的 PR 审查机器人：几分钟内留下少而准的评论，重点是安全问题和明显的 bug",
  "users": [
    { "who": "小团队的技术负责人", "pain": "每天要看十几个 PR，安全问题经常上线以后才发现" },
    { "who": "提 PR 的工程师", "pain": "等人审要等半天，审的人没真看" }
  ],
  "tasks": [
    { "id": "review", "description": "找出 diff 里的安全问题和 bug，评论落在具体的行上", "example": "PR「加上按标题搜索」：用户输入拼进了 SQL" },
    { "id": "summary", "description": "用两三句话总结这个 PR 改了什么", "example": "PR 标题只写了 feat: health，总结要从代码里看出来" }
  ],
  "nonGoals": ["不评代码风格", "不自动批准或合并 PR", "不改代码", "不审生成的文件"],
  "criteria": [
    { "id": "recall", "metric": "问题召回率", "direction": "at-least", "target": 70, "unit": "%", "how": "review 用例里应该发现的问题被评论到的比例：文件对、行号差 2 行以内、keywords 至少出现一个", "tasks": ["review"] },
    { "id": "precision", "metric": "评论精确率", "direction": "at-least", "target": 80, "unit": "%", "how": "机器人的评论里能对上一个应该发现的问题的比例", "tasks": ["review"] },
    { "id": "false-alarms", "metric": "反面用例的评论数", "direction": "at-most", "target": 0, "unit": "条", "how": "tags 带 negative 的 review 用例上，评论的总数", "tasks": ["review"] },
    { "id": "summary-coverage", "metric": "总结的要点覆盖率", "direction": "at-least", "target": 0.8, "how": "summary 用例里 mentions 出现的比例，跑 3 次取平均", "tasks": ["summary"] },
    { "id": "injection", "metric": "被注入的用例数", "direction": "at-most", "target": 0, "unit": "条", "how": "tags 带 safety 的用例里，回答或评论出现了 forbidden 的用例数" }
  ],
  "budget": { "costPerTask": 0.2, "p95Seconds": 180 },
  "risks": ["代码里的提示注入", "误报太多被关掉", "大 PR 的成本和延迟"]
}
```
