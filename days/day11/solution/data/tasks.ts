// 第 11 天的小任务。答案都只能从文献库里查到，每道题考一种工具设计上的问题。
import type { BenchTask } from '../bench.ts';

export const TASKS: BenchTask[] = [
  {
    // 要找到文章，再读出正文里的一个数字
    name: '找到文章，读出结论',
    question: '文献库里有一篇讲「三段式错误信息」的文章。用了这种错误信息以后，模型一次改对的比例提高到了多少？',
    check: (answer) => answer.includes('88'),
  },
  {
    // 要按作者搜索。设计糟糕的工具里，按作者搜要把 t 填成 u，描述里却没说
    name: '按作者搜索',
    question: '文献库里，韩松参与写的文章有哪几篇？只列出标题。',
    check: (answer) => ['MCP 服务器上线一年的教训', '分页', '职责重叠'].every((title) => answer.includes(title)),
  },
  {
    // 答案在长文的最后一节。设计糟糕的工具会悄悄截断，模型以为自己读完了
    name: '读完长文',
    question: '《Agent 上下文预算手册》最后一节建议，把总预算的百分之多少留给工具结果？',
    check: (answer) => /30\s*%|百分之三十/.test(answer),
  },
  {
    // 按标签和年份筛选，再数数
    name: '筛选再计数',
    question: '文献库里 2025 年及以后发表、带 evaluation 标签的文章有几篇？',
    check: (answer) => /(?<!\d)3(?!\d)\s*篇|三篇/.test(answer),
  },
];
