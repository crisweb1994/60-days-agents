// 第 17 天：把文档切成小块。检索的单位是块，不是整篇文档：
// 块太大，一块里混着好几件事，向量就成了一个模糊的平均值，检索出来还占满上下文；
// 块太小，一句话脱离了上下文，意思不完整。
// Markdown 的标题天然是好的切分点：先按标题分节，节太长再按段落切，段落还太长就硬切，相邻的块之间留一点重叠。
// 第 17 天的练习：TODO 2 在这里。检查：npm run check 17

export interface Chunk {
  /** 文档路径加序号，比如 guide/deploy.md#2 */
  id: string;
  /** 文档的路径，相对于文档目录 */
  path: string;
  /** 这一块所在的标题层级，比如「部署 > 用 Docker 部署」。没有标题时是空字符串 */
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /** 每块最多多少个字符，默认 800 */
  maxChars?: number;
  /** 硬切时，相邻两块重叠多少个字符，默认 100 */
  overlap?: number;
}

interface Section {
  heading: string;
  body: string;
}

/** 按标题分节。每个 # 标题开始一节，heading 是从一级标题到当前标题的路径 */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const path: string[] = [];
  let body: string[] = [];
  let inCode = false;
  const flush = () => {
    const text = body.join('\n').trim();
    if (text) sections.push({ heading: path.filter(Boolean).join(' > '), body: text });
    body = [];
  };
  // TODO 2（一）：逐行处理。
  // - 以 ``` 开头的行（去掉前面的空白）切换「在代码块里」的状态；代码块里的行都当作正文
  // - 不在代码块里、并且匹配 /^(#{1,6})\s+(.+?)\s*#*$/ 的是标题：先 flush() 把之前的正文存成一节，
  //   再更新 path：几级标题，就把 path 截到 级数 - 1 个，然后把这个标题放在第 级数 个位置
  // - 其他行放进 body
  void inCode;
  body = markdown.split('\n');
  flush();
  return sections;
}

/** 一段太长的文字硬切成几块，每块最多 maxChars 个字符，相邻两块重叠 overlap 个字符 */
export function splitLong(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  const step = Math.max(1, maxChars - overlap);
  for (let start = 0; start < text.length; start += step) {
    pieces.push(text.slice(start, start + maxChars));
    if (start + maxChars >= text.length) break;
  }
  return pieces;
}

/** 一节切成几块：段落（空行分隔）尽量完整地放进同一块，放不下就开始新的一块；单个段落太长就硬切 */
export function splitSection(body: string, maxChars: number, overlap: number): string[] {
  // TODO 2（二）：按空行分出段落（去掉首尾空白，去掉空的段落），依次放进块里：
  // - 段落本身超过 maxChars：先把当前的块存起来，再用 splitLong 硬切这个段落，切出来的每一段各成一块
  // - 当前的块加上这个段落（中间空一行）不超过 maxChars：接在当前的块后面
  // - 否则：把当前的块存起来，这个段落开始新的一块
  // 最后别忘了把还没存的当前块存起来
  void overlap;
  return body.length <= maxChars ? [body] : splitLong(body, maxChars, 0);
}

/** 把一篇 Markdown 文档切成块 */
export function chunkMarkdown(markdown: string, path: string, options: ChunkOptions = {}): Chunk[] {
  const { maxChars = 800, overlap = 100 } = options;
  const chunks: Chunk[] = [];
  for (const section of splitSections(markdown)) {
    for (const text of splitSection(section.body, maxChars, overlap)) {
      chunks.push({ id: `${path}#${chunks.length}`, path, heading: section.heading, text });
    }
  }
  return chunks;
}

/**
 * 做 embedding 时用的文字：带上文档路径和标题。一块单独看可能不知道在说什么（「运行下面的命令」），
 * 加上「deploy.md · 部署 > 用 Docker 部署」，向量就能反映它真正的主题
 */
export function embeddingText(chunk: Chunk): string {
  return [chunk.path, chunk.heading].filter(Boolean).join(' · ') + `\n${chunk.text}`;
}
