// 解析 SSE（Server-Sent Events）：把服务器推过来的字节流，切成一个个事件。

export interface SSEEvent {
  /** event: 字段。OpenAI 兼容接口不用它，第 8 天的 Anthropic 协议靠它区分事件类型 */
  event?: string;
  /** data: 字段。一个事件有多行 data 时，用换行连起来 */
  data: string;
}

/**
 * 逐个交出事件。事件之间用空行分隔，但网络传输不会按事件切块：
 * 一个事件可能被拆进好几块，一块里也可能有好几个事件，甚至一个汉字的几个字节都会被拆开
 */
export async function* parseSSE(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SSEEvent> {
  // TODO 1：把字节流切成一个个事件，每凑齐一个就 yield 出去。
  // - for await 逐块读取 stream。用一个 TextDecoder 解码，记得传 { stream: true }：
  //   一个汉字占 3 个字节，可能被拆在两块里
  // - 解码出的文字先接到 buffer 后面，再按换行（\n 或 \r\n）切成行。
  //   最后一段可能是半行，留在 buffer 里等下一块
  // - 逐行处理：
  //   - 以 data: 开头：去掉字段名（fieldValue 帮你去掉字段名和后面的一个空格），记下来
  //   - 以 event: 开头：记下事件名
  //   - 空行：一个事件结束。记下了 data 就 yield { event, data }，多行 data 用 \n 连起来；然后清空，准备下一个事件
  //   - 其他的（以冒号开头的注释、id:、retry:）都忽略
  // - 流结束后，如果还有没交出去的 data（最后一个事件后面没有空行），也 yield 出去
  throw new Error('TODO 1：还没有实现 SSE 解析');
}

/** 去掉字段名，以及冒号后面的一个空格 */
function fieldValue(line: string, field: string): string {
  const value = line.slice(field.length);
  return value.startsWith(' ') ? value.slice(1) : value;
}
