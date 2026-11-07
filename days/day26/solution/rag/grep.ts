// 第 18 天：grep 式搜索。像程序员用 grep 那样，在文件里逐行找一个字符串或者正则表达式。
// 没有索引，不用 embedding，结果完全精确。找错误码、函数名、配置项，它比任何检索都准；
// 代码库和结构清楚的文档里，Agent 用 grep 加读文件，常常比向量检索还好用。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listDocs } from './indexer.ts';

export interface GrepMatch {
  path: string;
  /** 从 1 开始的行号 */
  line: number;
  text: string;
}

export interface GrepOptions {
  /** 把 pattern 当作正则表达式，默认当作普通字符串 */
  regex?: boolean;
  /** 只在这个前缀的路径里找，比如 ops/ */
  pathPrefix?: string;
  /** 最多返回几条，默认 30 */
  maxMatches?: number;
}

/** 在文档目录里逐行查找，不区分大小写 */
export async function grepDocs(root: string, pattern: string, options: GrepOptions = {}): Promise<GrepMatch[]> {
  const { regex = false, pathPrefix = '', maxMatches = 30 } = options;
  let re: RegExp;
  try {
    re = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch (error) {
    throw new Error(`正则表达式写错了：${(error as Error).message}。不需要正则时，把 regex 设成 false`);
  }
  const matches: GrepMatch[] = [];
  for (const path of await listDocs(root)) {
    if (!path.startsWith(pathPrefix)) continue;
    const lines = (await readFile(join(root, path), 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      matches.push({ path, line: i + 1, text: lines[i].trim().slice(0, 300) });
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}
