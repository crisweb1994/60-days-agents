// 第 11 天：一套设计好的文献库工具。和 library-bad.ts 查的是同一份数据，只是换了一种「给模型用」的设计：
// - 两个工具，职责不重叠：search_articles 找文章，read_article 读全文
// - 名字和参数一看就懂，描述里写清楚什么时候用、给出例子
// - 用有意义的 slug 引用文章，抄错了也能给出建议
// - 结果精简：每篇文章一行，只留模型用得到的字段
// - 长文分页，末尾说明怎么读下一页
// - 出错时说清楚错在哪、下一步怎么做
// 第 11 天的练习：TODO 4、5 在这里。检查：npm run check 11
import { z } from 'zod';
import { ARTICLES, type Article } from '../data/articles.ts';
import { closest, defineTool, paginate, type Tool } from '../tool.ts';

/** read_article 每页最多多少个字符 */
export const LIBRARY_PAGE_SIZE = 600;
/** 摘要在搜索结果里最多显示多少个字符 */
const ABSTRACT_CHARS = 80;

/** 搜索结果里的一行：slug｜标题｜作者｜年份｜摘要 */
export function formatArticleLine(article: Article): string {
  // TODO 4（一）：格式是「- slug｜标题｜作者1、作者2｜年份｜摘要」。摘要超过 ABSTRACT_CHARS 个字符时截短，末尾加「…」
  return JSON.stringify(article);
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
      // TODO 4（二）：把结果写成对模型友好的样子。
      // - 一篇都没有：不要返回空字符串。说明没有找到匹配「query」的文章，建议换一个更短的关键词；
      //   用了 tag 或 year_from 时，建议去掉这些筛选条件（写出来，比如 tag=mcp）；最后列出可用的标签 tags
      // - 有结果：第一行「共找到 N 篇：」，然后最多 limit 行 formatArticleLine
      // - 结果比 limit 多：最后再加一行，说明只显示了前几篇，想看更多可以调大 limit，或者用 tag、year_from 缩小范围
      return hits;
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
      // TODO 5：读一篇文章。
      // - 找不到这个 slug：抛出错误，说明没有这篇文章；用 closest 找出最像的 slug，有的话问「你是不是想找 xxx？」；
      //   最后建议不确定时先用 search_articles 搜索
      // - 找到了：开头是「# 标题」，下一行是「作者：…｜年份｜标签：…」，空一行接正文；
      //   再用 paginate 按 LIBRARY_PAGE_SIZE 分页，返回第 page 页的 content
      void closest;
      void paginate;
      const article = articles.find((a) => a.slug === slug);
      return article?.body.slice(0, 500) ?? '';
    },
  });

  return [searchArticles, readArticle];
}
