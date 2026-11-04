// 第 12 天：把网页的 HTML 清洗成 Markdown。网页里大部分是导航、广告、脚本，正文只占一小部分；
// 原样交给模型，既浪费 token，又容易让它抓错重点。
// 这里用正则做一个够用的转换：去掉噪音，找出正文，再把常见的标签换成 Markdown。
// 遇到复杂的页面，可以换成成熟的库（比如 @mozilla/readability 配合 turndown），思路是一样的。
// 第 12 天的练习：TODO 1、2 在这里，TODO 3 在 search.ts，TODO 4–6 在 web.ts。检查：npm run check 12

export interface CleanPage {
  /** 网页的标题：<title>，没有就用第一个 <h1> */
  title: string;
  markdown: string;
}

/** 这些标签连同里面的内容整个去掉：脚本、样式，以及导航、页眉页脚、侧栏、表单这类不是正文的部分 */
const NOISE_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'nav', 'header', 'footer', 'aside', 'form'];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', copy: '©' };

/** 把 &amp;、&#39;、&#x4E2D; 这样的字符实体换回字符 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** 去掉所有标签，只留文字 */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 去掉注释和噪音标签。<header> 里有时包着文章的标题，一起去掉也不要紧：标题另外从 <title> 取 */
export function removeNoise(html: string): string {
  // TODO 1（一）：去掉 <!-- 注释 -->，以及 NOISE_TAGS 里每一种标签连同里面的内容。
  // 提示：用 new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi')，\\b 免得 <header> 误伤 <head>
  return html;
}

/** 找出正文：优先 <article>，其次 <main>，都没有就用 <body>，再没有就用整个文档 */
export function extractMain(html: string): string {
  // TODO 1（二）：依次找 <article>、<main>、<body>，找到哪个就返回它里面的内容（不含标签本身）；都没有就返回整个 html
  return html;
}

/** 相对链接换成绝对链接，模型拿到以后可以直接用 fetch_page 打开。javascript: 之类的链接去掉 */
export function resolveLink(href: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(decodeEntities(href), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** 去掉标签、合并空白，但先不换回字符实体：&lt;host&gt; 要等所有标签都去掉以后才能换回 <host>，不然会被当成标签去掉 */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** 把常见的标签换成 Markdown：标题、链接、列表、代码、强调、换行和段落 */
export function toMarkdown(html: string, baseUrl: string): string {
  // 代码块最先处理：先换成占位符，最后再放回去，免得里面的空格和换行被合并
  const blocks: string[] = [];
  let md = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => {
    blocks.push(decodeEntities(code.replace(/<[^>]*>/g, '')).trim());
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });
  // 先换行内的标签（链接、代码、粗体），再换块级的标签（标题、列表项）：块级标签里的文字会去掉剩下的标签
  // TODO 2（一）：链接 <a href="…">文字</a> 换成 [文字](网址)。网址用 resolveLink(href, baseUrl) 补全成绝对网址；
  // resolveLink 返回 undefined（比如 javascript: 链接）时只留文字；文字是空的（比如只有一张图片）就整个去掉。文字用 textOf 取
  void resolveLink;
  md = md.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, text: string) => `\`${textOf(text)}\``);
  md = md.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, text: string) => `**${textOf(text)}**`);
  // TODO 2（二）：<h1>…</h1> 到 <h6> 换成前后各空一行的「# 文字」（几级标题就几个 #）；
  // <li>…</li> 换成换行加「- 文字」。文字都用 textOf 取
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/(p|div|section|ul|ol|table|tr|blockquote)>/gi, '\n\n');
  md = md.replace(/<\/t[dh]>/gi, ' | ');
  // 剩下的标签都去掉，最后才把字符实体换回字符
  md = decodeEntities(md.replace(/<[^>]*>/g, ''));
  md = md
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``);
}

/** 网页 → 标题和 Markdown 正文 */
export function htmlToMarkdown(html: string, baseUrl: string): CleanPage {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  const markdown = toMarkdown(extractMain(removeNoise(html)), baseUrl);
  return { title, markdown };
}
