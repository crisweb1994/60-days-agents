// 第 53 天：读仓库。PR 是别人提交的代码，仓库里的一切都是不可信的输入：
//   路径可能是 ../../etc/passwd；文件可能是一个指向 ~/.ssh/id_rsa 的软链接（git 能提交软链接）；文件可能有几十 MB。
// 所以每次读都要：路径在仓库里（第 5 天的 resolveInside）、真实路径也在仓库里（跟着软链接走一遍）、限制大小和行数。
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 搜索时跳过的目录 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor']);
/** 比这个大的文件不读：多半是生成的，读了也塞不进上下文 */
export const MAX_FILE_BYTES = 256 * 1024;
/** read_file 一次最多返回几行 */
export const MAX_LINES = 200;

const outside = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

export interface FileSlice {
  path: string;
  start: number;
  end: number;
  total: number;
  /** 带行号的内容：「   12 | 代码」 */
  text: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface Repo {
  root: string;
  /**
   * 读一个文件的第 start 到 end 行（从 1 开始，含两端；默认从 1 开始读 MAX_LINES 行，最多也只读 MAX_LINES 行）
   */
  readLines(path: string, start?: number, end?: number): Promise<FileSlice>;
  /** 按文字搜索（不分大小写），返回文件、行号和那一行，按路径和行号排序，最多 limit 条 */
  search(query: string, limit?: number): Promise<SearchHit[]>;
  /** 仓库里的所有文件（跳过 SKIP_DIRS），相对路径，用 / 分隔，排好序 */
  listFiles(): Promise<string[]>;
}

export function createRepo(root: string): Repo {
  const base = resolve(root);
  let realBase: Promise<string> | undefined;

  /**
   * 把仓库里的相对路径变成真实的绝对路径（TODO 3）：
   * 1. resolve 以后，相对 base 的路径不能跑到外面（outside），否则抛错「路径 x 在仓库之外」
   * 2. 文件要存在（不存在抛错「仓库里没有 x」），用 realpath 跟着软链接走到底，真实路径相对 realpath(base) 也不能在外面，
   *    否则抛错「x 指向仓库之外」
   * 3. 是目录抛错「x 是目录，不是文件」；比 MAX_FILE_BYTES 大抛错「x 太大了（n 字节），不读」
   */
  async function locate(path: string): Promise<string> {
    const full = resolve(base, path);
    if (outside(relative(base, full))) throw new Error(`路径 ${path} 在仓库之外`);
    const info = await lstat(full).catch(() => undefined);
    if (!info) throw new Error(`仓库里没有 ${path}`);
    realBase ??= realpath(base);
    const real = await realpath(full);
    if (outside(relative(await realBase, real))) throw new Error(`${path} 指向仓库之外`);
    const target = await stat(real);
    if (target.isDirectory()) throw new Error(`${path} 是目录，不是文件`);
    if (target.size > MAX_FILE_BYTES) throw new Error(`${path} 太大了（${target.size} 字节），不读`);
    return real;
  }

  async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), `${prefix}${entry.name}/`, out);
      } else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  }

  return {
    root: base,
    async readLines(path, start = 1, end) {
      const lines = (await readFile(await locate(path), 'utf8')).split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      const total = lines.length;
      const from = Math.max(1, Math.floor(start));
      if (from > Math.max(total, 1)) throw new Error(`${path} 只有 ${total} 行，没有第 ${from} 行`);
      const to = Math.min(total, end === undefined ? from + MAX_LINES - 1 : Math.floor(end), from + MAX_LINES - 1);
      const width = String(to).length;
      const text = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(width)} | ${l}`)
        .join('\n');
      return { path, start: from, end: to, total, text };
    },
    async search(query, limit = 20) {
      const needle = query.toLowerCase();
      if (!needle.trim()) throw new Error('搜索的内容不能是空的');
      const hits: SearchHit[] = [];
      for (const path of await this.listFiles()) {
        let content: string;
        try {
          content = await readFile(await locate(path), 'utf8');
        } catch {
          continue; // 太大的、指向外面的，跳过
        }
        if (content.includes('\0')) continue; // 二进制
        content.split(/\r?\n/).forEach((text, i) => {
          if (text.toLowerCase().includes(needle)) hits.push({ path, line: i + 1, text: text.trim() });
        });
        if (hits.length >= limit) break;
      }
      return hits.slice(0, limit);
    },
    async listFiles() {
      const out: string[] = [];
      await walk(base, '', out);
      return out.sort();
    },
  };
}
