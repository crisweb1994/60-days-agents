// 一套设计糟糕的文献库工具，用来和 library.ts 对照。不要改它：第 11 天要用它测出「改前」的成功率。
// 它集中了常见的毛病：
// - 名字和描述太含糊：query、lookup 是查什么？t 填什么？
// - 两个工具的职责重叠：lookup 和 fetch_doc 都是「按编号拿一篇文章」，模型不知道该用哪个
// - 用数字 ID 引用对象，容易抄错
// - 结果是整条数据库记录：内部字段、全文一股脑塞给模型
// - 偷偷截断：fetch_doc 只返回前 500 个字符，却不说后面还有
// - 错误信息只有一个 404，模型不知道错在哪、该怎么办
import { z } from 'zod';
import { ARTICLES, type Article } from '../data/articles.ts';
import { defineTool, type Tool } from '../tool.ts';

export function createBadLibraryTools(articles: Article[] = ARTICLES): Tool[] {
  const query = defineTool({
    name: 'query',
    description: '查询数据',
    schema: z.object({ q: z.string(), t: z.string() }),
    execute({ q, t }) {
      const needle = q.toLowerCase();
      const hits = articles.filter((a) =>
        t === 'u' ? a.authors.some((name) => name.includes(q)) : `${a.title}${a.abstract}${a.tags}`.toLowerCase().includes(needle),
      );
      return hits; // 整条记录原样返回
    },
  });

  const lookup = defineTool({
    name: 'lookup',
    description: '查找',
    schema: z.object({ id: z.number() }),
    execute({ id }) {
      const article = articles.find((a) => a.db_id === id);
      if (!article) throw new Error('404');
      return article;
    },
  });

  const fetchDoc = defineTool({
    name: 'fetch_doc',
    description: '获取文档',
    schema: z.object({ docId: z.string() }),
    execute({ docId }) {
      const article = articles.find((a) => String(a.db_id) === docId);
      if (!article) throw new Error('404');
      return article.body.slice(0, 500);
    },
  });

  return [query, lookup, fetchDoc];
}
