// 第 53 天：解析 unified diff（git diff 的输出）。review-bot 的每个工具都建立在它上面：
//   列出改了哪些文件、把一个文件的改动连同新文件的行号交给模型、检查评论落的行在不在 diff 里（GitHub 只接受 diff 里的行）
// 格式：
//   diff --git a/路径 b/路径
//   new file mode 100644 / deleted file mode 100644 / rename from x / rename to y / Binary files … differ   （可能有）
//   --- a/路径（新文件是 /dev/null）
//   +++ b/路径（删掉的文件是 /dev/null）
//   @@ -旧的起始行,旧的行数 +新的起始行,新的行数 @@ 可选的函数名
//   空格开头是没变的行，+ 是加的，- 是删的，\ 开头的是「\ No newline at end of file」
export interface DiffLine {
  type: 'add' | 'del' | 'context';
  text: string;
  /** 在旧文件里是第几行（加的行没有） */
  oldLine?: number;
  /** 在新文件里是第几行（删的行没有） */
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** @@ … @@ 后面的那一段，一般是函数名，可能是空的 */
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** 新的路径；删掉的文件是旧的路径 */
  path: string;
  /** 改名时的旧路径 */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
/** 去掉 a/、b/ 前缀 */
const strip = (p: string) => p.replace(/^[ab]\//, '');

/**
 * 解析 diff（TODO 1）。规则：
 * - 每个文件从 diff --git a/x b/y 开始，路径先取 b/ 后面的；遇到 +++ 再用它（不是 /dev/null 时）
 * - new file mode → added；deleted file mode → deleted，路径用 --- 的（a/ 后面的）；rename from / rename to → renamed，记下 oldPath
 * - 以 Binary files 开头的行 → binary
 * - @@ 行开始一个 hunk：行数没写时是 1。之后按「还剩几行」读：空格开头是 context（新旧行号都加一），+ 是 add（新行号），- 是 del（旧行号）；
 *   有的工具会把只有一个空格的 context 行存成空行，所以 hunk 还没读完时，空行也当作 context（text 是空的）；
 *   \ 开头的跳过；新旧两边都读完了，这个 hunk 就结束
 * - additions、deletions 是加了几行、删了几行
 * 空的 diff 返回空数组。文本的换行可能是 \r\n
 */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split(/\r?\n/)) {
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('\\')) continue;
      const mark = line[0] ?? ' ';
      const body = line.slice(1);
      if (mark === '+') {
        hunk.lines.push({ type: 'add', text: body, newLine: newNo++ });
        newLeft--;
        file.additions++;
        continue;
      }
      if (mark === '-') {
        hunk.lines.push({ type: 'del', text: body, oldLine: oldNo++ });
        oldLeft--;
        file.deletions++;
        continue;
      }
      if (mark === ' ') {
        hunk.lines.push({ type: 'context', text: body, oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      // 不认识的行：这个 hunk 写的行数不对，提前结束，下面当作头部的行处理
      oldLeft = newLeft = 0;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { path: match ? match[2] : line.slice(11), status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      hunk = undefined;
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
    else if (line.startsWith('Binary files ')) file.binary = true;
    else if (line.startsWith('--- ')) {
      const old = line.slice(4).split('\t')[0];
      if (file.status === 'deleted' && old !== '/dev/null') file.path = strip(old);
    } else if (line.startsWith('+++ ')) {
      const next = line.slice(4).split('\t')[0];
      if (next !== '/dev/null') file.path = strip(next);
    } else {
      const match = HUNK.exec(line);
      if (!match) continue;
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        section: match[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
    }
  }
  return files;
}

/**
 * 能评论的行（TODO 2）：新文件里出现在 diff 里的行号，也就是 add 和 context 的 newLine。
 * GitHub 的行内评论只能落在这些行上，落在别处会被拒绝
 */
export function commentableLines(file: FileDiff): Set<number> {
  const lines = new Set<number>();
  for (const hunk of file.hunks) for (const l of hunk.lines) if (l.newLine !== undefined) lines.add(l.newLine);
  return lines;
}

/** 把一组行号写成区间：[1,2,3,5,7,8] → 「1–3、5、7–8」 */
export function formatRanges(lines: Iterable<number>): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return parts.join('、');
}

const STATUS_LABEL = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名' } as const;

/** 一个文件的概况：「src/x.ts（新增，+8 −0）」，改名的加上「，原来是 y」 */
export function describeFile(file: FileDiff): string {
  const renamed = file.oldPath ? `，原来是 ${file.oldPath}` : '';
  return `${file.path}（${STATUS_LABEL[file.status]}${renamed}，${file.binary ? '二进制文件' : `+${file.additions} −${file.deletions}`}）`;
}

/**
 * 给模型看的 diff（TODO 2）：第一行是 describeFile，之后每个 hunk 先写一行 @@ 头（原样还原，section 有就加在后面），
 * 再逐行写成「新行号（右对齐，5 位）+ 空格 + 标记（+、-、空格）+ 原文」；删的行没有新行号，写 5 个空格。
 * 模型看着这个行号评论，和 commentableLines 对得上
 */
export function renderFileDiff(file: FileDiff): string {
  const out = [describeFile(file)];
  for (const h of file.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ''}`);
    for (const l of h.lines) {
      const no = l.newLine === undefined ? '' : String(l.newLine);
      const mark = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      out.push(`${no.padStart(5)} ${mark}${l.text}`);
    }
  }
  return out.join('\n');
}

/** 生成的文件、依赖锁、构建产物：不审，也不花模型的钱 */
const GENERATED = [/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$/, /(^|\/)(dist|build|vendor|node_modules)\//, /\.min\.(js|css)$/, /\.map$/, /\.snap$/];

export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

/** 要审的文件：不是删掉的、不是二进制、不是生成的 */
export function reviewableFiles(files: FileDiff[]): { review: FileDiff[]; skipped: FileDiff[] } {
  const review: FileDiff[] = [];
  const skipped: FileDiff[] = [];
  for (const f of files) (f.status === 'deleted' || f.binary || isGenerated(f.path) ? skipped : review).push(f);
  return { review, skipped };
}
