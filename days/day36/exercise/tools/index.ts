// mini-agent 的全部工具。
import type { SearchProvider } from '../search.ts';
import type { Tool } from '../tool.ts';
import { createWebTools, type FetchPageOptions, type SourceRegistry } from '../web.ts';
import { calculator } from './calculator.ts';
import { createFileTools } from './files.ts';
import { httpRequest } from './http.ts';

export interface ToolsOptions {
  /** 搜索服务。有它才有 web_search（第 12 天） */
  search?: SearchProvider;
  /** 登记搜到、读过的网页。有它才有 fetch_page 和 web_search（第 12 天） */
  sources?: SourceRegistry;
  /** fetch_page 的选项，测试时用来允许访问本机（第 20 天） */
  fetchOptions?: Omit<FetchPageOptions, 'signal'>;
  /** fetch_page 每页多少个字符，默认 4000。调小能省输入 token，代价是要多翻页（第 36 天） */
  pageSize?: number;
}

/** 创建所有工具。读写文件的工具限制在 workspace 目录里 */
export function createTools(workspace: string, options: ToolsOptions = {}): Tool[] {
  const web = options.sources ? createWebTools({ search: options.search, sources: options.sources, fetchOptions: options.fetchOptions, pageSize: options.pageSize }) : [];
  return [calculator, ...createFileTools(workspace), httpRequest, ...web];
}
