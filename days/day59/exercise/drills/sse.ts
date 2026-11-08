// 第 59 天手写题二：SSE 解析器。网络上来的一块（chunk）可能在任何地方断开：一行的中间、\r\n 的中间、一个中文字的中间（这里收到的已经是字符串）。
// 第 59 天的练习：TODO 2 在这里，15 分钟。不要看前面任何一天的代码，计时写。检查：npm run check 59
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
  // TODO 2：用一个 buffer 存还没处理完的文字，每次 push 以后按 \n 切出完整的行处理
  throw new Error('TODO 2：还没有实现 createSSEParser');
}
