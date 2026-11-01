// 读文件和写文件。所有路径都限制在工作目录里面，模型不能读写工作目录以外的文件。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, truncate, type Tool } from '../tool.ts';

/** read_file 最多返回多少个字符 */
export const MAX_READ_CHARS = 20_000;

/** 把模型给的路径解析成工作目录里的绝对路径。跑到工作目录外面就报错 */
export function resolveInside(root: string, path: string): string {
  // TODO 4（上）：现在模型给什么路径就用什么路径，../../ 或者 /etc/passwd 都能读到。
  // 用 resolve(root, path) 得到绝对路径后，再用 relative(root, 绝对路径) 算出它相对于 root 的路径：
  // 如果是 '..'、以 '../'（Windows 上是 '..\\'）开头，或者是绝对路径（isAbsolute），说明跑到了工作目录外面，
  // 抛出错误，错误信息里要有「工作目录」四个字，告诉模型要用相对于工作目录的路径
  return resolve(root, path);
}

/** 创建绑定在 root 目录上的 read_file 和 write_file */
export function createFileTools(root: string): Tool[] {
  const readFileTool = defineTool({
    name: 'read_file',
    description: '读取工作目录里的一个文本文件，返回文件内容。路径相对于工作目录',
    schema: z.object({ path: z.string().describe('文件路径，比如 notes/todo.md') }),
    async execute({ path }) {
      // TODO 4（下）：用 resolveInside 得到绝对路径，读出文件内容（utf8）。
      // - 文件不存在：抛出错误，错误信息里带上 path（可以先用 stat 判断，它在文件不存在时会抛错）
      // - 是个目录：抛出错误说明
      // - 内容太长：用 truncate(内容, MAX_READ_CHARS) 截断
      throw new Error('TODO 4：还没有实现 read_file');
    },
  });

  const writeFileTool = defineTool({
    name: 'write_file',
    description: '把内容写入工作目录里的一个文件。文件已存在会被覆盖，目录不存在会自动创建。路径相对于工作目录',
    schema: z.object({
      path: z.string().describe('文件路径，比如 notes/todo.md'),
      content: z.string().describe('要写入的完整内容'),
    }),
    async execute({ path, content }) {
      // TODO 5：用 resolveInside 得到绝对路径；目录不存在时先创建（mkdir 加上 recursive: true）；
      // 写入内容后，返回一句确认，带上 path，比如「已写入 notes/todo.md（12 字节）」
      throw new Error('TODO 5：还没有实现 write_file');
    },
  });

  return [readFileTool, writeFileTool];
}
