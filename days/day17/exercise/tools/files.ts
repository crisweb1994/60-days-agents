// 读文件和写文件。所有路径都限制在工作目录里面，模型不能读写工作目录以外的文件。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, truncate, type Tool } from '../tool.ts';

/** read_file 最多返回多少个字符 */
export const MAX_READ_CHARS = 20_000;

/** 把模型给的路径解析成工作目录里的绝对路径。跑到工作目录外面就报错 */
export function resolveInside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  // relative 算出的路径以 .. 开头，或者是绝对路径（Windows 上不同的盘），都说明在工作目录外面
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`路径 ${path} 在工作目录之外，不能访问。请使用相对于工作目录的路径`);
  }
  return full;
}

/** 创建绑定在 root 目录上的 read_file 和 write_file */
export function createFileTools(root: string): Tool[] {
  const readFileTool = defineTool({
    name: 'read_file',
    description: '读取工作目录里的一个文本文件，返回文件内容。路径相对于工作目录',
    schema: z.object({ path: z.string().describe('文件路径，比如 notes/todo.md') }),
    async execute({ path }) {
      const full = resolveInside(root, path);
      const info = await stat(full).catch(() => undefined);
      if (!info) throw new Error(`文件不存在：${path}`);
      if (info.isDirectory()) throw new Error(`${path} 是一个目录，不是文件`);
      return truncate(await readFile(full, 'utf8'), MAX_READ_CHARS);
    },
  });

  const writeFileTool = defineTool({
    name: 'write_file',
    description: '把内容写入工作目录里的一个文件。文件已存在会被覆盖，目录不存在会自动创建。路径相对于工作目录',
    // 会覆盖已有的文件，执行之前要用户同意
    requiresApproval: true,
    schema: z.object({
      path: z.string().describe('文件路径，比如 notes/todo.md'),
      content: z.string().describe('要写入的完整内容'),
    }),
    async execute({ path, content }) {
      const full = resolveInside(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
      return `已写入 ${path}（${Buffer.byteLength(content)} 字节）`;
    },
  });

  return [readFileTool, writeFileTool];
}
