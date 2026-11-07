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
    // GET 只是读取；POST 可能改变对方的数据，也可能把数据发出去，执行之前要用户同意
    requiresApproval: (input) => input.method === 'POST',
    // POST 把数据发出去了，收不回来（第 29 天）
    risk: (input) => (input.method === 'POST' ? 'irreversible' : 'read'),
    schema: z.object({
      url: z.string().describe('完整的网址，以 http:// 或 https:// 开头'),
      method: z.enum(['GET', 'POST']).describe('请求方法'),
      body: z.string().nullable().describe('POST 请求的请求体，比如一段 JSON；GET 请求填 null'),
    }),
    async execute({ url, method, body }, { signal }) {
      const { protocol } = new URL(url); // 网址格式不对时会抛出错误
      if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`只支持 http 和 https，不支持 ${protocol}`);
      // 超时和用户取消，哪个先发生都停下
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        method,
        body: method === 'POST' ? (body ?? '') : undefined,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch((error: Error) => {
        if (timeout.aborted) throw new Error(`请求超时（${timeoutMs / 1000} 秒）：${url}`);
        throw error;
      });
      // 状态码不是 2xx 也照样返回：404、500 本身就是模型需要知道的信息
      return `HTTP ${res.status}\n${truncate(await res.text(), maxChars)}`;
    },
  });
}

export const httpRequest = createHttpTool();
