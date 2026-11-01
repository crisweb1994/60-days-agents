// mini-agent 的全部工具。
import type { Tool } from '../tool.ts';
import { calculator } from './calculator.ts';
import { createFileTools } from './files.ts';
import { httpRequest } from './http.ts';

/** 创建所有工具。读写文件的工具限制在 workspace 目录里 */
export function createTools(workspace: string): Tool[] {
  return [calculator, ...createFileTools(workspace), httpRequest];
}
