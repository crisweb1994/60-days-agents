// 第 47 天：解析 PDF。PDF 不是「一篇文字」，是一页页摆好位置的字形：同一行的字可能分成好几段，表格只是对齐的文字，
// 扫描件里根本没有文字，只有图片。所以：
//   按页取文字（unpdf，基于 pdf.js），每一页单独切块，块上记着页码：回答引用时能精确到「第几页」
//   整理文字：去掉行尾连字符、合并多余的空白；看起来像表格的行（用 | 或者多个空格分隔的列）原样保留，不要把列打散
//   几乎没有文字的页，多半是扫描件，标出来（要 OCR 或者交给视觉模型）
import { extractText, getDocumentProxy } from 'unpdf';
import type { Chunk } from './rag/chunk.ts';

/** 按页取出文字，第 i 项是第 i + 1 页 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

/** 一行是不是表格的一行：有两个以上的 |，或者有两处以上连续的两个空格（对齐的列） */
export function isTableRow(line: string): boolean {
  return (line.match(/\|/g)?.length ?? 0) >= 2 || (line.trim().match(/\S\s{2,}\S/g)?.length ?? 0) >= 2;
}

/**
 * 整理一页的文字：
 * - 行尾的「单词-」和下一行接起来（英文断词）
 * - 表格的行原样保留（只去掉行尾空白）
 * - 其他行：连续的空白合成一个空格
 * - 去掉空行连成的大段空白：最多保留一个空行
 */
export function normalizePageText(text: string): string {
  const joined = text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');
  const lines = joined.split('\n').map((line) => (isTableRow(line) ? line.trimEnd() : line.replace(/\s+/g, ' ').trim()));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 第几页在来源里显示成什么：文件名加「（第 N 页）」。它就是块的 path，第 18 天的 search_docs 用它登记来源 */
export const pagePath = (fileName: string, page: number) => `${fileName}（第 ${page} 页）`;

/** 文字少于这么多个字的页，当作没有文字（扫描件、只有图） */
export const MIN_PAGE_CHARS = 20;

export interface PdfChunkResult {
  chunks: Chunk[];
  /** 几乎没有文字的页码（从 1 开始） */
  emptyPages: number[];
}

/**
 * 每一页切成块：先 normalizePageText，再按段落（空行）攒到 maxChars 左右切一块；一段本身超过 maxChars 就硬切。
 * 表格的连续几行算一段，不在中间切开（除非它自己就超过 maxChars）。
 * 块的 id 是「文件名#p页码-序号」，path 是 pagePath，heading 是「第 N 页」
 */
export function pdfToChunks(fileName: string, pages: string[], { maxChars = 800 }: { maxChars?: number } = {}): PdfChunkResult {
  const chunks: Chunk[] = [];
  const emptyPages: number[] = [];
  pages.forEach((raw, index) => {
    const page = index + 1;
    const text = normalizePageText(raw);
    if (text.replace(/\s/g, '').length < MIN_PAGE_CHARS) {
      emptyPages.push(page);
      return;
    }
    const pieces: string[] = [];
    let current = '';
    const flush = () => {
      if (current.trim()) pieces.push(current.trim());
      current = '';
    };
    for (const paragraph of groupParagraphs(text)) {
      if (paragraph.length > maxChars) {
        flush();
        for (let i = 0; i < paragraph.length; i += maxChars) pieces.push(paragraph.slice(i, i + maxChars));
        continue;
      }
      if (current && current.length + paragraph.length + 2 > maxChars) flush();
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    flush();
    pieces.forEach((piece, i) => chunks.push({ id: `${fileName}#p${page}-${i + 1}`, path: pagePath(fileName, page), heading: `第 ${page} 页`, text: piece }));
  });
  return { chunks, emptyPages };
}

/** 按空行分段；连续的表格行合成一段，前后的普通行各自成段 */
function groupParagraphs(text: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  let table = false;
  const push = () => {
    if (buffer.length) out.push(buffer.join('\n'));
    buffer = [];
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      push();
      table = false;
      continue;
    }
    const isTable = isTableRow(line);
    if (buffer.length && isTable !== table) push();
    table = isTable;
    buffer.push(line);
  }
  push();
  return out;
}
