// 一个虚构的文献库，第 11 天的两套工具都查它。文章、作者和里面的结论都是编的：
// 模型不可能事先知道，答对了就说明它真的用工具查到了。
// 每条记录带着一些只有数据库自己用得到的字段（db_id、_rev、indexed_at……），设计糟糕的工具会把它们原样交给模型。

export interface Article {
  /** 数据库内部的编号，只有设计糟糕的工具会用它 */
  db_id: number;
  /** 给人和模型用的短名字 */
  slug: string;
  title: string;
  authors: string[];
  year: number;
  tags: string[];
  abstract: string;
  body: string;
  /** 下面这些只有数据库自己用得到 */
  _rev: string;
  indexed_at: number;
  storage: { bucket: string; key: string; bytes: number };
  acl: string[];
}

const record = (article: Omit<Article, '_rev' | 'indexed_at' | 'storage' | 'acl'>): Article => ({
  ...article,
  _rev: `3-${(article.db_id * 2654435761).toString(16).slice(-12)}`,
  indexed_at: 1_760_000_000_000 + article.db_id * 86_400_000,
  storage: { bucket: 'lib-prod-cn-east', key: `articles/${article.db_id}.md`, bytes: Buffer.byteLength(article.body) },
  acl: ['role:reader', 'role:editor', `owner:${article.authors[0]}`],
});

/** 一篇很长的文章，读到最后一节才有答案，用来练习分页 */
const BUDGET_HANDBOOK = [
  '## 一、为什么要做预算',
  ...Array.from({ length: 12 }, (_, i) => `上下文窗口是有限的资源，第 ${i + 1} 条经验：每加一段内容之前，先问它能不能帮模型做出更好的下一步决定。不能，就不加。`),
  '## 二、预算怎么分',
  ...Array.from({ length: 12 }, (_, i) => `分配预算时，固定部分（system prompt、工具定义）先扣掉，剩下的按任务类型分配。观察 ${i + 1}：对话越长，历史占的比例越大。`),
  '## 三、预算用完了怎么办',
  ...Array.from({ length: 12 }, (_, i) => `超出预算时先删最旧、最大、最不相关的内容。做法 ${i + 1}：旧的工具输出可以只留一行摘要。`),
  '## 四、我们的建议',
  '根据 37 个项目的统计，我们建议把总预算的 30% 留给工具结果，20% 留给对话历史，其余留给 system prompt、检索结果和输出。',
  '工具结果之所以要留得最多，是因为它是 Agent 了解外部世界的唯一途径。',
].join('\n');

export const ARTICLES: Article[] = [
  record({
    db_id: 1001,
    slug: 'tool-description-length',
    title: '工具描述越长越好吗？一次对照实验',
    authors: ['林澈', '周以宁'],
    year: 2025,
    tags: ['tools', 'evaluation'],
    abstract: '我们在 6 个任务上比较了不同长度的工具描述，发现描述在 120 到 400 字之间时成功率最高。',
    body: '描述太短，模型不知道什么时候该用这个工具；描述太长，关键信息被淹没。超过 400 字以后，成功率下降了 6 个百分点。最有效的写法是：一句话说清用途，再说什么时候不该用，最后给一个例子。',
  }),
  record({
    db_id: 1002,
    slug: 'three-part-errors',
    title: '让模型自己改正：三段式错误信息',
    authors: ['唐果'],
    year: 2024,
    tags: ['tools', 'errors'],
    abstract: '提出「三段式错误信息」：发生了什么、为什么、下一步怎么做。在参数错误的场景下，模型一次改对的比例从 41% 提高到 88%。',
    body: '只返回 Error 400 的工具，模型只能瞎猜。三段式错误信息依次说明：发生了什么（参数 date 的格式不对）、为什么（需要 YYYY-MM-DD）、下一步怎么做（比如改成 2025-03-01 再试）。',
  }),
  record({
    db_id: 1003,
    slug: 'tool-overlap',
    title: '工具职责重叠带来的选择困难',
    authors: ['周以宁', '韩松'],
    year: 2025,
    tags: ['tools', 'evaluation'],
    abstract: '当两个工具的职责有 50% 以上的重叠时，模型选错工具的概率是没有重叠时的 3.2 倍。',
    body: '我们把 search 和 lookup 两个职责重叠的工具合并成一个 search_articles 以后，选错工具的情况几乎消失了。建议：一个工具只做一件事，两个工具之间的边界要能用一句话说清楚。',
  }),
  record({
    db_id: 1004,
    slug: 'context-budget-handbook',
    title: 'Agent 上下文预算手册',
    authors: ['林澈'],
    year: 2025,
    tags: ['context'],
    abstract: '一本关于怎么给上下文分配 token 预算的手册，最后一节给出了具体的比例建议。',
    body: BUDGET_HANDBOOK,
  }),
  record({
    db_id: 1005,
    slug: 'mcp-in-production',
    title: 'MCP 服务器上线一年的教训',
    authors: ['韩松'],
    year: 2026,
    tags: ['mcp'],
    abstract: '总结了运营 14 个 MCP 服务器一年的经验，最大的教训是工具的返回结果要短。',
    body: '我们统计了 14 个服务器的日志：返回结果超过 8000 字符的调用，后续出错的概率是其他调用的 2.5 倍。把结果精简到只留模型需要的字段以后，平均每个任务少用了 31% 的 token。',
  }),
  record({
    db_id: 1006,
    slug: 'id-vs-name',
    title: '给模型用的标识符：数字 ID 还是有意义的名字',
    authors: ['唐果', '林澈'],
    year: 2023,
    tags: ['tools'],
    abstract: '比较了用数字 ID 和用有意义的短名字（slug）引用对象时，模型抄错的概率。',
    body: '数字 ID 很容易抄错一位，而且抄错以后往往指向另一个真实存在的对象，错误难以发现。有意义的短名字抄错时通常对不上任何对象，工具能直接报错并给出建议。我们的实验里，用短名字时引用错误减少了 74%。',
  }),
  record({
    db_id: 1007,
    slug: 'eval-small-sets',
    title: '二十道题的评估集也有用',
    authors: ['周以宁'],
    year: 2026,
    tags: ['evaluation'],
    abstract: '评估集不必一开始就很大。20 道精心挑选的题目，已经能发现大多数明显的退化。',
    body: '我们回顾了 9 次线上事故，其中 7 次本可以被一个 20 道题的评估集提前发现。关键是题目要覆盖真实用户最常见的几类问题，每道题都要有明确的判分标准。',
  }),
  record({
    db_id: 1008,
    slug: 'pagination-for-agents',
    title: '分页：给 Agent 的长文本阅读方式',
    authors: ['韩松', '唐果'],
    year: 2024,
    tags: ['tools', 'context'],
    abstract: '与其截断长文本，不如分页返回，并在每页末尾告诉模型怎么读下一页。',
    body: '截断会让模型以为它看到了全部内容。分页时在末尾注明「第 1/3 页，用 page=2 读下一页」，模型会在需要时继续读，不需要时就停下，平均比一次返回全文节省 45% 的 token。',
  }),
];
