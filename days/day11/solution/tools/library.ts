// 第 11 天：一套设计好的文献库工具。和 library-bad.ts 查的是同一份数据，只是换了一种「给模型用」的设计：
// - 两个工具，职责不重叠：search_articles 找文章，read_article 读全文
// - 名字和参数一看就懂，描述里写清楚什么时候用、给出例子
// - 用有意义的 slug 引用文章，抄错了也能给出建议
// - 结果精简：每篇文章一行，只留模型用得到的字段
// - 长文分页，末尾说明怎么读下一页
// - 出错时说清楚错在哪、下一步怎么做
import { z } from 'zod';
import { ARTICLES, type Article } from '../data/articles.ts';
import { closest, defineTool, paginate, type Tool } from '../tool.ts';

/** read_article 每页最多多少个字符 */
export const LIBRARY_PAGE_SIZE = 600;
/** 摘要在搜索结果里最多显示多少个字符 */
const ABSTRACT_CHARS = 80;

/** 搜索结果里的一行：slug｜标题｜作者｜年份｜摘要 */
export function formatArticleLine(article: Article): string {
  const abstract = article.abstract.length > ABSTRACT_CHARS ? `${article.abstract.slice(0, ABSTRACT_CHARS)}…` : article.abstract;
  return `- ${article.slug}｜${article.title}｜${article.authors.join('、')}｜${article.year}｜${abstract}`;
}

export function createLibraryTools(articles: Article[] = ARTICLES): Tool[] {
  const tags = [...new Set(articles.flatMap((a) => a.tags))].sort();

  const searchArticles = defineTool({
    name: 'search_articles',
    description:
      '在文献库里搜索文章。关键词会匹配标题、摘要、作者和标签，多个关键词用空格分开，要全部匹配。' +
      '返回每篇文章的 slug、标题、作者、年份和摘要；要看全文，再用 read_article。' +
      '例子：{"query":"错误信息"}、{"query":"林澈"}、{"query":"","tag":"evaluation","year_from":2025}',
    schema: z.object({
      query: z.string().describe('关键词，比如「分页」「韩松」。只按标签或年份筛选时填空字符串'),
      tag: z.enum(tags as [string, ...string[]]).optional().describe('只看带这个标签的文章'),
      year_from: z.int().optional().describe('只看这一年及以后发表的文章，比如 2025'),
      limit: z.int().min(1).max(10).default(5).describe('最多返回几篇，默认 5'),
    }),
    execute({ query, tag, year_from, limit }) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = articles.filter((article) => {
        if (tag && !article.tags.includes(tag)) return false;
        if (year_from !== undefined && article.year < year_from) return false;
        const haystack = [article.title, article.abstract, ...article.authors, ...article.tags].join(' ').toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      if (hits.length === 0) {
        const filters = [tag && `tag=${tag}`, year_from !== undefined && `year_from=${year_from}`].filter(Boolean);
        const loosen = filters.length ? `，或者去掉筛选条件（${filters.join('、')}）` : '';
        return `没有找到匹配「${query}」的文章。可以换一个更短的关键词${loosen}。可用的标签：${tags.join('、')}`;
      }
      const shown = hits.slice(0, limit);
      const more = hits.length > shown.length ? `\n只显示了前 ${shown.length} 篇。想看更多，把 limit 调大，或者加上 tag、year_from 缩小范围` : '';
      return `共找到 ${hits.length} 篇：\n${shown.map(formatArticleLine).join('\n')}${more}`;
    },
  });

  const readArticle = defineTool({
    name: 'read_article',
    description: `读一篇文章的全文。slug 从 search_articles 的结果里来。长文章会分页，每页约 ${LIBRARY_PAGE_SIZE} 字，末尾会说明怎么读下一页`,
    schema: z.object({
      slug: z.string().describe('文章的 slug，比如 three-part-errors'),
      page: z.int().min(1).default(1).describe('读第几页，默认第 1 页'),
    }),
    execute({ slug, page }) {
      const article = articles.find((a) => a.slug === slug);
      if (!article) {
        const guess = closest(slug, articles.map((a) => a.slug));
        const hint = guess ? `你是不是想找 ${guess}？` : '';
        throw new Error(`没有 slug 为 ${slug} 的文章。${hint}不确定的话，先用 search_articles 搜索`);
      }
      const header = `# ${article.title}\n作者：${article.authors.join('、')}｜${article.year}｜标签：${article.tags.join('、')}\n\n`;
      return paginate(header + article.body, page, LIBRARY_PAGE_SIZE).content;
    },
  });

  return [searchArticles, readArticle];
}
