// 发 HTTP 请求。返回状态码和响应内容；内容太长就截断。
import { z } from 'zod';
import { defineTool, truncate } from '../tool.ts';

export interface HttpToolOptions {
  /** 超时时间，默认 10 秒 */
  timeoutMs?: number;
  /** 响应内容最多返回多少个字符，默认 8000 */
  maxChars?: number;
}

export function createHttpTool({ timeoutMs = 10_000, maxChars = 8000 }: HttpToolOptions = {}) {
  return defineTool({
    name: 'http_request',
    description: '发送一个 HTTP 请求，返回状态码和响应内容。用来调用网络接口或者获取网页的原始内容',
    schema: z.object({
      url: z.string().describe('完整的网址，以 http:// 或 https:// 开头'),
      method: z.enum(['GET', 'POST']).describe('请求方法'),
      body: z.string().nullable().describe('POST 请求的请求体，比如一段 JSON；GET 请求填 null'),
    }),
    async execute({ url, method, body }, { signal }) {
      // TODO 6：发出请求，返回「HTTP 状态码」加一个换行，再加上响应内容。
      // - 用 new URL(url) 取出 protocol，只允许 http: 和 https:，否则抛出错误
      // - 超时：AbortSignal.timeout(timeoutMs)。用户取消时 signal 也会触发，
      //   两个都要生效：AbortSignal.any([signal, 超时的 signal])（signal 可能是 undefined）
      // - 超时导致 fetch 失败时，抛出一个错误信息里有「超时」两个字的错误，方便模型理解
      // - POST 时带上 body（null 就发空字符串），Content-Type 设为 application/json
      // - 状态码不是 2xx 也照常返回，404、500 本身就是模型需要知道的信息
      // - 响应内容用 truncate(内容, maxChars) 截断
      throw new Error('TODO 6：还没有实现 http_request');
    },
  });
}

export const httpRequest = createHttpTool();
