// 第 59 天手写题二：SSE 解析器。网络上来的一块（chunk）可能在任何地方断开：一行的中间、\r\n 的中间、一个中文字的中间（这里收到的已经是字符串）。
export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * 增量的 SSE 解析器。push(一块文字) 返回这一块凑出的完整事件：
 * - 按行处理，行尾可以是 \n 或 \r\n；最后一段没有换行的留到下一块
 * - 空行表示一个事件结束：有 data 才交出去（多行 data 用 \n 连起来）
 * - 「data: xxx」「data:xxx」都行（冒号后面最多去掉一个空格）；「event: 名字」记下事件名；冒号开头的是注释，跳过；别的字段忽略
 */
export function createSSEParser(): { push(chunk: string): SSEEvent[] } {
  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  return {
    push(chunk) {
      buffer += chunk;
      const out: SSEEvent[] = [];
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length) out.push({ ...(event ? { event } : {}), data: data.join('\n') });
          data = [];
          event = undefined;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
      }
      return out;
    },
  };
}
